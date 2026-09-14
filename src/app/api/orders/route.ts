import { NextResponse } from "next/server";
import { attachGuestOrdersToUser, createOrder, createNotification, getAllSettings, getCorporateAccountByUserId, getOrderById, ordersForUser, provisionUserLogin, subscribeNewsletter, adjustProductStock } from "@/lib/db";
import { invalidateCatalogCache, liveCatalog } from "@/lib/catalog";
import { getSessionUser } from "@/lib/api-helpers";
import { liveGetProduct } from "@/lib/catalog";
import { bulkUnitPrice, formatKES } from "@/lib/utils";
import { buildInvoicePdf } from "@/lib/invoice-pdf";
import { sendOrderInvoiceEmail, sendNewOrderAlert } from "@/lib/mailer";

import { randomBytes } from "crypto";
import { rateLimit, tooMany } from "@/lib/rate-limit";

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  try {
    const catalog = await liveCatalog().catch(() => [] as Awaited<ReturnType<typeof liveCatalog>>);
    const byId = new Map(catalog.map((p) => [p.id, p] as const));
    const enrich = async (o: Awaited<ReturnType<typeof ordersForUser>>[number]) => ({
      ...o,
      items: JSON.parse(o.items).map((i: { productId: string; qty: number; name?: string; price?: number }) => {
        const p = byId.get(i.productId);
        return {
          ...i,
          name: i.name || (p?.name ?? i.productId),
          sku: p?.sku,
          price: typeof i.price === "number" && i.price > 0 ? i.price : p ? bulkUnitPrice(p, i.qty) : undefined,
          datasheetIndex: p?.downloads?.findIndex((d) => /datasheet/i.test(d.name || "")),
        };
      }),
    });
    const id = new URL(req.url).searchParams.get("id");
    if (id) {
      const order = await getOrderById(id).catch(() => undefined);
      if (!order || order.user_id !== user.id) return NextResponse.json({ error: "Order not found" }, { status: 404 });
      return NextResponse.json({ order: await enrich(order) });
    }
    const rawOrders = await ordersForUser(user.id).catch(() => [] as Awaited<ReturnType<typeof ordersForUser>>);
    const orders = await Promise.all(rawOrders.map(enrich));
    return NextResponse.json({ orders }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[api/orders] GET error:", (err as Error).message);
    return NextResponse.json({ orders: [] }, { headers: { "Cache-Control": "no-store" } });
  }
}

type OrderItem = { productId: string; qty: number; price?: number };

async function computeTotals(items: OrderItem[], found?: (Awaited<ReturnType<typeof liveGetProduct>> )[]) {
  let subtotal = 0;
  let discount = 0;
  let catalogMap: Map<string, NonNullable<Awaited<ReturnType<typeof liveGetProduct>>>> | null = null;
  if (!found) {
    const catalog = await liveCatalog();
    catalogMap = new Map(catalog.map((p) => [p.id, p] as const));
  }
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const qty = typeof item.qty === "number" && item.qty > 0 ? Math.floor(item.qty) : 0;
    if (qty === 0) continue;
    const p = found ? found[idx] : catalogMap!.get(item.productId) ?? null;
    if (!p) continue;
    const unit = bulkUnitPrice(p, qty);
    const old = p.oldPrice != null && p.oldPrice > p.price ? p.oldPrice : p.price;
    subtotal += unit * qty;
    discount += (old - unit) * qty;
  }
  // Delivery fee + free-shipping threshold come from admin settings (defaults
  // keep legacy behaviour when unset).
  const s = await getAllSettings();
  const fee = Math.max(0, Number(s.delivery_fee) || 0);
  const threshold = Math.max(0, Number(s.free_delivery_threshold) || 0);
  const freeShipping = threshold > 0 && subtotal >= threshold;
  const shipping = items.length === 0 || subtotal <= 0 || freeShipping ? 0 : fee;
  discount = Math.max(0, Math.round(discount));
  return { subtotal: Math.round(subtotal), discount, shipping, total: Math.round(subtotal) + shipping };
}

export async function POST(req: Request) {
  const rl = rateLimit(req, "orders", 10, 600000);
  if (!rl.ok) return tooMany(rl.retryAfter);

  let body: { name?: string; email?: string; phone?: string; address?: string; items?: unknown[]; total?: number; payment?: string; po_ref?: string; company?: string; po_file?: string; momo?: string; delivery_fee?: boolean; marketing_opt_in?: boolean; guest_password?: string; referral_code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body.name || !body.email || !body.phone || !body.address || !Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: "Missing required order details" }, { status: 400 });
  }
  // Validate guest account password BEFORE creating the order — otherwise a 400
  // would leave an orphan order that the client thinks failed.
  const __guestPw = body.guest_password?.trim();
  if (__guestPw && __guestPw.length > 0 && __guestPw.length < 6) {
    return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });
  }

  // Re-derive every total from the live (admin-overridden) catalog so the
  // discount is always counted correctly and the stored total can't be spoofed.
  const items = body.items as OrderItem[];
  const found = await Promise.all(items.map((i) => liveGetProduct(i.productId)));
  if (found.some((p) => !p)) {
    return NextResponse.json({ error: "One or more products could not be found" }, { status: 400 });
  }
  // Server-side quantity cap — prevent oversell races that the client might miss.
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx] as { productId: string; qty: number };
    const p = found[idx];
    if (!p) continue;
    const qty = Math.floor(Number(it.qty) || 0);
    if (qty <= 0) {
      return NextResponse.json({ error: `Quantity must be at least 1 for ${p.name}` }, { status: 400 });
    }
    if (qty > p.stock) {
      return NextResponse.json(
        {
          error: `Only ${p.stock} unit${p.stock === 1 ? "" : "s"} available for ${p.name} (you requested ${qty}). Please reduce quantity or contact us for backorder.`,
        },
        { status: 409 }
      );
    }
  }
  const totals = await computeTotals(items, found);
  // Snapshot what each unit actually cost AT PURCHASE TIME (incl. bulk tier)
  // into the stored line items. Invoices/receipts/order history render from
  // these frozen prices — later admin price edits must never rewrite history.
  // Client-supplied prices are ignored for the same reason totals are.
  const pricedItems = items.map((i, idx) => {
    const qty = typeof i.qty === "number" && i.qty > 0 ? Math.floor(i.qty) : 0;
    const p = found[idx];
    return {
      productId: i.productId,
      name: p?.name ?? i.productId,
      qty,
      price: p ? bulkUnitPrice(p, qty) : 0,
    };
  });
  const subtotal = totals.subtotal;
  let discount = totals.discount;
  let shipping = totals.shipping;
  let total = totals.total;

  // Staff (admin/superadmin) may waive the delivery fee when checking out —
  // e.g. when placing an order for a customer who picks up or has an account
  // rate. The waiver is only honoured for authenticated staff, never for the
  // public.
  const user = await getSessionUser();
  if (user && ["admin", "superadmin"].includes(user.role) && body.delivery_fee === false) {
    shipping = 0;
    total = subtotal;
  }

  // Corporate discount: if the signed-in user has an active corporate account,
  // apply its discount_rate to the subtotal (stacks with bulk pricing).
  if (user?.id) {
    try {
      const corp = await getCorporateAccountByUserId(user.id);
      if (corp && corp.status === "Active" && corp.discount_rate > 0) {
        const rate = Math.max(0, Math.min(100, corp.discount_rate));
        const corpDiscount = Math.round((subtotal * rate) / 100);
        discount += corpDiscount;
        total = Math.max(0, subtotal - corpDiscount + shipping);
        // Keep subtotal as pre-corp total for display; discount captures corp savings.
      }
    } catch {}
  }

  const order = await createOrder({
    user_id: user?.id ?? null,
    name: body.name,
    email: body.email,
    phone: body.phone,
    address: body.address,
    items: JSON.stringify(pricedItems),
    total,
    subtotal,
    discount,
    shipping,
    payment: body.payment ?? "mpesa",
    po_ref: body.po_ref,
    company: body.company,
    po_file: body.po_file,
    // The M-Pesa number the STK push is sent to — may differ from the delivery phone.
    payment_phone: body.payment === "mpesa" ? body.momo : null,
    referrer_code: body.referral_code?.trim() || null,
    // One-time token returned to the client so it can start the payment and
    // check its status without needing a login (works for guest checkout too).
    payment_token: randomBytes(24).toString("hex"),
  });

  // Reserve inventory at order placement: decrement stock / increment sold
  // per line. Stock floors at 0 (business prefers taking the order over
  // rejecting it when two buyers race); admin restocks on cancellation.
  // Failures are logged inside adjustProductStock and never fail the order.
  // NOTE: admin_products rows are keyed by REAL SKU, not cart productId (which
  // is "p-001"-style for seed products and "custom-<sku>" for custom ones), so
  // resolve the SKU from the live catalog before adjusting.
  await adjustProductStock(
    pricedItems.map((i, idx) => ({
      sku: found[idx]?.sku ?? i.productId,
      qty: i.qty,
      fallbackStock: found[idx]?.stock ?? 0,
      fallbackSold: found[idx]?.sold ?? 0,
      isSeed: Boolean(found[idx]?.id && !String(found[idx]?.id).startsWith("custom-")),
    }))
  );
  invalidateCatalogCache();

  // Guest checkout extras — only for customers without an account:
  // 1. "Create an account" with a chosen password: provision the login and
  //    attach ALL previous guest orders (same email) so history is never lost.
  // 2. Marketing consent: add to the newsletter subscribers list.
  if (!user) {
    const guestPassword = body.guest_password?.trim();
    if (guestPassword) {
      // Length was already validated before order creation; invalid values here
      // are silently ignored so no orphan order is left behind.
      if (guestPassword.length < 6) {
        console.warn(`[orders] guest password too short for ${order.id} — skipping account creation`);
      } else {
        try {
          const provision = await provisionUserLogin({
            name: body.name,
            email: body.email,
            phone: body.phone,
            company: body.company?.trim() || null,
            password: guestPassword,
          });
          await attachGuestOrdersToUser(provision.user_id, body.email);
        } catch (err) {
          console.error(`[orders] guest account creation failed for ${order.id}:`, (err as Error).message);
        }
      }
    }
    if (body.marketing_opt_in) {
      try {
        await subscribeNewsletter({ email: body.email, name: body.name });
      } catch (err) {
        console.error(`[orders] newsletter subscribe failed for ${order.id}:`, (err as Error).message);
      }
    }
  }

  if (user) {
    await createNotification({
      user_id: user.id,
      type: "order",
      title: `Order ${order.id} confirmed`,
      message: `Your order of ${formatKES(total)} is being prepared.`,
      link: "/account/orders",
    });
  }

  // Email the invoice PDF to the customer. Best-effort: never fail the order
  // placement when SMTP is unavailable or the mail host rejects the message —
  // but DO log the reason so missing invoices are diagnosable. AWAITED so the
  // SMTP send completes before the serverless function returns (un-awaited
  // sends are frozen mid-flight on Vercel).
  if (order.email) {
    try {
      const pdf = await buildInvoicePdf(order);
      await sendOrderInvoiceEmail({
        to: order.email,
        orderId: order.id,
        orderTotal: order.total,
        pdf,
        name: order.name,
        phone: order.phone,
        address: order.address,
        company: order.company,
        items: order.items,
        payment: order.payment,
        paid: order.paid,
        status: order.status,
        created_at: order.created_at,
        payment_token: order.payment_token,
      });
    } catch (err) {
      console.error(`invoice email failed for ${order.id}:`, (err as Error).message);
    }
  }

  // Notify staff of the new order (sends to the "email" and "purchases_email"
  // settings; silently skipped when SMTP is not configured). Awaited so the
  // alerts actually leave the serverless function.
  try {
    const s = await getAllSettings();
    const alert = { orderId: order.id, orderTotal: order.total, customer: order.name, company: order.company, payment: order.payment };
    const targets = [s.email, s.purchases_email].filter(Boolean);
    for (const t of targets) {
      try {
        await sendNewOrderAlert({ to: t as string, ...alert });
      } catch {
        /* per-recipient failure is not fatal */
      }
    }
  } catch {
    /* settings lookup failure is not fatal */
  }

  return NextResponse.json({ order: { ...order, items: JSON.parse(order.items) } }, { status: 201 });
}

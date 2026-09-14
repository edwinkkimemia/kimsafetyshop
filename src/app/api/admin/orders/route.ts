import { NextResponse } from "next/server";
import { getSessionUser, requireAdmin } from "@/lib/api-helpers";
import {
  createNotification,
  getOrderById,
  getUserById,
  listOrders,
  listUsers,
  restoreProductStock,
  setMpesaTransaction,
  setOrderDelivered,
  setOrderPaid,
  setOrderStatus,
  setPaystackTransaction,
} from "@/lib/db";
import { invalidateCatalogCache, liveGetProduct } from "@/lib/catalog";
import { productImages } from "@/lib/data/product-images";
import { bulkUnitPrice } from "@/lib/utils";
import { mpesaFetchReceipt } from "@/lib/payments/mpesa";
import { getStoredFile } from "@/lib/file-store";
import { sendDeliveryNoteEmail, sendOrderStatusEmail, sendPaidInvoiceEmail } from "@/lib/mailer";
import path from "path";

const VALID = ["Processing", "In transit", "Delivered", "Cancelled"];

async function withItems(o: Awaited<ReturnType<typeof listOrders>>[number]) {
  const items = JSON.parse(o.items) as { productId: string; qty: number; name?: string; price?: number }[];
  return {
    ...o,
    // Admin views show what the customer paid: the stored per-item price wins,
    // live lookup only fills gaps for legacy orders saved without prices.
    items: await Promise.all(
      items.map(async (i) => {
        const p = await liveGetProduct(i.productId);
        const price = typeof i.price === "number" && i.price > 0 ? i.price : p ? bulkUnitPrice(p, i.qty) : (i.price ?? 0);
        return {
          ...i,
          name: i.name || ((p?.name ?? i.name) ?? i.productId),
          sku: p?.sku ?? i.productId,
          price,
          image: p?.image ?? (p?.sku ? productImages[p.sku] : undefined) ?? null,
        };
      })
    ),
  };
}

export async function GET(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (id) {
      const order = await getOrderById(id).catch(() => undefined);
      if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
      return NextResponse.json({ order: await withItems(order) });
    }

    const userId = searchParams.get("userId");
    if (userId) {
      let targetUser: Awaited<ReturnType<typeof getUserById>> | undefined;
      try {
        targetUser = await getUserById(userId);
      } catch {}
      if (!targetUser) {
        try {
          const allUsers = await listUsers().catch(() => [] as Awaited<ReturnType<typeof listUsers>>);
          const lower = userId.toLowerCase();
          const found = allUsers.find((u) => u.id === userId) ?? allUsers.find((u) => u.referral_code?.toLowerCase() === lower) ?? allUsers.find((u) => u.id.toLowerCase().startsWith(lower));
          if (found) targetUser = await getUserById(found.id).catch(() => undefined);
        } catch {}
      }
      if (!targetUser) return NextResponse.json({ error: "User not found" }, { status: 404 });
      const all = await listOrders().catch(() => [] as Awaited<ReturnType<typeof listOrders>>);
      const emailLower = targetUser.email.toLowerCase();
      const realId = targetUser.id;
      const filtered = all.filter(
        (o) => o.user_id === realId || (!o.user_id && o.email.toLowerCase() === emailLower) || o.email.toLowerCase() === emailLower
      );
      // Limit enrichment to avoid N-catalog fetches under 53300; withItems uses liveCatalog inflight dedupe but still heavy.
      const slice = filtered.slice(0, 100);
      const orders = await Promise.all(slice.map(withItems));
      return NextResponse.json({ orders, user: { id: targetUser.id, name: targetUser.name, email: targetUser.email } });
    }

    // Full orders table scan — cap to recent 100 to bound DB + catalog pressure under burst.
    const all = await listOrders().catch(() => [] as Awaited<ReturnType<typeof listOrders>>);
    const recent = all.slice(0, 100);
    const orders = await Promise.all(recent.map(withItems));
    return NextResponse.json({ orders });
  } catch (err) {
    console.error("[admin/orders] GET error:", (err as Error).message);
    return NextResponse.json({ orders: [] });
  }
}

export async function PATCH(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const me = await getSessionUser();
  let body: { id?: string; status?: string; paid?: number; txn_ref?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "Missing order id" }, { status: 400 });
  const order = await getOrderById(body.id);
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  // ---- Status update (fulfilment) — handled first so it doesn't get swallowed
  // by the reference-only branch. Delivered requires a signed delivery note.
  if (body.status !== undefined) {
    if (!VALID.includes(body.status ?? "")) {
      return NextResponse.json({ error: "Invalid order id or status" }, { status: 400 });
    }
    if (body.status === "Delivered") {
      if (!order.delivery_note_file) {
        return NextResponse.json(
          { error: "Upload the signed delivery note (PDF or image) before marking as Delivered." },
          { status: 400 }
        );
      }
      // Record who delivered + when
      const deliverer = me?.name ?? me?.email ?? "Admin";
      const delivererId = me?.id ?? null;
      await setOrderDelivered(body.id, delivererId ?? deliverer, deliverer);
      if (order.user_id) {
        await createNotification({
          user_id: order.user_id,
          type: "order",
          title: `Order ${order.id} is now Delivered`,
          message: `Your order status changed to Delivered.`,
          link: "/account/orders",
        });
      }
      // Status email
      try {
        await sendOrderStatusEmail({
          to: order.email,
          name: order.name,
          orderId: order.id,
          status: "Delivered",
          orderTotal: order.total,
        });
      } catch (err) {
        console.error(`[admin] status email failed for ${order.id}:`, (err as Error).message);
      }
      // Auto-send the signed delivery note PDF to the customer
      try {
        const file = order.delivery_note_file ? path.basename(order.delivery_note_file) : null;
        const stored = file ? await getStoredFile(file) : null;
        if (stored?.data) {
          await sendDeliveryNoteEmail({
            to: order.email,
            name: order.name,
            orderId: order.id,
            pdf: stored.data,
          });
        } else if (order.delivery_note_file) {
          // Fallback: try reading from filesystem mirror
          try {
            const fs2 = await import("fs");
            const p = path.join(process.cwd(), "public", "uploads", "documents", file!);
            if (fs2.existsSync(p)) {
              const buf = fs2.readFileSync(p);
              await sendDeliveryNoteEmail({
                to: order.email,
                name: order.name,
                orderId: order.id,
                pdf: buf,
              });
            }
          } catch {}
        }
      } catch (err) {
        console.error(`[admin] delivery note email failed for ${order.id}:`, (err as Error).message);
      }
      return NextResponse.json({ ok: true });
    }
    const wasCancelled = order.status === "Cancelled";
    const willCancel = body.status === "Cancelled";
    await setOrderStatus(body.id, body.status as string);
    // Auto-restore inventory when an order transitions into Cancelled (once only).
    if (!wasCancelled && willCancel) {
      try {
        const rawItems = JSON.parse(order.items) as { productId: string; qty: number }[];
        const restores = await Promise.all(
          rawItems.map(async (i) => {
            const p = await liveGetProduct(i.productId);
            return {
              sku: p?.sku ?? i.productId,
              qty: Math.floor(Number(i.qty) || 0),
              fallbackStock: p?.stock ?? 0,
              fallbackSold: p?.sold ?? 0,
              isSeed: Boolean(p?.id && !String(p.id).startsWith("custom-")),
            };
          })
        );
        const valid = restores.filter((r) => r.sku && r.qty > 0);
        if (valid.length) {
          await restoreProductStock(valid);
          invalidateCatalogCache();
        }
      } catch (err) {
        console.error(`[admin] stock restore failed for cancelled order ${order.id}:`, (err as Error).message);
      }
    }
    if (order.user_id) {
      await createNotification({
        user_id: order.user_id,
        type: "order",
        title: `Order ${order.id} is now ${body.status}`,
        message: `Your order status changed to ${body.status}.`,
        link: "/account/orders",
      });
    }
    try {
      await sendOrderStatusEmail({
        to: order.email,
        name: order.name,
        orderId: order.id,
        status: body.status as string,
        orderTotal: order.total,
      });
    } catch (err) {
      console.error(`[admin] status email failed for ${order.id}:`, (err as Error).message);
    }
    return NextResponse.json({ ok: true });
  }

  // Reference-only update (add transaction ID without changing paid state).
  // For M-Pesa, once Daraja has delivered the receipt (mpesa_transaction_id set),
  // it cannot be edited — only manually-paid orders with no receipt may be set.
  if (body.paid === undefined && body.txn_ref !== undefined) {
    const ref = body.txn_ref?.trim();
    if (!ref) return NextResponse.json({ error: "Missing transaction reference" }, { status: 400 });
    if (order.payment === "mpesa") {
      if (order.mpesa_transaction_id) {
        return NextResponse.json(
          { error: "M-Pesa transaction code was auto-captured from Daraja and cannot be edited. Only manually-paid orders without a receipt can be set." },
          { status: 400 }
        );
      }
      await setMpesaTransaction(body.id, ref);
    } else if (order.payment === "card") {
      if (order.paystack_transaction_id) {
        return NextResponse.json(
          { error: "Paystack transaction ID was auto-captured and cannot be edited." },
          { status: 400 }
        );
      }
      await setPaystackTransaction(body.id, ref);
    } else return NextResponse.json({ error: "This payment method does not take a transaction reference" }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  if (body.paid !== undefined) {
    // Record the REAL payment reference BEFORE flagging paid and re-fetching —
    // the paid invoice PDF and receipt must show the real TB... / Paystack ID.
    // No fallback to checkout ID or initialization reference.
    const ref = body.txn_ref?.trim();
    let effectiveRef: string | null = ref || null;
    if (!effectiveRef) {
      if (order.payment === "mpesa") {
        // Admin left the reference blank: try to pull the real M-Pesa receipt
        // (e.g. TB17CVOCY9) from Daraja. If not available, require manual entry.
        if (order.mpesa_transaction_id) {
          effectiveRef = order.mpesa_transaction_id;
        } else if (order.mpesa_checkout_id) {
          try {
            const receipt = await mpesaFetchReceipt(order.mpesa_checkout_id);
            if (receipt) {
              await setMpesaTransaction(body.id, receipt);
              effectiveRef = receipt;
            }
          } catch (err) {
            console.error(`[admin] mpesa receipt lookup failed for ${order.id}:`, (err as Error).message);
          }
        }
      }
      // Card has no auto-fetch — must be entered
    }
    if (!effectiveRef) {
      if (order.payment === "mpesa") {
        return NextResponse.json(
          { error: "M-Pesa transaction code (e.g. TB17CVOCY9) is required — could not be fetched automatically. Enter it from the customer's confirmation SMS." },
          { status: 400 }
        );
      }
      if (order.payment === "card") {
        return NextResponse.json(
          { error: "Paystack transaction code is required — enter the Paystack transaction ID (e.g. from Paystack dashboard / verification)." },
          { status: 400 }
        );
      }
    }
    if (effectiveRef) {
      if (order.payment === "mpesa") await setMpesaTransaction(body.id, effectiveRef);
      else if (order.payment === "card") await setPaystackTransaction(body.id, effectiveRef);
    }
    await setOrderPaid(body.id, body.paid ? 1 : 0);
    if (order.paid !== 1 && body.paid) {
      // Only email on the unpaid → paid transition (re-marking a paid order
      // must not spam the customer with another invoice). Re-fetch the fresh
      // row (txn reference) and AWAIT the send — on Vercel serverless the
      // event loop freezes once this handler returns, so a fire-and-forget
      // SMTP send never completes.
      const fresh = (await getOrderById(body.id)) ?? order;
      try {
        await sendPaidInvoiceEmail(fresh);
      } catch (err) {
        console.error(`[admin] paid invoice email failed for ${order.id}:`, (err as Error).message);
      }
    }
    if (order.user_id && body.paid) {
      await createNotification({
        user_id: order.user_id,
        type: "order",
        title: `Payment confirmed for ${order.id}`,
        message: `We received your payment of ${order.total} — thank you!`,
        link: "/account/orders",
      });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Invalid request — provide status, paid, or txn_ref" }, { status: 400 });
}

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-helpers";
import { getOrderById, getUserById, listAllReturns, restoreProductStock, setReturnStatus } from "@/lib/db";
import { invalidateCatalogCache, liveGetProduct } from "@/lib/catalog";
import { sendReturnStatusEmail } from "@/lib/mailer";

const VALID = ["Requested", "Approved", "Rejected", "Picked up", "Refunded", "Closed"];

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const returns = await listAllReturns().catch(() => [] as Awaited<ReturnType<typeof listAllReturns>>);
    if (returns.length === 0) return NextResponse.json({ returns: [] });
    // N+1 storm: previously Promise.all per-return did getOrderById + getUserById
    // (2*N concurrent DB queries). Batch via single JOIN query instead of N fetches.
    // Fallback to per-row try/catch on 53300 so one failure doesn't abort all.
    let enriched: typeof returns;
    try {
      // Try batched enrichment with JOINs (1 query)
      const { qr } = await import("@/lib/db");
      const ids = returns.map((r) => r.order_id);
      if (ids.length > 0) {
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
        const rows = (await qr(
          `SELECT o.id AS oid, o.name AS oname, o.email AS oemail, o.user_id, u.name AS uname, u.email AS uemail
           FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id IN (${placeholders})`,
          ...ids
        ).catch(() => [])) as { oid: string; oname: string; oemail: string; user_id: string | null; uname: string | null; uemail: string | null }[];
        const m = new Map(rows.map((r) => [r.oid, r]));
        enriched = returns.map((r) => {
          const j = m.get(r.order_id);
          return {
            ...r,
            customer_name: (j?.uname ?? j?.oname ?? null) as string | null,
            customer_email: (j?.uemail ?? j?.oemail ?? null) as string | null,
          };
        }) as typeof returns;
      } else {
        enriched = returns.map((r) => ({ ...r, customer_name: null, customer_email: null })) as typeof returns;
      }
    } catch {
      // Fallback sequential with catch per item
      enriched = (await Promise.all(
        returns.map(async (r) => {
          try {
            const order = await getOrderById(r.order_id).catch(() => undefined);
            const account = order?.user_id ? await getUserById(order.user_id).catch(() => undefined) : undefined;
            return {
              ...r,
              customer_name: (account?.name ?? order?.name ?? null) as string | null,
              customer_email: (account?.email ?? order?.email ?? null) as string | null,
            };
          } catch {
            return { ...r, customer_name: null, customer_email: null } as typeof r & { customer_name: null; customer_email: null };
          }
        })
      )) as typeof returns;
    }
    return NextResponse.json({ returns: enriched });
  } catch (err) {
    console.error("[admin/returns] error:", (err as Error).message);
    return NextResponse.json({ returns: [] });
  }
}

export async function PATCH(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  let body: { id?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body.id || !VALID.includes(body.status ?? "")) {
    return NextResponse.json({ error: "Invalid return id or status" }, { status: 400 });
  }
  const ret = (await listAllReturns()).find((r) => r.id === body.id);
  if (!ret) return NextResponse.json({ error: "Return not found" }, { status: 404 });
  const prevStatus = ret.status;
  await setReturnStatus(body.id, body.status as string);
  // When a return is approved/picked up/refunded we re-stock the returned qty.
  // Only once per return — prevents double-restore if admin toggles status.
  const restockStatuses = new Set(["Approved", "Picked up", "Refunded"]);
  const shouldRestock = !restockStatuses.has(prevStatus) && restockStatuses.has(body.status as string);
  if (shouldRestock) {
    try {
      const qty = Math.floor(Number((ret as { qty?: unknown }).qty) || 0);
      if (qty > 0) {
        // Resolve SKU: try exact product name match, then order items fallback
        let sku: string | null = null;
        let product: Awaited<ReturnType<typeof liveGetProduct>> = undefined;
        // 1) Direct name match against live catalog (name is unique in seed)
        try {
          const { liveCatalog } = await import("@/lib/catalog");
          const catalog = await liveCatalog();
          const byName = catalog.find((p) => p.name === ret.product_name);
          if (byName) {
            sku = byName.sku;
            product = byName;
          }
        } catch {}
        // 2) Fallback: find in the order's items by product name
        if (!sku) {
          try {
            const order = await getOrderById(ret.order_id);
            if (order) {
              const items = JSON.parse(order.items) as { productId: string; name?: string; qty: number }[];
              const match = items.find((i) => i.name === ret.product_name);
              if (match) {
                const p = await liveGetProduct(match.productId);
                if (p) {
                  sku = p.sku;
                  product = p;
                } else {
                  sku = match.productId;
                }
              }
            }
          } catch {}
        }
        // 3) Last resort: product_name itself might be a SKU
        if (!sku) sku = ret.product_name;

        if (sku && qty > 0) {
          // For seed products we need fallbackStock/Sold to create override row
          const fallbackStock = product?.stock ?? 0;
          const fallbackSold = product?.sold ?? 0;
          const isSeed = Boolean(product?.id && !String(product.id).startsWith("custom-"));
          // If we couldn't resolve a product, assume seed so the override is created
          await restoreProductStock([
            { sku, qty, fallbackStock, fallbackSold, isSeed: isSeed || !product },
          ]);
          invalidateCatalogCache();
        }
      }
    } catch (err) {
      console.error(`[returns] stock restore failed for return ${ret.id}:`, (err as Error).message);
    }
  }

  // Email the customer when the return status changes — awaited so the SMTP
  // send completes before the serverless function returns.
  try {
    const order = await getOrderById(ret.order_id);
    const account = order?.user_id ? await getUserById(order.user_id) : undefined;
    const to = account?.email ?? order?.email ?? null;
    if (to) {
      await sendReturnStatusEmail({
        to,
        name: account?.name ?? order?.name ?? ret.product_name,
        returnId: ret.id,
        status: body.status as string,
      });
    }
  } catch (err) {
    console.error(`[returns] status email failed for ${ret.id}:`, (err as Error).message);
  }

  return NextResponse.json({ ok: true });
}
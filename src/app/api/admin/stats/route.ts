import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-helpers";
import { q1 } from "@/lib/db";
import { getCachedAdminRows } from "@/lib/catalog";
import { products } from "@/lib/data/products";

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  // Consolidated stats single row: was 5 concurrent q1 → 5 connections under burst.
  let totals: { s: number } | undefined;
  let pendingOrders: { c: number } | undefined;
  let customersCount: { c: number } | undefined;
  let ordersCount: { c: number } | undefined;
  let quotesCount: { c: number } | undefined;
  try {
    const row = await q1<{
      revenue: number;
      pending: number;
      users: number;
      orders: number;
      quotes: number;
    }>(
      `SELECT
        (SELECT COALESCE(SUM(total),0)::int FROM orders WHERE status != 'Cancelled' AND paid=1) AS revenue,
        (SELECT COUNT(*)::int FROM orders WHERE status IN ('Processing','In transit')) AS pending,
        (SELECT COUNT(*)::int FROM users WHERE role='user') AS users,
        (SELECT COUNT(*)::int FROM orders) AS orders,
        (SELECT COUNT(*)::int FROM quotes) AS quotes`
    );
    totals = { s: row?.revenue ?? 0 };
    pendingOrders = { c: row?.pending ?? 0 };
    customersCount = { c: row?.users ?? 0 };
    ordersCount = { c: row?.orders ?? 0 };
    quotesCount = { c: row?.quotes ?? 0 };
  } catch (e) {
    console.error("[stats] counts fallback:", (e as Error).message);
    totals = { s: 0 };
    pendingOrders = { c: 0 };
    customersCount = { c: 0 };
    ordersCount = { c: 0 };
    quotesCount = { c: 0 };
  }
  const adminRows = await getCachedAdminRows()
    .then((rows) => rows ?? [])
    .catch(() => [] as NonNullable<Awaited<ReturnType<typeof getCachedAdminRows>>>);
  const adminRowsSafe = (adminRows ?? []) as NonNullable<Awaited<ReturnType<typeof getCachedAdminRows>>>;
  const lowStock = adminRowsSafe.filter((p) => {
    const data = p.data as { stock?: number; lowStockAt?: number };
    return typeof data.stock === "number" && typeof data.lowStockAt === "number" && data.stock <= data.lowStockAt;
  });
  const lowStockStatic = products.filter((p) => p.stock <= p.lowStockAt).length;

  return NextResponse.json({
    stats: {
      revenue: totals?.s ?? 0,
      orders: ordersCount?.c ?? 0,
      pendingOrders: pendingOrders?.c ?? 0,
      users: customersCount?.c ?? 0,
      quotes: quotesCount?.c ?? 0,
      lowStock: lowStock.length + lowStockStatic,
      products: products.length + adminRowsSafe.filter((p) => !(p.data as { static?: boolean }).static).length,
    },
  });
}

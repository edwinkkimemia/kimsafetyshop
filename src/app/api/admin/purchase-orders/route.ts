import { NextResponse } from "next/server";
import { listPurchaseOrders, setPurchaseOrderStatus } from "@/lib/db";
import { requireAdmin } from "@/lib/api-helpers";

export const runtime = "nodejs";

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const purchaseOrders = await listPurchaseOrders().catch(() => [] as Awaited<ReturnType<typeof listPurchaseOrders>>);
    return NextResponse.json({ purchaseOrders });
  } catch (err) {
    console.error("[admin/purchase-orders] error:", (err as Error).message);
    return NextResponse.json({ purchaseOrders: [] });
  }
}

export async function PATCH(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const body = await req.json();
    const id = String(body.id ?? "");
    const status = String(body.status ?? "");
    if (!id || !status) return NextResponse.json({ error: "id and status are required" }, { status: 400 });
    await setPurchaseOrderStatus(id, status);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to update purchase order status:", err);
    return NextResponse.json({ error: "Failed to update status" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { requireAdmin, getSessionUser } from "@/lib/api-helpers";
import { createSupplierOrder, deleteSupplierOrder, getSupplierOrder, listSupplierOrders, setSupplierOrderStatus } from "@/lib/db";
import type { SupplierOrderItem } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const rows = await listSupplierOrders().catch(() => [] as Awaited<ReturnType<typeof listSupplierOrders>>);
    return NextResponse.json({ orders: rows.map((o) => ({ ...o, items: JSON.parse(o.items) })) });
  } catch (err) {
    console.error("[admin/supplier-orders] error:", (err as Error).message);
    return NextResponse.json({ orders: [] });
  }
}

export async function POST(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const me = await getSessionUser();

  let body: {
    supplier?: string;
    contact_name?: string;
    phone?: string;
    email?: string;
    items?: unknown[];
    shipping?: number;
    expected_date?: string;
    notes?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const supplier = String(body.supplier ?? "").trim();
  if (!supplier) return NextResponse.json({ error: "Supplier name is required" }, { status: 400 });

  const items = (body.items ?? [])
    .filter((i): i is SupplierOrderItem => Boolean(i) && typeof i === "object")
    .map((i) => ({
      name: String((i as { name?: unknown }).name ?? "").trim(),
      qty: Math.max(0, Math.floor(Number((i as { qty?: unknown }).qty) || 0)),
      unitPrice: Math.max(0, Math.round(Number((i as { unitPrice?: unknown }).unitPrice) || 0)),
    }))
    .filter((i) => i.name && i.qty > 0);

  if (items.length === 0) {
    return NextResponse.json({ error: "Add at least one item with a name and quantity" }, { status: 400 });
  }

  const order = await createSupplierOrder({
    supplier,
    contact_name: body.contact_name ? String(body.contact_name).trim() : null,
    phone: body.phone ? String(body.phone).trim() : null,
    email: body.email ? String(body.email).trim() : null,
    items,
    shipping: body.shipping,
    expected_date: body.expected_date || null,
    notes: body.notes ? String(body.notes).trim() : null,
    created_by_id: me?.id ?? null,
    created_by_name: me?.name ?? me?.email ?? null,
  });

  return NextResponse.json({ order: { ...order, items: JSON.parse(order.items) } }, { status: 201 });
}

export async function DELETE(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const me = await getSessionUser();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing order id" }, { status: 400 });
  const order = await getSupplierOrder(id);
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  // Staff can only delete purchase orders they created; superadmins can delete anything.
  if (me?.role !== "superadmin" && (!order.created_by_id || order.created_by_id !== me?.id)) {
    return NextResponse.json({ error: "You can only delete purchase orders you created" }, { status: 403 });
  }
  await deleteSupplierOrder(id);
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id, status } = (await req.json().catch(() => ({}))) as { id?: string; status?: string };
  if (!id || !status) return NextResponse.json({ error: "Missing id or status" }, { status: 400 });
  await setSupplierOrderStatus(id, status);
  return NextResponse.json({ ok: true });
}

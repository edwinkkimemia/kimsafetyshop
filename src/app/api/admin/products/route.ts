import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

// Never cache: a stale GET here would make the admin form re-save OLD values.
export const dynamic = "force-dynamic";
import { requireAdmin, requireSuperAdmin } from "@/lib/api-helpers";
import { products } from "@/lib/data/products";
import { getAdminProduct, upsertAdminProduct, deleteAdminProduct, listPendingRestockRequests, markRestockNotified } from "@/lib/db";
import { mergedCatalog, invalidateCatalogCache } from "@/lib/admin-products";
import { liveGetProduct } from "@/lib/catalog";
import { sendBackInStockEmail } from "@/lib/mailer";
import { siteUrl } from "@/lib/site";
import { addDeletedSku, removeDeletedSku } from "@/lib/catalog";

/**
 * Busts every ISR page that can display product data (home, search, category,
 * deals, brands, product/[slug]). Admin saves are rare, so a sitewide bust is
 * the simplest way to guarantee no page anywhere serves a stale price/image —
 * without it, ISR pages would keep old values for up to their revalidate window.
 * Also busts the specific product path when sku/slug known for immediate refresh.
 */
function revalidateProductPages(sku?: string, slug?: string) {
  revalidatePath("/", "layout");
  if (slug) revalidatePath(`/product/${slug}`);
  if (sku) revalidatePath(`/product/${sku}`);
  // Category/search/brands also show product images – layout bust covers them
}

/**
 * Fires back-in-stock emails when a save brings a subscribed product into
 * stock. Best-effort: never blocks or fails the admin save.
 */
async function maybeNotifyRestock(sku: string, stock: number, name: string, slug: string | undefined) {
  if (!(stock > 0)) return;
  const pending = await listPendingRestockRequests(sku);
  if (pending.length === 0) return;
  const product = await liveGetProduct(sku);
  if (!product || product.stock <= 0) return; // effective stock still zero — skip
  const url = `${siteUrl}/product/${encodeURIComponent(slug || product.slug || sku)}`;
  const notified: string[] = [];
  for (const req of pending.slice(0, 200)) {
    try {
      if (await sendBackInStockEmail({ to: req.email, productName: name, productUrl: url })) {
        notified.push(req.id);
      }
    } catch (err) {
      console.error(`[admin-products] restock email failed for ${req.email}:`, (err as Error).message);
    }
  }
  await markRestockNotified(notified);
}

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const products = await mergedCatalog().catch(() => [] as Awaited<ReturnType<typeof mergedCatalog>>);
    return NextResponse.json({ products });
  } catch (err) {
    console.error("[admin/products] error:", (err as Error).message);
    return NextResponse.json({ products: [] });
  }
}

export async function POST(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  let body: Record<string, unknown> & { name?: string; price?: number; sku?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body.name || typeof body.price !== "number") {
    return NextResponse.json({ error: "Name and price are required" }, { status: 400 });
  }
  const sku = body.sku?.trim() || `KS-CUS-${Math.floor(1000 + Math.random() * 9000)}`;
  if (await getAdminProduct(sku)) {
    return NextResponse.json({ error: `SKU ${sku} already exists` }, { status: 409 });
  }
  const record = {
    sku,
    name: body.name,
    brand: body.brand ?? "KimSafety",
    category: body.category ?? "industrial-safety",
    categoryName: body.categoryName ?? "Industrial Safety",
    categories: Array.isArray(body.categories) ? body.categories.filter((c): c is string => typeof c === "string") : undefined,
    price: body.price,
    oldPrice: body.oldPrice ?? undefined,
    stock: body.stock ?? 0,
    lowStockAt: body.lowStockAt ?? 10,
    rating: body.rating ?? 4.5,
    reviews: body.reviews ?? 0,
    sold: body.sold ?? 0,
    model: typeof body.model === "string" ? body.model : undefined,
    featured: Boolean(body.featured),
    bestSeller: Boolean(body.bestSeller),
    new: Boolean(body.new),
    color: typeof body.color === "string" ? body.color : undefined,
    size: typeof body.size === "string" ? body.size : undefined,
    material: typeof body.material === "string" ? body.material : undefined,
    weight: typeof body.weight === "string" ? body.weight : undefined,
    certification: typeof body.certification === "string" ? body.certification : undefined,
    standard: typeof body.standard === "string" ? body.standard : undefined,
    warranty: typeof body.warranty === "string" ? body.warranty : undefined,
    shelfLife: typeof body.shelfLife === "string" ? body.shelfLife : undefined,
    country: typeof body.country === "string" ? body.country : undefined,
    tags: Array.isArray(body.tags) ? body.tags : ["safety"],
    description: body.description ?? "",
    features: Array.isArray(body.features) ? body.features : [],
    image: typeof body.image === "string" ? body.image : undefined,
    gallery: Array.isArray(body.gallery) ? body.gallery.filter((p): p is string => typeof p === "string") : [],
    specs: Array.isArray(body.specs) ? body.specs : [],
    bulk: Array.isArray(body.bulk) ? body.bulk : [],
    downloads: Array.isArray(body.downloads) ? body.downloads : [],
    static: false,
  };
  await upsertAdminProduct(sku, record);
  await removeDeletedSku(sku);
  invalidateCatalogCache();
  const rec = record as Record<string, unknown>;
  revalidateProductPages(sku, typeof rec.slug === "string" ? rec.slug : undefined);
  try {
    await maybeNotifyRestock(sku, Number(rec.stock ?? 0), String(record.name), typeof rec.slug === "string" ? rec.slug : undefined);
  } catch (err) {
    console.error("[admin-products] restock notify failed:", (err as Error).message);
  }
  return NextResponse.json({ product: record }, { status: 201 });
}

export async function PATCH(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  let body: Record<string, unknown> & { sku?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const sku = body.sku;
  if (!sku) return NextResponse.json({ error: "Missing SKU" }, { status: 400 });

  const existing = (await getAdminProduct(sku)) ?? (products.find((p) => p.sku === sku) as unknown as Record<string, unknown>);
  if (!existing) return NextResponse.json({ error: "Product not found" }, { status: 404 });

  const isStatic = Boolean((existing as { static?: boolean }).static) || Boolean(products.find((p) => p.sku === sku));
  const merged = { ...existing, ...body, sku, static: isStatic };
  delete merged.id;
  await upsertAdminProduct(sku, merged);
  await removeDeletedSku(sku);
  invalidateCatalogCache();
  revalidateProductPages(sku, typeof merged.slug === "string" ? merged.slug : undefined);
  try {
    await maybeNotifyRestock(sku, Number(merged.stock ?? 0), String(merged.name ?? sku), typeof merged.slug === "string" ? merged.slug : undefined);
  } catch (err) {
    console.error("[admin-products] restock notify failed:", (err as Error).message);
  }
  return NextResponse.json({ product: merged });
}

export async function DELETE(req: Request) {
  const denied = await requireSuperAdmin();
  if (denied) return denied;
  const url = new URL(req.url);
  const sku = url.searchParams.get("sku");
  if (!sku) return NextResponse.json({ error: "Missing SKU" }, { status: 400 });
  const existing = await getAdminProduct(sku);
  // Fully uniform: any product can be deleted, including seed. If no admin row exists yet (pure seed), we still allow delete by blocking the SKU.
  if (!existing) {
    const seedExists = products.some((p) => p.sku === sku);
    if (!seedExists) return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }
  if (existing) await deleteAdminProduct(sku);
  await addDeletedSku(sku);
  invalidateCatalogCache();
  revalidateProductPages(sku);
  return NextResponse.json({ ok: true });
}

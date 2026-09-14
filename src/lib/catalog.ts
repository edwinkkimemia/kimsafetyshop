import { products, normalizeDownloads } from "@/lib/data/products";
import { productInCategory } from "@/lib/data/catalog";
import { productImages, productGalleries } from "@/lib/data/product-images";
import { getSetting, listAdminProducts } from "@/lib/db";
import { slugify } from "@/lib/utils";
import type { Product } from "@/lib/types";
import path from "path";

// Admin product table changes only on admin edits. Previously 5s TTL caused
// every Lambda to hit Postgres every 5s — under burst (Vercel = many Lambdas)
// this saturates the `prisma_migration` connection limit (53300).
// 30s TTL + stale-while-revalidate keeps edits visible within ~30s while
// cutting DB QPS by 6×. On 53300 we back off 30s and serve static catalog.
const CATALOG_TTL_MS = 30 * 1000;
const DB_FAIL_TTL_MS = 30 * 1000;
let cachedAdminRows: { at: number; rows: Awaited<ReturnType<typeof listAdminProducts>> } | null = null;
let lastDbFailAt = 0;

export async function getCachedAdminRows(): Promise<Awaited<ReturnType<typeof listAdminProducts>> | null> {
  const now = Date.now();
  if (cachedAdminRows && now - cachedAdminRows.at < CATALOG_TTL_MS) return cachedAdminRows.rows;
  // After a failure, back off briefly so an overloaded DB is not hammered.
  if (now - lastDbFailAt < DB_FAIL_TTL_MS) {
    // Serve stale if we have it, otherwise signal caller to use static catalog.
    return cachedAdminRows?.rows ?? null;
  }
  try {
    const rows = await listAdminProducts();
    cachedAdminRows = { at: now, rows };
    return rows;
  } catch (err) {
    lastDbFailAt = Date.now();
    console.error("[catalog] admin rows fetch failed, serving static catalog:", (err as Error).message);
    // Return stale on transient failure so storefront never 500s under 53300.
    return cachedAdminRows?.rows ?? null;
  }
}

export function invalidateCatalogCache() {
  cachedAdminRows = null;
  lastDbFailAt = 0;
  cachedBlocked = null;
  cachedDeleted = null;
}

let cachedBlocked: { at: number; set: Set<string> } | null = null;
const BLOCKED_TTL_MS = 60 * 1000;

async function getBlockedSet(): Promise<Set<string>> {
  const now = Date.now();
  if (cachedBlocked && now - cachedBlocked.at < BLOCKED_TTL_MS) return cachedBlocked.set;
  try {
    const raw = await getSetting("blocked_images");
    if (!raw) {
      cachedBlocked = { at: now, set: new Set() };
      return cachedBlocked.set;
    }
    const arr = JSON.parse(raw);
    const set = new Set<string>(Array.isArray(arr) ? arr.filter((v) => typeof v === "string") : []);
    cachedBlocked = { at: now, set };
    return set;
  } catch {
    return cachedBlocked?.set ?? new Set();
  }
}

export async function addBlockedImages(filenames: string[]) {
  const set = await getBlockedSet();
  let changed = false;
  for (const fn of filenames) {
    if (!set.has(fn)) {
      set.add(fn);
      changed = true;
    }
  }
  if (changed) {
    const { setSetting } = await import("@/lib/db");
    await setSetting("blocked_images", JSON.stringify(Array.from(set)));
    cachedBlocked = { at: Date.now(), set };
    invalidateCatalogCache();
  }
}

let cachedDeleted: { at: number; set: Set<string> } | null = null;
const DELETED_TTL_MS = 60 * 1000;

async function getDeletedSet(): Promise<Set<string>> {
  const now = Date.now();
  if (cachedDeleted && now - cachedDeleted.at < DELETED_TTL_MS) return cachedDeleted.set;
  try {
    const raw = await getSetting("deleted_product_skus");
    if (!raw) {
      cachedDeleted = { at: now, set: new Set() };
      return cachedDeleted.set;
    }
    const arr = JSON.parse(raw);
    const set = new Set<string>(Array.isArray(arr) ? arr.filter((v) => typeof v === "string") : []);
    cachedDeleted = { at: now, set };
    return set;
  } catch {
    return cachedDeleted?.set ?? new Set();
  }
}

export async function addDeletedSku(sku: string) {
  const set = await getDeletedSet();
  if (set.has(sku)) return;
  set.add(sku);
  const { setSetting } = await import("@/lib/db");
  await setSetting("deleted_product_skus", JSON.stringify(Array.from(set)));
  cachedDeleted = { at: Date.now(), set };
  invalidateCatalogCache();
}

export async function removeDeletedSku(sku: string) {
  const set = await getDeletedSet();
  if (!set.has(sku)) return;
  set.delete(sku);
  const { setSetting } = await import("@/lib/db");
  await setSetting("deleted_product_skus", JSON.stringify(Array.from(set)));
  cachedDeleted = { at: Date.now(), set };
  invalidateCatalogCache();
}

// Resolves the final image/gallery URLs server-side so the browser receives
// finished URLs on first paint. Admin override wins, then the committed photo
// map, then the SKU-path fallback. An empty string counts as "not set" (the
// admin form persists image:"" when clearing an override).
// Blocked images (deleted via Media Library) are ignored even if they remain
// in the committed productImages map — otherwise the old file would flash
// before the new DB-backed upload on every product reload.
function resolveImage(sku: string, value: unknown, blocked: Set<string>): string {
  if (typeof value === "string" && value) {
    // If the admin override itself points to a blocked file, treat as not set
    try {
      const fn = decodeURIComponent(path.basename(value));
      if (blocked.has(fn)) {
        // fall through to fallback
      } else {
        return value;
      }
    } catch {
      return value;
    }
  }
  const mapped = productImages[sku];
  if (mapped) {
    try {
      const fn = decodeURIComponent(path.basename(mapped));
      if (!blocked.has(fn)) return mapped;
    } catch {
      return mapped;
    }
  }
  return `/images/products/${sku}.jpg`;
}

function resolveGallery(sku: string, value: unknown, blocked: Set<string>): string[] | undefined {
  if (Array.isArray(value)) {
    const clean = value.filter((p): p is string => typeof p === "string" && Boolean(p));
    // filter blocked from gallery overrides
    const filtered = clean.filter((p) => {
      try {
        return !blocked.has(decodeURIComponent(path.basename(p)));
      } catch {
        return true;
      }
    });
    if (filtered.length > 0) return filtered;
    // if override was entirely blocked, fall through to mapped gallery
  }
  const mapped = productGalleries[sku];
  if (!mapped || mapped.length === 0) return undefined;
  const filtered = mapped.filter((url) => {
    try {
      return !blocked.has(decodeURIComponent(path.basename(url)));
    } catch {
      return true;
    }
  });
  return filtered.length > 0 ? [...filtered] : undefined;
}

async function mergedCatalog(): Promise<Product[]> {
  const [rows, blocked, deleted] = await Promise.all([
    getCachedAdminRows().then((r) => r ?? []),
    getBlockedSet(),
    getDeletedSet(),
  ]);
  const overrides = new Map<string, Record<string, unknown>>();
  const customs: Record<string, unknown>[] = [];
  for (const row of rows) {
    const data = JSON.parse(String(row.data)) as Record<string, unknown> & { sku: string; static?: boolean };
    if (deleted.has(data.sku)) continue;
    if (data.static) overrides.set(data.sku, data);
    else customs.push(data);
  }

  const merged = products
    .filter((p) => !deleted.has(p.sku))
    .map((p) => {
      const override = overrides.get(p.sku);
      const base = override ? { ...p, ...override } : p;
      return {
        ...base,
        image: resolveImage(base.sku, base.image, blocked),
        gallery: resolveGallery(base.sku, base.gallery, blocked),
        downloads: normalizeDownloads(base.downloads),
      };
    });

  const customProducts: Product[] = customs
    .filter((c) => !deleted.has(String(c.sku)))
    .map((c) => ({
      id: `custom-${c.sku}`,
      slug: typeof c.slug === "string" && c.slug ? c.slug : slugify(String(c.name ?? c.sku)),
      sku: String(c.sku),
      name: String(c.name ?? c.sku),
      brand: String(c.brand ?? "KimSafety"),
      category: String(c.category ?? "industrial-safety"),
      categoryName: String(c.categoryName ?? "Industrial Safety"),
      categories: Array.isArray(c.categories) ? (c.categories as string[]) : undefined,
      price: Number(c.price ?? 0),
      oldPrice: typeof c.oldPrice === "number" ? c.oldPrice : undefined,
      stock: Number(c.stock ?? 0),
      lowStockAt: Number(c.lowStockAt ?? 10),
      rating: Number(c.rating ?? 4.5),
      reviews: Number(c.reviews ?? 0),
      sold: Number(c.sold ?? 0),
      tags: Array.isArray(c.tags) ? (c.tags as string[]) : ["safety"],
      description: String(c.description ?? ""),
      features: Array.isArray(c.features) ? (c.features as string[]) : [],
      specs: [],
      bulk: [],
      downloads: [],
      ...(c as Partial<Product>),
      image: resolveImage(String(c.sku), c.image, blocked),
      gallery: resolveGallery(String(c.sku), c.gallery, blocked),
    }));

  return stableShuffle([...merged, ...customProducts.map((p) => ({ ...p, downloads: normalizeDownloads(p.downloads) }))]);
}

/**
 * Deterministic shuffle: a seeded Fisher–Yates over a SKU-sorted copy whose seed
 * rotates hourly. Every request/refetch inside the hour returns the SAME order,
 * so paginated grids don't reshuffle while a visitor browses, yet the storefront
 * still rotates over time for discovery. Sorting by SKU first makes the result
 * independent of DB row ordering.
 */
function stableShuffle<T extends { sku: string }>(arr: T[]): T[] {
  const out = [...arr].sort((a, b) => a.sku.localeCompare(b.sku));
  let s = Math.floor(Date.now() / 3_600_000) >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

let catalogInflight: Promise<Product[]> | null = null;

export async function liveCatalog(): Promise<Product[]> {
  if (catalogInflight) return catalogInflight;
  catalogInflight = mergedCatalog().finally(() => {
    // clear on next tick so concurrent callers share the same promise
    setTimeout(() => {
      catalogInflight = null;
    }, 0);
  });
  return catalogInflight;
}

/**
 * Live product count for SEO copy — always reflects the current catalog
 * (admin additions included). Falls back to the seed length if the DB is
 * unreachable so metadata never renders "undefined".
 */
export async function getProductCount(): Promise<number> {
  try {
    return (await liveCatalog()).length;
  } catch {
    const { products } = await import("@/lib/data/products");
    return products.length;
  }
}

export async function liveGetProduct(id: string): Promise<Product | undefined> {
  const catalog = await liveCatalog();
  return catalog.find((p) => p.id === id);
}

export async function liveGetBySlug(slug: string): Promise<Product | undefined> {
  const catalog = await liveCatalog();
  return catalog.find((p) => p.slug === slug || p.sku === slug || p.id === slug);
}

export async function liveRelatedFor(product: Product, count = 8): Promise<Product[]> {
  const list = await liveCatalog();
  const sameCat = list.filter(
    (p) => p.id !== product.id && (productInCategory(p, product.category) || (product.categories ?? []).some((c) => productInCategory(p, c)))
  );
  const sameBrand = list.filter(
    (p) => p.brand === product.brand && p.id !== product.id && !sameCat.includes(p)
  );
  const others = list.filter(
    (p) => !sameCat.includes(p) && !sameBrand.includes(p) && p.id !== product.id
  );
  return [...sameCat, ...sameBrand, ...others].slice(0, count);
}

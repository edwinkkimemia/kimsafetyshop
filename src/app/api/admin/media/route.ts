export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { requireSuperAdmin } from "@/lib/api-helpers";
import { qr } from "@/lib/db";
import { deleteStoredFile } from "@/lib/file-store";
import { productImages, productGalleries } from "@/lib/data/product-images";
import { getSetting, listAdminProducts, upsertAdminProduct } from "@/lib/db";
import { addBlockedImages } from "@/lib/catalog";

const IMAGE_RE = /\.(jpe?g|png|webp|gif)$/i;
const SAFE_NAME = /^[\w .\-()\[\],&'@+]+\.(jpe?g|png|webp|gif)$/i;

type MediaItem = {
  filename: string;
  url: string;
  encodedUrl: string;
  source: string;
  sources: string[];
  size: number;
  mtime: string | null;
  mime: string | null;
  references: string[];
  referenceDetail: { sku: string; name?: string; field: string }[];
  isDb: boolean;
  isFilesystem: boolean;
};

function listDirWithMeta(relative: string): { filename: string; size: number; mtime: string; fullPath: string }[] {
  const dir = path.join(process.cwd(), "public", "images", relative);
  try {
    const files = fs.readdirSync(dir);
    return files
      .filter((f) => IMAGE_RE.test(f))
      .map((filename) => {
        const fullPath = path.join(dir, filename);
        try {
          const stat = fs.statSync(fullPath);
          return {
            filename,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            fullPath,
          };
        } catch {
          return { filename, size: 0, mtime: new Date().toISOString(), fullPath };
        }
      });
  } catch {
    return [];
  }
}

function decodeFilenameFromUrl(url: string): string {
  try {
    const base = path.basename(url);
    return decodeURIComponent(base);
  } catch {
    return path.basename(url);
  }
}

async function getBlockedSet(): Promise<Set<string>> {
  try {
    const raw = await getSetting("blocked_images");
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export async function GET() {
  const denied = await requireSuperAdmin();
  if (denied) return denied;

  const blocked = await getBlockedSet();

  // --- Filesystem ---
  const productFiles = listDirWithMeta("products");
  const brandFiles = listDirWithMeta("brands");
  const heroFiles = listDirWithMeta("hero");
  const logoFiles = listDirWithMeta("logo");

  // Also check generic uploads/documents for images
  const uploadsDir = path.join(process.cwd(), "public", "uploads", "documents");
  let uploadsDocFiles: typeof productFiles = [];
  try {
    const files = fs.readdirSync(uploadsDir);
    uploadsDocFiles = files
      .filter((f) => IMAGE_RE.test(f))
      .map((filename) => {
        const fullPath = path.join(uploadsDir, filename);
        try {
          const stat = fs.statSync(fullPath);
          return { filename, size: stat.size, mtime: stat.mtime.toISOString(), fullPath };
        } catch {
          return { filename, size: 0, mtime: new Date().toISOString(), fullPath };
        }
      });
  } catch {}

  // --- DB ---
  let dbFiles: { filename: string; mime: string | null; size: number; created_at: string }[] = [];
  try {
    const rows = (await qr("SELECT filename, mime, size, created_at FROM upload_files ORDER BY created_at DESC")) as {
      filename: string;
      mime: string | null;
      size: number;
      created_at: string;
    }[];
    dbFiles = rows.filter((r) => IMAGE_RE.test(r.filename) && !blocked.has(r.filename));
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const msg = (err as Error)?.message ?? "";
    // 53300 too many connections -> serve filesystem-only instead of 500
    if (code === "42P01") dbFiles = [];
    else if (code === "53300" || /too many connections/i.test(msg)) {
      console.warn("[admin/media] dbFiles fallback to filesystem due to 53300");
      dbFiles = [];
    } else throw err;
  }

  // Filter blocked from filesystem lists so deleted images don't reappear after reload
  const filterBlockedFs = (arr: typeof productFiles) => arr.filter((f) => !blocked.has(f.filename));
  const fsProductFiles = filterBlockedFs(productFiles);
  const fsBrandFiles = filterBlockedFs(brandFiles);
  const fsHeroFiles = filterBlockedFs(heroFiles);
  const fsLogoFiles = filterBlockedFs(logoFiles);
  const fsUploadsDocFiles = filterBlockedFs(uploadsDocFiles);

  // --- Build reverse map for static productImages / galleries ---
  const staticRefMap = new Map<string, { sku: string; field: string }[]>();
  for (const [sku, url] of Object.entries(productImages)) {
    const fn = decodeFilenameFromUrl(url);
    if (!fn) continue;
    const arr = staticRefMap.get(fn) || [];
    arr.push({ sku, field: "productImages" });
    staticRefMap.set(fn, arr);
  }
  for (const [sku, urls] of Object.entries(productGalleries)) {
    for (const url of urls) {
      const fn = decodeFilenameFromUrl(url);
      if (!fn) continue;
      const arr = staticRefMap.get(fn) || [];
      arr.push({ sku, field: "gallery" });
      staticRefMap.set(fn, arr);
    }
  }

  // --- Admin product references ---
  const adminRefMap = new Map<string, { sku: string; name?: string; field: string }[]>();
  try {
    const adminRows = await listAdminProducts().catch(() => [] as Awaited<ReturnType<typeof listAdminProducts>>);
    for (const row of adminRows) {
      const data = JSON.parse(String(row.data)) as Record<string, unknown> & { sku: string; name?: string; image?: string; gallery?: string[] };
      const sku = data.sku;
      const name = typeof data.name === "string" ? data.name : undefined;
      const check = (value: unknown, field: string) => {
        if (typeof value === "string" && value) {
          const fn = decodeFilenameFromUrl(value);
          if (fn) {
            const arr = adminRefMap.get(fn) || [];
            arr.push({ sku, name, field });
            adminRefMap.set(fn, arr);
          }
        }
      };
      check(data.image, "image");
      if (Array.isArray(data.gallery)) {
        for (const g of data.gallery) check(g, "gallery");
      }
    }
  } catch {
    // 53300 -> empty refs is fine
  }

  // --- Merge all files into map by filename ---
  const map = new Map<string, MediaItem>();

  const pushFs = (
    files: typeof productFiles,
    source: string,
    urlPrefix: string,
  ) => {
    for (const f of files) {
      const existing = map.get(f.filename);
      const url = `${urlPrefix}/${encodeURIComponent(f.filename)}`;
      const staticRefs = staticRefMap.get(f.filename) || [];
      const adminRefs = adminRefMap.get(f.filename) || [];
      const allRefs = [...staticRefs, ...adminRefs];
      const references = Array.from(new Set(allRefs.map((r) => r.sku || r.field)));
      const detail = allRefs as { sku: string; name?: string; field: string }[];
      if (existing) {
        existing.sources.push(source);
        existing.source = existing.sources.join("+");
        // Keep filesystem size if larger? Keep first.
        // Merge references
        const merged = new Map<string, typeof detail[0]>();
        for (const d of [...existing.referenceDetail, ...detail]) {
          const key = `${d.sku}:${d.field}`;
          if (!merged.has(key)) merged.set(key, d);
        }
        existing.referenceDetail = Array.from(merged.values());
        existing.references = Array.from(new Set(existing.referenceDetail.map((r) => r.sku || r.field)));
      } else {
        map.set(f.filename, {
          filename: f.filename,
          url,
          encodedUrl: url,
          source,
          sources: [source],
          size: f.size,
          mtime: f.mtime,
          mime: null,
          references,
          referenceDetail: detail,
          isDb: false,
          isFilesystem: true,
        });
      }
    }
  };

  pushFs(fsProductFiles, "products", "/images/products");
  pushFs(fsBrandFiles, "brands", "/images/brands");
  pushFs(fsHeroFiles, "hero", "/images/hero");
  pushFs(fsLogoFiles, "logo", "/images/logo");
  pushFs(fsUploadsDocFiles, "documents", "/uploads/documents");

  // DB files — merge or create
  for (const db of dbFiles) {
    const existing = map.get(db.filename);
    const url = `/api/uploads/${encodeURIComponent(db.filename)}`;
    const staticRefs = staticRefMap.get(db.filename) || [];
    const adminRefs = adminRefMap.get(db.filename) || [];
    const allRefs = [...staticRefs, ...adminRefs];
    const detail = allRefs as { sku: string; name?: string; field: string }[];
    if (existing) {
      existing.isDb = true;
      existing.sources.push("uploads");
      existing.source = Array.from(new Set(existing.sources)).join("+");
      // Prefer DB size/mtime if newer?
      // Keep DB url as primary for preview? Keep both; set url to DB url for preview (more reliable)
      existing.url = url;
      existing.encodedUrl = url;
      existing.mime = db.mime;
      // Merge refs already done, but ensure
      const merged = new Map<string, typeof detail[0]>();
      for (const d of [...existing.referenceDetail, ...detail]) {
        const key = `${d.sku}:${d.field}`;
        if (!merged.has(key)) merged.set(key, d);
      }
      existing.referenceDetail = Array.from(merged.values());
      existing.references = Array.from(new Set(existing.referenceDetail.map((r) => r.sku || r.field)));
      // Update size/mtime to DB if larger/more recent
      if (db.size) existing.size = db.size;
      if (db.created_at) existing.mtime = db.created_at;
    } else {
      map.set(db.filename, {
        filename: db.filename,
        url,
        encodedUrl: url,
        source: "uploads",
        sources: ["uploads"],
        size: db.size,
        mtime: db.created_at,
        mime: db.mime,
        references: Array.from(new Set(detail.map((r) => r.sku || r.field))),
        referenceDetail: detail,
        isDb: true,
        isFilesystem: false,
      });
    }
  }

  // Also include productImages filenames that may not have a file on disk/DB (orphaned mapping)
  // So superadmin can see broken references — but skip blocked (deleted) ones so they don't reload.
  for (const url of Object.values(productImages)) {
    const fn = decodeFilenameFromUrl(url);
    if (!fn || map.has(fn) || blocked.has(fn)) continue;
    const detail = staticRefMap.get(fn) || [];
    map.set(fn, {
      filename: fn,
      url: `/images/products/${encodeURIComponent(fn)}`,
      encodedUrl: `/images/products/${encodeURIComponent(fn)}`,
      source: "products (missing)",
      sources: ["products (missing)"],
      size: 0,
      mtime: null,
      mime: null,
      references: detail.map((d) => d.sku),
      referenceDetail: detail as { sku: string; name?: string; field: string }[],
      isDb: false,
      isFilesystem: false,
    });
  }

  const items = Array.from(map.values()).sort((a, b) => {
    // Most recent first
    const ta = a.mtime ? new Date(a.mtime).getTime() : 0;
    const tb = b.mtime ? new Date(b.mtime).getTime() : 0;
    return tb - ta;
  });

  // Compute stats
  const stats = {
    total: items.length,
    products: items.filter((i) => i.sources.includes("products") || i.sources.includes("products (missing)")).length,
    uploads: items.filter((i) => i.isDb).length,
    filesystem: items.filter((i) => i.isFilesystem).length,
    missing: items.filter((i) => i.source.includes("missing")).length,
  };

  return NextResponse.json({ items, stats });
}

export async function DELETE(req: Request) {
  const denied = await requireSuperAdmin();
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const filenameParam = searchParams.get("filename") || searchParams.get("file");
  let filenames: string[] = [];

  if (filenameParam) {
    filenames = [filenameParam];
  } else {
    try {
      const body = await req.json().catch(() => ({}));
      if (Array.isArray(body.filenames)) filenames = body.filenames;
      else if (Array.isArray(body.files)) filenames = body.files;
      else if (typeof body.filename === "string") filenames = [body.filename];
    } catch {}
  }

  filenames = filenames.map((f) => f.trim()).filter(Boolean);

  if (filenames.length === 0) {
    return NextResponse.json({ error: "No filename provided" }, { status: 400 });
  }

  // Validate filenames
  for (const fn of filenames) {
    if (!SAFE_NAME.test(fn) || fn.includes("..") || fn.includes("/") || fn.includes("\\")) {
      return NextResponse.json({ error: `Invalid filename: ${fn}` }, { status: 400 });
    }
  }

  // Prevent deleting critical branding if referenced in settings? We allow but warn.
  // Proceed to delete each.
  const results: { filename: string; deleted: boolean; error?: string; referencesCleared?: number }[] = [];

  for (const filename of filenames) {
    let deletedFs = false;
    let deletedDb = false;
    let refsCleared = 0;
    let error: string | undefined;

    // 1. Delete from DB
    try {
      await deleteStoredFile(filename);
      deletedDb = true;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== "42P01") {
        // If file not found, not error
        // deleteStoredFile does not throw if not found? It deletes where filename = ?
        // So success even if 0 rows.
      }
      // Treat as success if not found
      deletedDb = true;
    }

    // 2. Delete from filesystem (all image dirs)
    const dirs = [
      path.join(process.cwd(), "public", "images", "products"),
      path.join(process.cwd(), "public", "images", "brands"),
      path.join(process.cwd(), "public", "images", "hero"),
      path.join(process.cwd(), "public", "images", "logo"),
      path.join(process.cwd(), "public", "uploads", "documents"),
    ];
    for (const dir of dirs) {
      const full = path.join(dir, filename);
      try {
        if (fs.existsSync(full)) {
          fs.unlinkSync(full);
          deletedFs = true;
        }
      } catch (e) {
        error = (e as Error).message;
      }
    }

    // 3. Clear references in admin_products (image / gallery)
    try {
      const adminRows = await listAdminProducts();
      for (const row of adminRows) {
        const data = JSON.parse(String(row.data)) as Record<string, unknown> & { sku: string; image?: string; gallery?: string[] };
        let changed = false;
        const image = data.image;
        if (typeof image === "string" && image) {
          const fn = decodeFilenameFromUrl(image);
          if (fn === filename) {
            data.image = "";
            changed = true;
          }
        }
        if (Array.isArray(data.gallery)) {
          const origLen = data.gallery.length;
          const filtered = data.gallery.filter((g) => {
            if (typeof g !== "string") return true;
            const fn = decodeFilenameFromUrl(g);
            return fn !== filename;
          });
          if (filtered.length !== origLen) {
            data.gallery = filtered;
            changed = true;
          }
        }
        if (changed) {
          await upsertAdminProduct(data.sku, data);
          refsCleared++;
        }
      }
    } catch (e) {
      // Not critical
      console.error("[media] clear refs failed for", filename, e);
    }

    const deleted = deletedFs || deletedDb;
    results.push({
      filename,
      deleted,
      error: deleted ? undefined : error || "File not found",
      referencesCleared: refsCleared,
    });
  }

  // Block deleted images so catalog never serves the old file again (static productImages map is immutable on Vercel)
  // and media library doesn't reload the deleted entry as "missing".
  const succeeded = results.filter((r) => r.deleted).map((r) => r.filename);
  if (succeeded.length) {
    try {
      await addBlockedImages(succeeded);
      // Also bust the image-processor cache? Invalidate catalog already done inside addBlockedImages.
    } catch (e) {
      console.error("[media] addBlockedImages failed", e);
    }
  }

  return NextResponse.json({ results });
}

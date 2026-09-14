import fs from "fs";
import path from "path";
import { q1, qr, qe } from "@/lib/db";

// Uploads live in the database (BYTEA) so they persist on serverless platforms
// (Vercel) where the filesystem is read-only and ephemeral. Locally we still
// write to disk so files can be inspected, but the DB copy is the source of
// truth when serving.

export type StoredFile = { filename: string; data: Buffer; mime: string | null; size: number };

/** Magic-byte sniff — the extension and any client-supplied MIME are never trusted. */
export function sniffType(data: Buffer): string | null {
  if (data.length >= 4 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46) return "pdf";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "png";
  if (
    data.length >= 12 &&
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) return "webp";
  return null;
}

// Small in-memory LRU for image BYTEA — avoids per-image DB hit on grid pages
// (20 images = 20 concurrent SELECTs → 53300 with max:1). Cached per Lambda.
const FILE_CACHE_TTL_MS = 60 * 1000;
const FILE_CACHE_MAX = 100;
const fileCache = new Map<string, { at: number; data: StoredFile | null }>();
// Negative cache (null) avoids re-querying missing files every hit.
let fileCacheInflight = new Map<string, Promise<StoredFile | undefined>>();

function cacheGet(key: string): StoredFile | undefined | null | undefined {
  // return undefined = miss, null = negative hit, StoredFile = hit
  const hit = fileCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > FILE_CACHE_TTL_MS) {
    fileCache.delete(key);
    return undefined;
  }
  // LRU touch
  fileCache.delete(key);
  fileCache.set(key, hit);
  return hit.data;
}
function cacheSet(key: string, value: StoredFile | null) {
  if (fileCache.size >= FILE_CACHE_MAX) {
    const first = fileCache.keys().next().value as string | undefined;
    if (first) fileCache.delete(first);
  }
  fileCache.set(key, { at: Date.now(), data: value });
}

export async function saveStoredFile(filename: string, data: Buffer, mime?: string | null): Promise<void> {
  await qe(
    "INSERT INTO upload_files (filename, data, mime, size, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(filename) DO UPDATE SET data = excluded.data, mime = excluded.mime, size = excluded.size",
    filename,
    data,
    mime ?? null,
    data.length,
    new Date().toISOString()
  );
  cacheSet(filename, { filename, data, mime: mime ?? null, size: data.length });
}

export async function getStoredFile(filename: string): Promise<StoredFile | undefined> {
  const cached = cacheGet(filename);
  if (cached !== undefined) return cached ?? undefined;
  // Dedupe concurrent fetches for same filename (grid loads same image twice)
  const inflight = fileCacheInflight.get(filename);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const row = (await q1("SELECT filename, data, mime, size FROM upload_files WHERE filename = ?", filename)) as
        | { filename: string; data: Buffer; mime: string | null; size: number }
        | undefined;
      cacheSet(filename, row ?? null);
      return row;
    } catch (err) {
      const msg = (err as Error)?.message ?? "";
      const code = (err as { code?: string })?.code;
      if (code === "53300" || /too many connections/i.test(msg)) {
        // Under 53300 don't cache negative forever; fall through to fs
        console.warn(`[file-store] getStoredFile 53300 fallback for ${filename}`);
        return undefined;
      }
      throw err;
    } finally {
      fileCacheInflight.delete(filename);
    }
  })();
  fileCacheInflight.set(filename, p);
  return p;
}

export async function deleteStoredFile(filename: string): Promise<void> {
  await qe("DELETE FROM upload_files WHERE filename = ?", filename);
  fileCache.delete(filename);
}

export async function listStoredFiles(): Promise<string[]> {
  const rows = (await qr("SELECT filename FROM upload_files ORDER BY created_at DESC")) as { filename: string }[];
  return rows.map((r) => r.filename);
}

/** Resolve a public path (e.g. "/api/uploads/foo.jpg") to a Buffer, checking the DB first. */
export async function readPublicFile(publicPath: string): Promise<Buffer | undefined> {
  if (!publicPath.startsWith("/")) return undefined;
  if (publicPath.startsWith("/api/uploads/")) {
    const filename = decodeURIComponent(path.basename(publicPath));
    const stored = await getStoredFile(filename);
    if (stored) return stored.data;
    const local = localFileFor("products", filename);
    if (local && fs.existsSync(local)) return fs.readFileSync(local);
    return undefined;
  }
  if (publicPath.startsWith("/uploads/")) {
    const filename = decodeURIComponent(path.basename(publicPath));
    const stored = await getStoredFile(filename);
    if (stored) return stored.data;
    const local = localFileFor("uploads/documents", filename);
    if (local && fs.existsSync(local)) return fs.readFileSync(local);
    return undefined;
  }
  if (publicPath.startsWith("/images/")) {
    // Allow brands/products uploaded via admin (stored in DB as /api/uploads/<name> but
    // referenced as /images/brands/<name> in legacy rows) to resolve from DB first.
    // This keeps legacy manual paths working on Vercel where filesystem is ephemeral.
    const filename = decodeURIComponent(path.basename(publicPath));
    try {
      const stored = await getStoredFile(filename);
      if (stored) return stored.data;
    } catch {}
    const local = path.join(process.cwd(), "public", decodeURIComponent(publicPath).replace(/^\//, ""));
    if (fs.existsSync(local)) return fs.readFileSync(local);
    return undefined;
  }
  if (publicPath.startsWith("/documents/")) {
    // Admin document uploads (src/app/api/admin/documents) persist in the DB and
    // return /documents/<name> paths. Check the DB first (source of truth on
    // serverless), then the local disk mirror.
    const filename = decodeURIComponent(path.basename(publicPath));
    const stored = await getStoredFile(filename);
    if (stored) return stored.data;
    const local = localFileFor("documents", filename);
    if (local && fs.existsSync(local)) return fs.readFileSync(local);
    return undefined;
  }
  return undefined;
}

/** Absolute filesystem path under public/ for a given relative dir + filename. */
export function localFileFor(relativeDir: string, filename: string): string {
  return path.join(process.cwd(), "public", relativeDir, filename);
}

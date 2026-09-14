import { Pool } from "pg";
import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from "crypto";
import { DEFAULT_SETTINGS } from "@/lib/settings-defaults";

export type DbUser = {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: "user" | "admin" | "superadmin";
  company: string | null;
  phone: string | null;
  verified: number;
  referral_code: string | null;
  referred_by: string | null;
  created_at: string;
};

export type DbOrder = {
  id: string;
  user_id: string | null;
  name: string;
  email: string;
  phone: string;
  address: string;
  items: string;
  total: number;
  subtotal: number;
  discount: number;
  shipping: number;
  status: string;
  payment: string;
  paid: number;
  po_ref: string | null;
  company: string | null;
  po_file: string | null;
  payment_phone: string | null;
  mpesa_checkout_id: string | null;
  mpesa_merchant_id: string | null;
  mpesa_push_count: number;
  mpesa_pushed_at: string | null;
  mpesa_last_result: string | null;
  mpesa_last_result_desc: string | null;
  mpesa_transaction_id: string | null;
  paystack_reference: string | null;
  paystack_transaction_id: string | null;
  payment_token: string | null;
  referrer_code: string | null;
  delivery_note_file: string | null;
  kra_invoice_file: string | null;
  delivered_by: string | null;
  delivered_by_name: string | null;
  delivered_at: string | null;
  created_at: string;
};

export type DbQuote = {
  id: string;
  user_id: string | null;
  name: string;
  company: string | null;
  items: string;
  total: number;
  status: string;
  attachment: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  valid_until: string | null;
  created_by_id: string | null;
  created_by_name: string | null;
  created_at: string;
};

export type DbCorporateApplication = {
  id: string;
  company: string;
  kra_pin: string;
  industry: string;
  contact_name: string;
  phone: string;
  email: string;
  notes: string | null;
  documents: string;
  status: string;
  handled_by: string | null;
  handled_by_name: string | null;
  created_at: string;
};

export type DbPurchaseOrder = {
  id: string;
  company: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  po_file: string;
  status: string;
  created_by_id: string | null;
  created_by_name: string | null;
  created_at: string;
};

export type SupplierOrderItem = { name: string; qty: number; unitPrice: number };

export type DbSupplierOrder = {
  id: string;
  supplier: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  items: string;
  subtotal: number;
  shipping: number;
  total: number;
  expected_date: string | null;
  notes: string | null;
  status: string;
  created_by_id: string | null;
  created_by_name: string | null;
  created_at: string;
};

export type DbAddress = {
  id: string;
  user_id: string;
  label: string;
  name: string;
  phone: string;
  address_line: string;
  city: string;
  county: string;
  is_default: number;
  created_at: string;
};

export type DbTicket = {
  id: string;
  user_id: string;
  subject: string;
  message: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export type DbTicketReply = {
  id: string;
  ticket_id: string;
  user_id: string | null;
  staff_name: string | null;
  message: string;
  created_at: string;
};

export type DbReturn = {
  id: string;
  user_id: string;
  order_id: string;
  product_name: string;
  qty: number;
  reason: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export type DbContactMessage = {
  id: string;
  name: string;
  email: string;
  phone: string;
  topic: string;
  message: string;
  created_at: string;
};

export type DbProductQuestion = {
  id: string;
  product_id: string;
  name: string;
  email: string;
  question: string;
  answer: string | null;
  answered_at: string | null;
  created_at: string;
};

export type DbNotification = {
  id: string;
  user_id: string;
  type: string;
  title: string;
  message: string;
  link: string | null;
  read: number;
  created_at: string;
};

// Use globalThis so HMR / Vercel lambda reuse doesn't create extra pools.
// Without this, each hot-reload or concurrent lambda can leak a Pool (=2 conns).
const globalForPg = globalThis as unknown as { __kimsafetyPool?: Pool | null };

let pool: Pool | null = globalForPg.__kimsafetyPool ?? null;

export function getDb(): Pool {
  if (!pool) {
    let url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL environment variable is required");
    // Prisma Accelerate/Data Proxy URLs (prisma://) are not usable with pg Pool.
    // Vercel/Prisma Postgres at planLimitReached also surfaces as this URL.
    // Prefer DIRECT_URL (direct postgres) when available — it bypasses the limit.
    if (url.startsWith("prisma://")) {
      const direct = process.env.DIRECT_URL;
      if (direct) {
        console.warn("[kimsafety] DATABASE_URL is prisma:// — using DIRECT_URL for pg Pool");
        url = direct;
      } else {
        console.error("[kimsafety] DATABASE_URL is prisma:// and DIRECT_URL not set — DB calls will fail until plan is upgraded or DIRECT_URL is set. Falling back to static catalog where possible.");
      }
    }
    let host = "localhost";
    try {
      host = new URL(url).hostname;
    } catch {}
    const ssl = /sslmode=require|sslmode=verify-full/.test(url) || !["localhost", "127.0.0.1", "::1"].includes(host);
    // Serverless (Vercel) note: each concurrent Lambda isolate holds its own Pool.
    // With max:2 and 10 concurrent Lambdas you need 20 Postgres connections, but
    // the `prisma_migration` role is often limited to ~10. That is the
    // "too many connections for role prisma_migration" (53300) you see in logs.
    // Fix: keep max at 1 on Vercel (override with DATABASE_POOL_MAX) and use
    // the *pooled* Postgres host (Neon/Supabase pooler, e.g. ep-xxx-pooler... or
    // host:6543 / ?pgbouncer=true). The warning below fires when a direct host
    // is used in production.
    const isVercel = !!process.env.VERCEL;
    const poolMax = Number(process.env.DATABASE_POOL_MAX) || (isVercel ? 1 : 2);
    const hasPoolerHint =
      /pooler|pgbouncer=true/i.test(url) || /:6543\b/.test(url);
    if (isVercel && !hasPoolerHint && !host.includes("localhost") && !host.includes("127.0.0.1")) {
      console.warn(
        "[kimsafety] DATABASE_URL looks like a direct Postgres host. On Vercel, switch to the pooled connection string (Neon: add '-pooler' to hostname or use port 6543, append ?pgbouncer=true&connection_limit=1) to avoid 53300 too-many-connections."
      );
    }
    pool = new Pool({
      connectionString: url,
      ssl: ssl ? { rejectUnauthorized: false } : false,
      max: poolMax,
      // Short timeouts so a saturated DB fails fast and falls back to cache /
      // static catalog instead of hanging the Lambda for 8s and retrying.
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
      // Let the Lambda exit cleanly when idle; keeps idle conns from lingering.
      allowExitOnIdle: true,
    });
    pool.on("error", (err: Error) => console.error("[kimsafety] pg pool error", err));
    // Serverless: surface pool pressure in logs without crashing.
    // Remove listeners on HMR re-create to avoid duplicates.
    if (process.env.NODE_ENV !== "production") globalForPg.__kimsafetyPool = pool;
    else globalForPg.__kimsafetyPool = pool;
  }
  return pool;
}

function toPgParams(sql: string, params: unknown[] | Record<string, unknown>): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  let i = 0;
  const text = sql.replace(/(@[a-zA-Z_][a-zA-Z0-9_]*)|(\?)/g, (tok: string, name?: string) => {
    i += 1;
    if (name) values.push((params as Record<string, unknown>)[name.slice(1)]);
    else values.push((params as unknown[])[i - 1]);
    return `$${i}`;
  });
  return { text, values };
}

function normalizeParams(params: unknown[]): unknown[] | Record<string, unknown> {
  if (params.length === 1 && typeof params[0] === "object" && params[0] !== null && !Array.isArray(params[0])) {
    return params[0] as Record<string, unknown>;
  }
  return params;
}

function isTransientPgError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (!e) return false;
  const msg = e.message ?? "";
  if (e.code === "53300") return true; // too many connections
  if (e.code === "ECONNRESET" || e.code === "ECONNREFUSED" || e.code === "ETIMEDOUT" || e.code === "EPIPE") return true;
  if (/too many connections|connection terminated|write socket closed|read ECONNRESET|timeout exceeded/i.test(msg)) return true;
  return false;
}

function isTooManyConnections(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "53300" || /too many connections/i.test(e?.message ?? "");
}

async function runQuery<T>(text: string, values: unknown[], retries = 4): Promise<T> {
  try {
    const res = await getDb().query(text, values);
    return res as T;
  } catch (err) {
    if (retries > 0 && isTransientPgError(err)) {
      // 53300 (too many connections) is a capacity signal — hammering retries
      // makes the stampede worse. Retry at most once with jitter, then bubble
      // up so the caller can serve cached/static fallback instead of 500.
      if (isTooManyConnections(err)) {
        if (retries < 4) throw err; // only first 53300 gets one retry
        const jitter = 400 + Math.random() * 600;
        await new Promise((r) => setTimeout(r, jitter));
        return runQuery<T>(text, values, retries - 1);
      }
      // Other transient errors (ECONNRESET etc.) keep the old backoff but
      // capped to 2 retries to avoid tying up the Lambda.
      const cappedRetries = Math.min(retries, 2);
      if (cappedRetries !== retries) throw err;
      await new Promise((r) => setTimeout(r, 600 * (3 - cappedRetries) + 200 + Math.random() * 300));
      return runQuery<T>(text, values, retries - 1);
    }
    throw err;
  }
}

export async function q1<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
  const { text, values } = toPgParams(sql, normalizeParams(params));
  const res = await runQuery<{ rows: T[] }>(text, values);
  return res.rows[0] as T | undefined;
}

export async function qr<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
  const { text, values } = toPgParams(sql, normalizeParams(params));
  const res = await runQuery<{ rows: T[] }>(text, values);
  return res.rows as T[];
}

export async function qe(sql: string, ...params: unknown[]): Promise<number> {
  const { text, values } = toPgParams(sql, normalizeParams(params));
  const res = await runQuery<{ rowCount: number }>(text, values);
  return res.rowCount ?? 0;
}

// The application schema is managed by Prisma migrations (prisma/migrations),
// applied at deploy time via `prisma migrate deploy` — not at runtime.

export async function seedUsers() {
  const adminEmail = process.env.ADMIN_EMAIL ?? "admin@kimsafety.co.ke";
  const adminPass = process.env.ADMIN_PASSWORD;
  const res = await getDb().query("SELECT role FROM users WHERE email = $1", [adminEmail]);
  const existing = res.rows[0] as { role: string } | undefined;
  if (existing) {
    if (existing.role !== "superadmin") {
      await getDb().query("UPDATE users SET role = 'superadmin' WHERE email = $1", [adminEmail]);
    }
    return;
  }
  if (!adminPass) {
    throw new Error("ADMIN_PASSWORD environment variable is required to seed the admin user");
  }
  await getDb().query(
    "INSERT INTO users (id, name, email, password_hash, role, company, phone, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [randomUUID(), "KimSafety Admin", adminEmail, hashPassword(adminPass), "superadmin", "KimSafety Ltd", "+254 715135141", new Date().toISOString()]
  );
}

const SEED_BANNERS = [
  {
    kicker: "Industrial PPE · Certified & Genuine",
    title: "Protect Every Worker, Every Shift",
    subtitle:
      "3M, Honeywell, Ansell, Uvex and MSA — certified personal protective equipment delivered nationwide within 24–72 hours.",
    cta: "Shop PPE",
    cta_href: "/search",
    cta2: "Request Quote",
    image: "/images/hero/hero1.jpg",
    card_kicker: "KimSafety",
    card_title: "Your Trusted Safety Partner",
    card_subtitle: "Genuine & certified PPE, delivered nationwide within 24–72 hours.",
  },
  {
    kicker: "Medical Safety · Hospital Grade",
    title: "Clinical Supplies Kenyan Hospitals Trust",
    subtitle:
      "Examination gloves, masks, isolation gowns and laboratory equipment with full certification documentation.",
    cta: "Shop Medical",
    cta_href: "/search?category=medical",
    cta2: "Talk to a Specialist",
    image: "/images/hero/hero2.jpg",
    card_kicker: "Hospital Grade",
    card_title: "Clinical Supplies You Can Trust",
    card_subtitle: "Certified medical equipment and consumables for institutions and clinics.",
  },
  {
    kicker: "Bulk & Corporate · Up to 30% Off",
    title: "Bulk Discounts for Teams & Projects",
    subtitle:
      "Tiered pricing, negotiated corporate rates, tax invoices and dedicated account managers for organizations.",
    cta: "See Pricing",
    cta_href: "/deals",
    cta2: "Request Corporate Quotation",
    image: "/images/hero/hero3.jpg",
    card_kicker: "Corporate",
    card_title: "Bulk Pricing for Organizations",
    card_subtitle: "Tiered rates, tax invoices and dedicated account managers.",
  },
];

const SEED_CAMPAIGNS = [
  {
    name: "Back to School PPE",
    discount_label: "School Supplies · Up to 20% off",
    description:
      "School and institutional PPE packs — dustcoats, gloves, masks and safety footwear for staff and learners.",
    cta_href: "/search?category=safety-wear",
    start_date: "2026-08-01",
    end_date: "2026-09-15",
  },
  {
    name: "Construction Week",
    discount_label: "Site Essentials · Up to 25% off",
    description:
      "Hard hats, hi-vis vests, safety boots and harnesses — everything your site crew needs at construction-week prices.",
    cta_href: "/search?category=construction",
    start_date: "2026-09-14",
    end_date: "2026-09-20",
  },
  {
    name: "Safety Month",
    discount_label: "Annual Safety Drive · Bulk savings",
    description:
      "October is Safety Month. Stock up on the full PPE range with tiered bulk discounts and free delivery over KES 20,000.",
    cta_href: "/deals",
    start_date: "2026-10-01",
    end_date: "2026-10-31",
  },
  {
    name: "Hospital Supplies Week",
    discount_label: "Medical Grade · Up to 15% off",
    description:
      "Examination gloves, surgical masks, isolation gowns and dispensers at special hospital-supply rates for institutions.",
    cta_href: "/search?category=medical",
    start_date: "2026-11-09",
    end_date: "2026-11-15",
  },
  {
    name: "Black Friday",
    discount_label: "Mega Sale · Up to 40% off",
    description:
      "Our biggest sale of the year — deep discounts across PPE, fire safety, medical and first aid. While stocks last.",
    cta_href: "/deals",
    start_date: "2026-11-26",
    end_date: "2026-11-29",
  },
  {
    name: "Christmas Sale",
    discount_label: "Festive Deals · Up to 30% off",
    description:
      "Wrap up the year with festive pricing on safety kits, gifting bundles and end-of-year site restocks.",
    cta_href: "/deals",
    start_date: "2026-12-01",
    end_date: "2026-12-24",
  },
];

export async function seedMarketing() {
  const d = getDb();
  const now = new Date().toISOString();
  const bannerCount = (await d.query("SELECT COUNT(*)::int AS c FROM marketing_banners")).rows[0] as { c: number };
  if (bannerCount.c === 0) {
    for (let i = 0; i < SEED_BANNERS.length; i++) {
      const b = SEED_BANNERS[i];
      await d.query(
        "INSERT INTO marketing_banners (title, subtitle, kicker, cta, cta_href, cta2, image, card_kicker, card_title, card_subtitle, sort, active, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$13)",
        [b.title, b.subtitle, b.kicker, b.cta, b.cta_href, b.cta2, b.image, b.card_kicker, b.card_title, b.card_subtitle, i, now, now]
      );
    }
    console.log("[kimsafety] Seeded marketing banners");
  }
  await d.query(
    "UPDATE marketing_banners SET card_kicker = 'KimSafety', card_title = 'Your Trusted Safety Partner', card_subtitle = 'Genuine & certified PPE, delivered nationwide within 24–72 hours.' WHERE card_title = ''"
  );
  const campaignCount = (await d.query("SELECT COUNT(*)::int AS c FROM marketing_campaigns")).rows[0] as { c: number };
  if (campaignCount.c === 0) {
    for (const c of SEED_CAMPAIGNS) {
      await d.query(
        "INSERT INTO marketing_campaigns (name, slug, description, discount_label, cta_href, start_date, end_date, active, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9)",
        [c.name, c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), c.description, c.discount_label, c.cta_href, c.start_date, c.end_date, now, now]
      );
    }
    console.log("[kimsafety] Seeded marketing campaigns");
  }
  const CAMPAIGN_IMAGE_BY_KEYWORD: [string, string][] = [
    ["back-to-school", "3-Ply Face Masks.jpg"],
    ["construction", "Construction Helmets.jpg"],
    ["safety", "2Kg CO2 Fire Extinguisher.jpg"],
    ["hospital", "Powder Free Disposable Latex Gloves.jpg"],
    ["black", "Reflector Jackets.jpg"],
    ["christmas", "Designer Orange Reflector Jackets.jpg"],
  ];
  const FALLBACK_CAMPAIGN_IMAGE = "2 Stripes Reflective Vest AA12.jpg";
  const campaigns = (await d.query("SELECT id, slug FROM marketing_campaigns WHERE image IS NULL")).rows as {
    id: number;
    slug: string;
  }[];
  for (const c of campaigns) {
    const match = CAMPAIGN_IMAGE_BY_KEYWORD.find(([kw]) => c.slug.includes(kw));
    const file = match?.[1] ?? FALLBACK_CAMPAIGN_IMAGE;
    await d.query("UPDATE marketing_campaigns SET image = $1, updated_at = $2 WHERE id = $3", [
      `/api/uploads/${encodeURIComponent(file)}`,
      now,
      c.id,
    ]);
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function rowToUser(row: DbUser) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    company: row.company,
    phone: row.phone,
    created_at: row.created_at,
  };
}

// ---- Users ----

export async function getUserByEmail(email: string): Promise<DbUser | undefined> {  return (await q1("SELECT * FROM users WHERE email = ?", email)) as DbUser | undefined;
}

export async function getUserById(id: string): Promise<DbUser | undefined> {  return (await q1("SELECT * FROM users WHERE id = ?", id)) as DbUser | undefined;
}

export async function createUser(input: { name: string; email: string; password: string; company?: string; phone?: string; role?: "user" | "admin"; verified?: number; referred_by?: string | null }): Promise<DbUser> {  const user: DbUser = {
    id: randomUUID(),
    name: input.name,
    email: input.email.toLowerCase(),
    password_hash: hashPassword(input.password),
    role: input.role ?? "user",
    company: input.company ?? null,
    phone: input.phone ?? null,
    verified: input.verified ?? 1,
    referral_code: null,
    referred_by: input.referred_by ?? null,
    created_at: new Date().toISOString(),
  };
  // Generate a short, unique referral code (retry on the vanishing chance of a collision).
  const initials = user.name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = attempt === 0 ? `KS-${Math.floor(1000 + Math.random() * 8999)}${initials}` : `KS-${Math.floor(10000 + Math.random() * 89999)}`;
    const clash = await q1("SELECT id FROM users WHERE referral_code = ?", code);
    if (!clash) {
      user.referral_code = code;
      break;
    }
  }
  await qe("INSERT INTO users (id, name, email, password_hash, role, company, phone, verified, referral_code, referred_by, created_at) VALUES (@id, @name, @email, @password_hash, @role, @company, @phone, @verified, @referral_code, @referred_by, @created_at)", user);
  return user;
}

/**
 * Attaches all of a user's guest orders (placed with the same email before the
 * account existed) so order history is not lost when they register.
 */
export async function attachGuestOrdersToUser(userId: string, email: string) {
  await qe("UPDATE orders SET user_id = ? WHERE email = ? AND user_id IS NULL", userId, email.toLowerCase());
}

export async function listUsers(): Promise<DbUser[]> {  return (await qr("SELECT * FROM users ORDER BY created_at DESC")) as DbUser[];
}

export async function setUserRole(id: string, role: "user" | "admin" | "superadmin") {
  await qe("UPDATE users SET role = ? WHERE id = ?", role, id);
}

export async function setUserVerified(id: string, verified: number) {
  await qe("UPDATE users SET verified = ? WHERE id = ?", verified, id);
}

export async function setUserPassword(id: string, password: string) {
  await qe("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(password), id);
}

export async function updateUserProfile(id: string, input: { name?: string; email?: string; phone?: string | null; company?: string | null }) {
  const existing = await getUserById(id);
  if (!existing) return undefined;
  const updated = {
    ...existing,
    name: input.name ?? existing.name,
    email: (input.email ?? existing.email).toLowerCase(),
    phone: input.phone === undefined ? existing.phone : input.phone,
    company: input.company === undefined ? existing.company : input.company,
  };
  await qe("UPDATE users SET name = @name, email = @email, phone = @phone, company = @company WHERE id = @id", updated);
  return updated;
}

export async function deleteUser(id: string) {
  await qe("DELETE FROM users WHERE id = ?", id);
}

function randomTempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/**
 * Ensures a login exists for the given email. If an account already exists the
 * existing user is linked; otherwise a verified customer login is created with
 * a temporary password (returned to the caller so it can be shared securely).
 */
export async function provisionUserLogin(input: {
  name: string;
  email: string;
  phone?: string | null;
  company?: string | null;
  password?: string;
}): Promise<{ user_id: string; createdLogin: boolean; tempPassword?: string }> {
  const existing = await getUserByEmail(input.email.toLowerCase());
  if (existing) return { user_id: existing.id, createdLogin: false };
  const tempPassword = input.password ?? randomTempPassword();
  const user = await createUser({
    name: input.name,
    email: input.email,
    password: tempPassword,
    phone: input.phone ?? undefined,
    company: input.company ?? undefined,
    role: "user",
    verified: 1,
  });
  return { user_id: user.id, createdLogin: true, tempPassword };
}

// ---- Orders ----

export async function createOrder(input: { user_id?: string | null; name: string; email: string; phone: string; address: string; items: string; total: number; subtotal?: number; discount?: number; shipping?: number; payment: string; po_ref?: string; company?: string; po_file?: string; payment_phone?: string | null; payment_token?: string | null; referrer_code?: string | null }): Promise<DbOrder> {
  let orderId = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const cand = `KS-${randomBytes(3).toString("hex").toUpperCase()}`;
    const clash = await q1("SELECT id FROM orders WHERE id = ?", cand).catch(() => undefined);
    if (!clash) { orderId = cand; break; }
  }
  if (!orderId) orderId = `KS-${randomUUID().slice(0, 8).toUpperCase()}`;
  const order: DbOrder = {
    id: orderId,
    user_id: input.user_id ?? null,
    name: input.name,
    email: input.email,
    phone: input.phone,
    address: input.address,
    items: input.items,
    total: input.total,
    subtotal: input.subtotal ?? input.total,
    discount: input.discount ?? 0,
    shipping: input.shipping ?? 0,
    status: "Processing",
    payment: input.payment,
    // Every order starts unpaid — M-Pesa (STK callback), Paystack (webhook/verify)
    // or an admin flips it to paid once the money is actually received.
    paid: 0,
    po_ref: input.po_ref ?? null,
    company: input.company ?? null,
    po_file: input.po_file ?? null,
    payment_phone: input.payment_phone ?? null,
    mpesa_checkout_id: null,
    mpesa_merchant_id: null,
    mpesa_push_count: 0,
    mpesa_pushed_at: null,
    mpesa_last_result: null,
    mpesa_last_result_desc: null,
    mpesa_transaction_id: null,
    paystack_reference: null,
    paystack_transaction_id: null,
    payment_token: input.payment_token ?? null,
    referrer_code: input.referrer_code ?? null,
    delivery_note_file: null,
    kra_invoice_file: null,
    delivered_by: null,
    delivered_by_name: null,
    delivered_at: null,
    created_at: new Date().toISOString(),
  };
  await qe("INSERT INTO orders (id, user_id, name, email, phone, address, items, total, subtotal, discount, shipping, status, payment, paid, po_ref, company, po_file, payment_phone, mpesa_checkout_id, mpesa_merchant_id, paystack_reference, paystack_transaction_id, payment_token, referrer_code, delivery_note_file, kra_invoice_file, delivered_by, delivered_by_name, delivered_at, created_at) VALUES (@id, @user_id, @name, @email, @phone, @address, @items, @total, @subtotal, @discount, @shipping, @status, @payment, @paid, @po_ref, @company, @po_file, @payment_phone, @mpesa_checkout_id, @mpesa_merchant_id, @paystack_reference, @paystack_transaction_id, @payment_token, @referrer_code, @delivery_note_file, @kra_invoice_file, @delivered_by, @delivered_by_name, @delivered_at, @created_at)", order);
  return order;
}

export async function getOrderById(id: string): Promise<DbOrder | undefined> {  return (await q1("SELECT * FROM orders WHERE id = ?", id)) as DbOrder | undefined;
}

export async function setOrderPaid(id: string, paid: number) {
  await qe("UPDATE orders SET paid = ? WHERE id = ?", paid, id);
}

export async function setMpesaCheckout(id: string, checkoutId: string, merchantId: string) {
  await qe("UPDATE orders SET mpesa_checkout_id = ?, mpesa_merchant_id = ? WHERE id = ?", checkoutId, merchantId, id);
}

export async function recordMpesaPushAttempt(id: string) {
  await qe(
    "UPDATE orders SET mpesa_push_count = COALESCE(mpesa_push_count, 0) + 1, mpesa_pushed_at = ? WHERE id = ?",
    new Date().toISOString(),
    id
  );
}

export async function recordMpesaResult(id: string, code: string, desc: string) {
  await qe("UPDATE orders SET mpesa_last_result = ?, mpesa_last_result_desc = ? WHERE id = ?", code, desc, id);
}

export async function setMpesaTransaction(id: string, receipt: string) {
  await qe("UPDATE orders SET mpesa_transaction_id = ? WHERE id = ?", receipt, id);
}

export async function setPaystackReference(id: string, reference: string) {
  await qe("UPDATE orders SET paystack_reference = ? WHERE id = ?", reference, id);
}

/** The transaction ID Paystack itself assigned (data.id) — captured on success. */
export async function setPaystackTransaction(id: string, transactionId: string) {
  await qe("UPDATE orders SET paystack_transaction_id = ? WHERE id = ?", transactionId, id);
}

export async function getOrderByMpesaCheckout(checkoutId: string): Promise<DbOrder | undefined> {
  return (await q1("SELECT * FROM orders WHERE mpesa_checkout_id = ?", checkoutId)) as DbOrder | undefined;
}

export async function getOrderByPaystackReference(reference: string): Promise<DbOrder | undefined> {
  return (await q1("SELECT * FROM orders WHERE paystack_reference = ?", reference)) as DbOrder | undefined;
}

export async function listOrders(): Promise<DbOrder[]> {  return (await qr("SELECT * FROM orders ORDER BY created_at DESC")) as DbOrder[];
}

export async function listOrdersCreatedBetween(from: string, to: string): Promise<DbOrder[]> {  return (await qr("SELECT * FROM orders WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC", from, to)) as DbOrder[];
}

export async function ordersForUser(userId: string): Promise<DbOrder[]> {  return (await qr("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC", userId)) as DbOrder[];
}

export async function setOrderStatus(id: string, status: string) {
  await qe("UPDATE orders SET status = ? WHERE id = ?", status, id);
}

export async function setOrderDeliveryNote(id: string, filePath: string) {
  await qe("UPDATE orders SET delivery_note_file = ? WHERE id = ?", filePath, id);
}

export async function setOrderKraInvoice(id: string, filePath: string) {
  await qe("UPDATE orders SET kra_invoice_file = ? WHERE id = ?", filePath, id);
}

export async function setOrderDelivered(id: string, deliveredBy: string, deliveredByName: string) {
  await qe("UPDATE orders SET status = 'Delivered', delivered_by = ?, delivered_by_name = ?, delivered_at = ? WHERE id = ?", deliveredBy, deliveredByName, new Date().toISOString(), id);
}

// ---- Quotes ----

export async function createQuote(input: {
  user_id?: string | null;
  name: string;
  company?: string | null;
  items: string;
  total: number;
  attachment?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  valid_until?: string | null;
  created_by_id?: string | null;
  created_by_name?: string | null;
}): Promise<DbQuote> {
  let quoteId = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const cand = `QUO-${randomBytes(3).toString("hex").toUpperCase()}`;
    const clash = await q1("SELECT id FROM quotes WHERE id = ?", cand).catch(() => undefined);
    if (!clash) { quoteId = cand; break; }
  }
  if (!quoteId) quoteId = `QUO-${randomUUID().slice(0, 8).toUpperCase()}`;
  const quote: DbQuote = {
    id: quoteId,
    user_id: input.user_id ?? null,
    name: input.name,
    company: input.company ?? null,
    items: input.items,
    total: input.total,
    status: "Open",
    attachment: input.attachment ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    notes: input.notes ?? null,
    valid_until: input.valid_until ?? null,
    created_by_id: input.created_by_id ?? null,
    created_by_name: input.created_by_name ?? null,
    created_at: new Date().toISOString(),
  };
  await qe("INSERT INTO quotes (id, user_id, name, company, items, total, status, attachment, email, phone, notes, valid_until, created_by_id, created_by_name, created_at) VALUES (@id, @user_id, @name, @company, @items, @total, @status, @attachment, @email, @phone, @notes, @valid_until, @created_by_id, @created_by_name, @created_at)", quote);
  return quote;
}

export async function deleteQuote(id: string) {
  await qe("DELETE FROM quotes WHERE id = ?", id);
}

export async function getQuoteById(id: string): Promise<DbQuote | undefined> {  return (await q1("SELECT * FROM quotes WHERE id = ?", id)) as DbQuote | undefined;
}

export async function listQuotes(): Promise<DbQuote[]> {  return (await qr("SELECT * FROM quotes ORDER BY created_at DESC")) as DbQuote[];
}

export async function quotesForUser(userId: string): Promise<DbQuote[]> {  return (await qr("SELECT * FROM quotes WHERE user_id = ? ORDER BY created_at DESC", userId)) as DbQuote[];
}

export async function setQuoteStatus(id: string, status: string) {
  await qe("UPDATE quotes SET status = ? WHERE id = ?", status, id);
}

// ---- Site settings ----

export async function getSetting(key: string): Promise<string> {
  const all = await getAllSettings();
  return all[key] ?? DEFAULT_SETTINGS[key] ?? "";
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.data;
  try {
    const rows = (await qr("SELECT key, value FROM settings")) as { key: string; value: string }[];
    const out: Record<string, string> = { ...DEFAULT_SETTINGS };
    for (const r of rows) out[r.key] = r.value;
    settingsCache = { at: now, data: out };
    return out;
  } catch (err) {
    // On 53300 (too many connections) serve stale cache or defaults instead of 500.
    // The route handler already expects this — it stringifies 500s into retries.
    if (settingsCache) return settingsCache.data;
    if (isTooManyConnections(err)) {
      console.warn("[db] getAllSettings fallback to DEFAULT_SETTINGS due to too many connections");
      return { ...DEFAULT_SETTINGS };
    }
    throw err;
  }
}

const SETTINGS_TTL_MS = 60 * 1000;
let settingsCache: { at: number; data: Record<string, string> } | null = null;

export function invalidateSettingsCache() {
  settingsCache = null;
}

/**
 * Monotonic version of the settings table (max updated_at). Exposed through
 * /api/settings and used as a cache-busting query param on branding assets —
 * when the admin changes the logo, every client fetches a NEW url instead of
 * serving its cached copy.
 */
export async function getSettingsVersion(): Promise<string> {
  try {
    const row = (await q1("SELECT MAX(updated_at) AS v FROM settings")) as { v: string | null } | undefined;
    return row?.v ?? "0";
  } catch {
    return "0";
  }
}

// Consolidated fetch for /api/settings — uses a single pooled client so the
// two SELECTs don't occupy two connections concurrently. Falls back to cache
// on 53300.
export async function getSettingsWithVersion(): Promise<{ settings: Record<string, string>; version: string }> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.at < SETTINGS_TTL_MS) {
    try {
      const vRow = (await q1("SELECT MAX(updated_at) AS v FROM settings")) as { v: string | null } | undefined;
      return { settings: settingsCache.data, version: vRow?.v ?? "0" };
    } catch {
      return { settings: settingsCache.data, version: "0" };
    }
  }
  // Use a single client for both queries to avoid 2 concurrent connections.
  let client: import("pg").PoolClient | null = null;
  try {
    client = await getDb().connect();
    const [sRes, vRes] = await Promise.all([
      client.query("SELECT key, value FROM settings"),
      client.query("SELECT MAX(updated_at) AS v FROM settings"),
    ]);
    const out: Record<string, string> = { ...DEFAULT_SETTINGS };
    for (const r of (sRes.rows as { key: string; value: string }[])) out[r.key] = r.value;
    settingsCache = { at: now, data: out };
    const version = (vRes.rows[0] as { v: string | null })?.v ?? "0";
    return { settings: out, version };
  } catch (err) {
    if (settingsCache) return { settings: settingsCache.data, version: "0" };
    if (isTooManyConnections(err)) {
      console.warn("[db] getSettingsWithVersion fallback due to too many connections");
      return { settings: { ...DEFAULT_SETTINGS }, version: "0" };
    }
    throw err;
  } finally {
    if (client) client.release();
  }
}

// Single-query nav badges — replaces 6 parallel COUNT(*) queries with one round-trip.
// Critical for 53300: 6× Promise.all held 2 connections + queue depth per request.
export async function getNavBadgeCounts(): Promise<{ orders: number; tickets: number; quotes: number; returns: number; questions: number; messages: number }> {
  try {
    const row = (await q1<{
      orders: number;
      tickets: number;
      quotes: number;
      returns: number;
      questions: number;
      messages: number;
    }>(`
      SELECT
        (SELECT COUNT(*)::int FROM orders WHERE status = 'Processing') AS orders,
        (SELECT COUNT(*)::int FROM support_tickets WHERE status = 'Open') AS tickets,
        (SELECT COUNT(*)::int FROM quotes WHERE status = 'Pending') AS quotes,
        (SELECT COUNT(*)::int FROM returns WHERE status = 'Requested') AS returns,
        (SELECT COUNT(*)::int FROM product_questions WHERE answer IS NULL) AS questions,
        (SELECT COUNT(*)::int FROM contact_messages) AS messages
    `)) as { orders: number; tickets: number; quotes: number; returns: number; questions: number; messages: number } | undefined;
    return {
      orders: row?.orders ?? 0,
      tickets: row?.tickets ?? 0,
      quotes: row?.quotes ?? 0,
      returns: row?.returns ?? 0,
      questions: row?.questions ?? 0,
      messages: row?.messages ?? 0,
    };
  } catch (err) {
    if (isTooManyConnections(err)) {
      console.warn("[db] getNavBadgeCounts fallback to zeros due to too many connections");
      return { orders: 0, tickets: 0, quotes: 0, returns: 0, questions: 0, messages: 0 };
    }
    throw err;
  }
}

export async function setSetting(key: string, value: string) {
  const now = new Date().toISOString();
  await qe("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", key, value, now);
  invalidateSettingsCache();
}

// ---- Featured categories (homepage "Featured Categories" grid) ----

export type FeaturedCategory = {
  name: string;
  caption: string;
  image: string;
  category: string;
  sort: number;
};

const DEFAULT_FEATURED_CATEGORIES: FeaturedCategory[] = [
  { name: "Helmets", caption: "Construction Helmets", image: "/images/products/Construction%20Helmets.jpg", category: "construction-safety", sort: 0 },
  { name: "Gloves", caption: "Assorted Industrial Gloves", image: "/images/products/Assorted%20Industrial%20Gloves.jpg", category: "ppe", sort: 1 },
  { name: "Safety Boots", caption: "Hiview Safety Boot", image: "/images/products/HIVIEW%20SAFETY%20BOOT%20HTS4101.jpeg", category: "industrial-safety", sort: 2 },
  { name: "Reflective Jackets", caption: "Reflector Jackets", image: "/images/products/Reflector%20Jackets.png", category: "road-safety", sort: 3 },
  { name: "Respirators", caption: "Double Respirator Mask", image: "/images/products/Double%20Respirator%20Mask%20(NP306).jpg", category: "ppe", sort: 4 },
  { name: "First Aid Kits", caption: "Medium First Aid Kit", image: "/images/products/Medium%20Clear%20First%20Aid%20Kit.jpg", category: "emergency-response", sort: 5 },
  { name: "Fire Extinguishers", caption: "6kg Dry Powder Extinguisher", image: "/images/products/6KG%20DRY%20POWDER%20FIRE%20EXTINGUISHER.jpg", category: "fire-safety", sort: 6 },
  { name: "Ladders", caption: "Multipurpose Aluminium Ladder", image: "/images/products/12%20STEP%20RED%20EDITION%20MULTIPURPOSE%20ALUMINIUM%20LADDER%203.7M.jpg", category: "tools", sort: 7 },
  { name: "Medical Gloves", caption: "Medical Exam Gloves", image: "/images/products/Latex%20Powdered%20Medical%20Examination%20Gloves.jpg", category: "medical-safety", sort: 8 },
  { name: "Stretchers", caption: "Folding Canvas Stretcher", image: "/images/products/Folding%20Canvas%20Stretcher.jpg", category: "emergency-response", sort: 9 },
  { name: "Safety Goggles", caption: "Protecta Safety Goggles", image: "/images/products/PROTECTA%20CHEMICAL%20SAFETY%20GOGGLES.jpg", category: "industrial-safety", sort: 10 },
  { name: "Ear Protection", caption: "Krickwood Ear Muffs", image: "/images/products/KRICKWOOD%20EAR%20MUFFS.jpg", category: "ppe", sort: 11 },
];

export async function getFeaturedCategories(): Promise<FeaturedCategory[]> {
  const raw = await getSetting("featured_categories");
  if (!raw) return DEFAULT_FEATURED_CATEGORIES;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_FEATURED_CATEGORIES;
    return parsed
      .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
      .map((i, idx) => ({
        name: typeof i.name === "string" && i.name.trim() ? i.name : `Category ${idx + 1}`,
        caption: typeof i.caption === "string" ? i.caption : "",
        image: typeof i.image === "string" ? i.image : "",
        category: typeof i.category === "string" ? i.category : "",
        sort: typeof i.sort === "number" ? i.sort : idx,
      }));
  } catch {
    return DEFAULT_FEATURED_CATEGORIES;
  }
}

export async function saveFeaturedCategories(items: FeaturedCategory[]) {
  await setSetting(
    "featured_categories",
    JSON.stringify(items.map((i, idx) => ({ name: i.name, caption: i.caption, image: i.image, category: i.category, sort: idx })))
  );
}

// ---- Letters ----

export type DbLetter = {
  id: string;
  type: string;
  recipient_name: string;
  recipient_title: string | null;
  recipient_company: string | null;
  recipient_address: string | null;
  subject: string;
  salutation: string;
  body: string;
  closing: string;
  sender_name: string;
  sender_title: string | null;
  with_stamp: number;
  created_by: string;
  created_by_id: string | null;
  created_at: string;
};

const normalizeLetterSubject = (s?: string) => (s ?? "").trim().toUpperCase();

export async function createLetter(input: {
  type?: string;
  recipient_name: string;
  recipient_title?: string | null;
  recipient_company?: string | null;
  recipient_address?: string | null;
  subject?: string;
  salutation?: string;
  body: string;
  closing?: string;
  sender_name: string;
  sender_title?: string | null;
  with_stamp?: boolean;
  created_by: string;
  created_by_id?: string | null;
}): Promise<DbLetter> {  const letter: DbLetter = {
    id: `LTR-${Math.floor(1000 + Math.random() * 9000)}`,
    type: input.type?.trim() || "Official Letter",
    recipient_name: input.recipient_name,
    recipient_title: input.recipient_title?.trim() || null,
    recipient_company: input.recipient_company?.trim() || null,
    recipient_address: input.recipient_address?.trim() || null,
    subject: normalizeLetterSubject(input.subject),
    salutation: input.salutation?.trim() || "Dear Sir/Madam",
    body: input.body.trim(),
    closing: input.closing?.trim() || "Yours faithfully",
    sender_name: input.sender_name,
    sender_title: input.sender_title?.trim() || null,
    with_stamp: input.with_stamp === true ? 1 : 0,
    created_by: input.created_by,
    created_by_id: input.created_by_id ?? null,
    created_at: new Date().toISOString(),
  };
  await qe("INSERT INTO letters (id, type, recipient_name, recipient_title, recipient_company, recipient_address, subject, salutation, body, closing, sender_name, sender_title, with_stamp, created_by, created_by_id, created_at) VALUES (@id, @type, @recipient_name, @recipient_title, @recipient_company, @recipient_address, @subject, @salutation, @body, @closing, @sender_name, @sender_title, @with_stamp, @created_by, @created_by_id, @created_at)", letter);
  return letter;
}

export async function updateLetter(
  id: string,
  input: {
    type?: string;
    recipient_name?: string;
    recipient_title?: string | null;
    recipient_company?: string | null;
    recipient_address?: string | null;
    subject?: string;
    salutation?: string;
    body?: string;
    closing?: string;
    sender_name?: string;
    sender_title?: string | null;
    with_stamp?: boolean;
  }
): Promise<DbLetter> {  const existing = await getLetterById(id);
  if (!existing) throw new Error("Letter not found");
  const letter: DbLetter = {
    ...existing,
    type: input.type?.trim() || existing.type,
    recipient_name: input.recipient_name?.trim() || existing.recipient_name,
    recipient_title: input.recipient_title === undefined ? existing.recipient_title : input.recipient_title?.trim() || null,
    recipient_company: input.recipient_company === undefined ? existing.recipient_company : input.recipient_company?.trim() || null,
    recipient_address: input.recipient_address === undefined ? existing.recipient_address : input.recipient_address?.trim() || null,
    subject: input.subject === undefined ? existing.subject : normalizeLetterSubject(input.subject),
    salutation: input.salutation?.trim() || existing.salutation,
    body: input.body === undefined ? existing.body : input.body.trim(),
    closing: input.closing?.trim() || existing.closing,
    sender_name: input.sender_name?.trim() || existing.sender_name,
    sender_title: input.sender_title === undefined ? existing.sender_title : input.sender_title?.trim() || null,
    with_stamp: input.with_stamp === undefined ? existing.with_stamp : input.with_stamp ? 1 : 0,
  };
  await qe("UPDATE letters SET type=@type, recipient_name=@recipient_name, recipient_title=@recipient_title, recipient_company=@recipient_company, recipient_address=@recipient_address, subject=@subject, salutation=@salutation, body=@body, closing=@closing, sender_name=@sender_name, sender_title=@sender_title, with_stamp=@with_stamp WHERE id=@id", letter);
  return letter;
}

export async function getLetterById(id: string): Promise<DbLetter | undefined> {  return (await q1("SELECT * FROM letters WHERE id = ?", id)) as DbLetter | undefined;
}

export async function listLetters(): Promise<DbLetter[]> {  return (await qr("SELECT * FROM letters ORDER BY created_at DESC")) as DbLetter[];
}

export async function listLettersFor(userId: string): Promise<DbLetter[]> {  return (await qr("SELECT * FROM letters WHERE created_by_id = ? ORDER BY created_at DESC", userId)) as DbLetter[];
}

export async function deleteLetter(id: string) {
  await qe("DELETE FROM letters WHERE id = ?", id);
}

// ---- Corporate account applications ----

export async function createCorporateApplication(input: {
  company: string;
  kra_pin: string;
  industry: string;
  contact_name: string;
  phone: string;
  email: string;
  notes?: string | null;
  documents?: string[];
}): Promise<DbCorporateApplication> {  const app: DbCorporateApplication = {
    id: `CORP-${Math.floor(1000 + Math.random() * 9000)}`,
    company: input.company,
    kra_pin: input.kra_pin,
    industry: input.industry,
    contact_name: input.contact_name,
    phone: input.phone,
    email: input.email,
    notes: input.notes ?? null,
    documents: JSON.stringify(input.documents ?? []),
    status: "Pending",
    handled_by: null,
    handled_by_name: null,
    created_at: new Date().toISOString(),
  };
  await qe("INSERT INTO corporate_applications (id, company, kra_pin, industry, contact_name, phone, email, notes, documents, status, handled_by, handled_by_name, created_at) VALUES (@id, @company, @kra_pin, @industry, @contact_name, @phone, @email, @notes, @documents, @status, @handled_by, @handled_by_name, @created_at)", app);
  return app;
}

export async function listCorporateApplications(): Promise<DbCorporateApplication[]> {  return (await qr("SELECT * FROM corporate_applications ORDER BY created_at DESC")) as DbCorporateApplication[];
}

export async function setCorporateApplicationStatus(id: string, status: string, handledBy?: string | null, handledByName?: string | null) {
  if (handledBy !== undefined) {
    await qe("UPDATE corporate_applications SET status = ?, handled_by = ?, handled_by_name = ? WHERE id = ?", status, handledBy, handledByName, id);
  } else {
    await qe("UPDATE corporate_applications SET status = ? WHERE id = ?", status, id);
  }
}

// ---- Corporate accounts (configured by the superadmin) ----

export type DbCorporateAccount = {
  id: string;
  user_id: string | null;
  application_id: string | null;
  company: string;
  kra_pin: string | null;
  industry: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  discount_rate: number;
  credit_terms: string;
  account_manager: string | null;
  notes: string | null;
  status: string;
  created_by_id: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
};

export async function createCorporateAccount(input: {
  user_id?: string | null;
  application_id?: string | null;
  company: string;
  kra_pin?: string | null;
  industry?: string | null;
  contact_name?: string | null;
  phone?: string | null;
  email?: string | null;
  discount_rate?: number;
  credit_terms?: string;
  account_manager?: string | null;
  notes?: string | null;
  status?: string;
  created_by_id?: string | null;
  created_by_name?: string | null;
}): Promise<DbCorporateAccount> {  const now = new Date().toISOString();
  const account: DbCorporateAccount = {
    id: `ACC-${Math.floor(1000 + Math.random() * 9000)}`,
    user_id: input.user_id ?? null,
    application_id: input.application_id ?? null,
    company: input.company,
    kra_pin: input.kra_pin ?? null,
    industry: input.industry ?? null,
    contact_name: input.contact_name ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    discount_rate: Math.max(0, Math.min(100, Math.round(input.discount_rate ?? 0))),
    credit_terms: input.credit_terms ?? "30 days",
    account_manager: input.account_manager ?? null,
    notes: input.notes ?? null,
    status: input.status ?? "Active",
    created_by_id: input.created_by_id ?? null,
    created_by_name: input.created_by_name ?? null,
    created_at: now,
    updated_at: now,
  };
  await qe("INSERT INTO corporate_accounts (id, user_id, application_id, company, kra_pin, industry, contact_name, phone, email, discount_rate, credit_terms, account_manager, notes, status, created_by_id, created_by_name, created_at, updated_at) VALUES (@id, @user_id, @application_id, @company, @kra_pin, @industry, @contact_name, @phone, @email, @discount_rate, @credit_terms, @account_manager, @notes, @status, @created_by_id, @created_by_name, @created_at, @updated_at)", account);
  return account;
}

export async function listCorporateAccounts(): Promise<DbCorporateAccount[]> {  return (await qr("SELECT * FROM corporate_accounts ORDER BY created_at DESC")) as DbCorporateAccount[];
}

export async function getCorporateAccountById(id: string): Promise<DbCorporateAccount | undefined> {  return (await q1("SELECT * FROM corporate_accounts WHERE id = ?", id)) as DbCorporateAccount | undefined;
}

export async function getCorporateAccountByApplicationId(applicationId: string): Promise<DbCorporateAccount | undefined> {  return (await q1("SELECT * FROM corporate_accounts WHERE application_id = ?", applicationId)) as DbCorporateAccount | undefined;
}

export async function getCorporateAccountByUserId(userId: string): Promise<DbCorporateAccount | undefined> {  return (await q1("SELECT * FROM corporate_accounts WHERE user_id = ?", userId)) as DbCorporateAccount | undefined;
}

export async function getCorporateAccountByEmail(email: string): Promise<DbCorporateAccount | undefined> {  return (await q1("SELECT * FROM corporate_accounts WHERE LOWER(email) = LOWER(?) LIMIT 1", email)) as DbCorporateAccount | undefined;
}

export async function updateCorporateAccount(
  id: string,
  input: Partial<{
    company: string;
    kra_pin: string | null;
    industry: string | null;
    contact_name: string | null;
    phone: string | null;
    email: string | null;
    discount_rate: number;
    credit_terms: string;
    account_manager: string | null;
    notes: string | null;
    status: string;
    user_id: string | null;
  }>
): Promise<DbCorporateAccount | undefined> {  const existing = await getCorporateAccountById(id);
  if (!existing) return undefined;
  const updated: DbCorporateAccount = {
    ...existing,
    company: input.company ?? existing.company,
    kra_pin: input.kra_pin === undefined ? existing.kra_pin : input.kra_pin,
    industry: input.industry === undefined ? existing.industry : input.industry,
    contact_name: input.contact_name === undefined ? existing.contact_name : input.contact_name,
    phone: input.phone === undefined ? existing.phone : input.phone,
    email: input.email === undefined ? existing.email : input.email,
    discount_rate: input.discount_rate === undefined ? existing.discount_rate : Math.max(0, Math.min(100, Math.round(input.discount_rate))),
    credit_terms: input.credit_terms ?? existing.credit_terms,
    account_manager: input.account_manager === undefined ? existing.account_manager : input.account_manager,
    notes: input.notes === undefined ? existing.notes : input.notes,
    status: input.status ?? existing.status,
    user_id: input.user_id === undefined ? existing.user_id : input.user_id,
    updated_at: new Date().toISOString(),
  };
  await qe("UPDATE corporate_accounts SET user_id=@user_id, company=@company, kra_pin=@kra_pin, industry=@industry, contact_name=@contact_name, phone=@phone, email=@email, discount_rate=@discount_rate, credit_terms=@credit_terms, account_manager=@account_manager, notes=@notes, status=@status, updated_at=@updated_at WHERE id=@id", updated);
  return updated;
}

export async function deleteCorporateAccount(id: string) {
  await qe("DELETE FROM corporate_accounts WHERE id = ?", id);
}

// ---- Purchase orders ----

export async function createPurchaseOrder(input: {
  company: string;
  contact_name?: string | null;
  phone?: string | null;
  email?: string | null;
  po_file: string;
  created_by_id?: string | null;
  created_by_name?: string | null;
}): Promise<DbPurchaseOrder> {  const po: DbPurchaseOrder = {
    id: `PO-${Math.floor(1000 + Math.random() * 9000)}`,
    company: input.company,
    contact_name: input.contact_name ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    po_file: input.po_file,
    status: "Pending",
    created_by_id: input.created_by_id ?? null,
    created_by_name: input.created_by_name ?? null,
    created_at: new Date().toISOString(),
  };
  await qe("INSERT INTO purchase_orders (id, company, contact_name, phone, email, po_file, status, created_by_id, created_by_name, created_at) VALUES (@id, @company, @contact_name, @phone, @email, @po_file, @status, @created_by_id, @created_by_name, @created_at)", po);
  return po;
}

export async function listPurchaseOrders(): Promise<DbPurchaseOrder[]> {  return (await qr("SELECT * FROM purchase_orders ORDER BY created_at DESC")) as DbPurchaseOrder[];
}

export async function setPurchaseOrderStatus(id: string, status: string) {
  await qe("UPDATE purchase_orders SET status = ? WHERE id = ?", status, id);
}

// ---- Supplier purchase orders (KimSafety buys stock from suppliers) ----

export async function createSupplierOrder(input: {
  supplier: string;
  contact_name?: string | null;
  phone?: string | null;
  email?: string | null;
  items: SupplierOrderItem[];
  shipping?: number;
  expected_date?: string | null;
  notes?: string | null;
  created_by_id?: string | null;
  created_by_name?: string | null;
}): Promise<DbSupplierOrder> {  const subtotal = Math.round(
    input.items.reduce((sum, i) => sum + (i.qty || 0) * (i.unitPrice || 0), 0)
  );
  const shipping = Math.round(input.shipping ?? 0);
  const po: DbSupplierOrder = {
    id: `SPO-${Math.floor(1000 + Math.random() * 9000)}`,
    supplier: input.supplier,
    contact_name: input.contact_name ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    items: JSON.stringify(input.items),
    subtotal,
    shipping,
    total: subtotal + shipping,
    expected_date: input.expected_date ?? null,
    notes: input.notes ?? null,
    status: "Draft",
    created_by_id: input.created_by_id ?? null,
    created_by_name: input.created_by_name ?? null,
    created_at: new Date().toISOString(),
  };
  await qe("INSERT INTO supplier_orders (id, supplier, contact_name, phone, email, items, subtotal, shipping, total, expected_date, notes, status, created_by_id, created_by_name, created_at) VALUES (@id, @supplier, @contact_name, @phone, @email, @items, @subtotal, @shipping, @total, @expected_date, @notes, @status, @created_by_id, @created_by_name, @created_at)", po);
  return po;
}

export async function listSupplierOrders(): Promise<DbSupplierOrder[]> {  return (await qr("SELECT * FROM supplier_orders ORDER BY created_at DESC")) as DbSupplierOrder[];
}

export async function getSupplierOrder(id: string): Promise<DbSupplierOrder | undefined> {  return (await q1("SELECT * FROM supplier_orders WHERE id = ?", id)) as DbSupplierOrder | undefined;
}

export async function deleteSupplierOrder(id: string) {
  await qe("DELETE FROM supplier_orders WHERE id = ?", id);
}

export async function setSupplierOrderStatus(id: string, status: string) {
  await qe("UPDATE supplier_orders SET status = ? WHERE id = ?", status, id);
}

// ---- Admin-managed products & guides (JSON overrides) ----

export async function listAdminProducts(): Promise<{ sku: string; data: unknown; updated_at: string }[]> {  return (await qr("SELECT * FROM admin_products ORDER BY updated_at DESC")) as { sku: string; data: unknown; updated_at: string }[];
}

export async function getAdminProduct(sku: string) {
  const row = (await q1("SELECT data FROM admin_products WHERE sku = ?", sku)) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : undefined;
}

export async function upsertAdminProduct(sku: string, data: unknown) {
  await qe("INSERT INTO admin_products (sku, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(sku) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at", sku, JSON.stringify(data), new Date().toISOString());
}

export async function deleteAdminProduct(sku: string) {
  await qe("DELETE FROM admin_products WHERE sku = ?", sku);
}

/**
 * Records a sale: decrements `stock` (floored at 0) and increments `sold` for
 * each line item. The JSON override row must exist with concrete numbers before
 * the atomic UPDATE — for catalog products whose only stock lives in the seed
 * file, a minimal override row is created from the caller-supplied fallbacks
 * (the caller resolves them via the live catalog). The per-row UPDATE itself is
 * atomic in Postgres, so concurrent orders can't lose counts.
 */
export async function adjustProductStock(
  adjustments: { sku: string; qty: number; fallbackStock: number; fallbackSold: number; isSeed: boolean }[]
) {
  const changed: string[] = [];
  for (const adj of adjustments) {
    const qty = Math.floor(adj.qty);
    if (!adj.sku || qty <= 0) continue;
    try {
      const existing = await getAdminProduct(adj.sku);
      if (!existing) {
        if (!adj.isSeed) continue; // custom product rows are always in the DB
        // Minimal static override: mergedCatalog spreads these keys over the
        // seed product, leaving every other field intact.
        await upsertAdminProduct(adj.sku, {
          sku: adj.sku,
          static: true,
          stock: Math.max(0, Number(adj.fallbackStock) || 0),
          sold: Number(adj.fallbackSold) || 0,
        });
      } else if (typeof existing.stock !== "number") {
        // Row exists (prior partial edit) but has no numeric stock — backfill
        // it once from the live-catalog values the caller resolved.
        await upsertAdminProduct(adj.sku, {
          ...existing,
          sku: adj.sku,
          stock: Math.max(0, Number(adj.fallbackStock) || 0),
          sold: Number(existing.sold ?? adj.fallbackSold) || 0,
        });
      }
      await qe(
        `UPDATE admin_products SET data = (
           SELECT jsonb_set(jsonb_set(
             data::jsonb,
             '{stock}',
             to_jsonb(GREATEST(0, COALESCE((data::jsonb->>'stock')::int, 0) - $2))
           , '{sold}', to_jsonb(COALESCE((data::jsonb->>'sold')::int, 0) + $2))
           )::text
         ), updated_at = $3
         WHERE sku = $1`,
        adj.sku,
        qty,
        new Date().toISOString()
      );
      changed.push(adj.sku);
    } catch (err) {
      // Stock tracking must never fail an order that was already created.
      console.error(`[db] stock adjust failed for ${adj.sku}:`, (err as Error).message);
    }
  }
  return changed;
}

/**
 * Reverses a sale: increments `stock` and decrements `sold` (floored at 0) for
 * each line item. Used when an order is cancelled so inventory is re-reserved
 * without manual admin restock. Mirrors `adjustProductStock` but with +qty.
 */
export async function restoreProductStock(
  adjustments: { sku: string; qty: number; fallbackStock: number; fallbackSold: number; isSeed: boolean }[]
) {
  const changed: string[] = [];
  for (const adj of adjustments) {
    const qty = Math.floor(adj.qty);
    if (!adj.sku || qty <= 0) continue;
    try {
      const existing = await getAdminProduct(adj.sku);
      if (!existing) {
        if (!adj.isSeed) continue;
        // Create a minimal static override at the live-catalog baseline; the
        // atomic jsonb UPDATE below then applies the +qty / -qty delta once.
        await upsertAdminProduct(adj.sku, {
          sku: adj.sku,
          static: true,
          stock: Math.max(0, Number(adj.fallbackStock) || 0),
          sold: Number(adj.fallbackSold) || 0,
        });
      } else if (typeof existing.stock !== "number") {
        await upsertAdminProduct(adj.sku, {
          ...existing,
          sku: adj.sku,
          stock: Math.max(0, Number(adj.fallbackStock) || 0),
          sold: Number(existing.sold ?? adj.fallbackSold) || 0,
        });
      }
      await qe(
        `UPDATE admin_products SET data = (
           SELECT jsonb_set(jsonb_set(
             data::jsonb,
             '{stock}',
             to_jsonb(COALESCE((data::jsonb->>'stock')::int, 0) + $2)
           , '{sold}', to_jsonb(GREATEST(0, COALESCE((data::jsonb->>'sold')::int, 0) - $2))
           )::text
         ), updated_at = $3
         WHERE sku = $1`,
        adj.sku,
        qty,
        new Date().toISOString()
      );
      changed.push(adj.sku);
    } catch (err) {
      console.error(`[db] stock restore failed for ${adj.sku}:`, (err as Error).message);
    }
  }
  return changed;
}

export async function listAdminGuides(): Promise<{ slug: string; data: unknown; updated_at: string }[]> {  return (await qr("SELECT * FROM admin_guides ORDER BY updated_at DESC")) as { slug: string; data: unknown; updated_at: string }[];
}

export async function getAdminGuide(slug: string) {
  const row = (await q1("SELECT data FROM admin_guides WHERE slug = ?", slug)) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : undefined;
}

export async function upsertAdminGuide(slug: string, data: unknown) {
  await qe("INSERT INTO admin_guides (slug, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(slug) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at", slug, JSON.stringify(data), new Date().toISOString());
}

export async function deleteAdminGuide(slug: string) {
  await qe("DELETE FROM admin_guides WHERE slug = ?", slug);
}

// ---- Blog posts ----

export type DbPost = {
  id: string;
  slug: string;
  title: string;
  category: string;
  excerpt: string;
  content: string;
  cover: string | null;
  author: string;
  read_time: string;
  published: number;
  created_at: string;
  updated_at: string;
};

export type PostInput = {
  slug: string;
  title: string;
  category: string;
  excerpt: string;
  content: string;
  cover?: string | null;
  author?: string;
  read_time?: string;
  published?: boolean;
};

export async function listPosts(includeUnpublished = false): Promise<DbPost[]> {  const sql = includeUnpublished
    ? "SELECT * FROM posts ORDER BY created_at DESC"
    : "SELECT * FROM posts WHERE published = 1 ORDER BY created_at DESC";
  return (await qr(sql)) as DbPost[];
}

export async function getPostBySlug(slug: string, includeUnpublished = false): Promise<DbPost | undefined> {  const sql = includeUnpublished
    ? "SELECT * FROM posts WHERE slug = ?"
    : "SELECT * FROM posts WHERE slug = ? AND published = 1";
  return (await q1(sql, slug)) as DbPost | undefined;
}

export async function createPost(input: PostInput): Promise<DbPost> {  const post: DbPost = {
    id: randomUUID(),
    slug: input.slug,
    title: input.title,
    category: input.category,
    excerpt: input.excerpt,
    content: input.content,
    cover: input.cover ?? null,
    author: input.author ?? "KimSafety Team",
    read_time: input.read_time ?? "5 min read",
    published: input.published === false ? 0 : 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await qe("INSERT INTO posts (id, slug, title, category, excerpt, content, cover, author, read_time, published, created_at, updated_at) VALUES (@id, @slug, @title, @category, @excerpt, @content, @cover, @author, @read_time, @published, @created_at, @updated_at)", post);
  return post;
}

export async function updatePost(slug: string, input: PostInput): Promise<DbPost | undefined> {  const existing = await getPostBySlug(slug, true);
  if (!existing) return undefined;
  const updated: DbPost = {
    ...existing,
    slug: input.slug,
    title: input.title,
    category: input.category,
    excerpt: input.excerpt,
    content: input.content,
    cover: input.cover ?? existing.cover,
    author: input.author ?? existing.author,
    read_time: input.read_time ?? existing.read_time,
    published: input.published === false ? 0 : 1,
    updated_at: new Date().toISOString(),
  };
  await qe("UPDATE posts SET slug = @slug, title = @title, category = @category, excerpt = @excerpt, content = @content, cover = @cover, author = @author, read_time = @read_time, published = @published, updated_at = @updated_at WHERE id = @id", updated);
  return updated;
}

export async function deletePost(slug: string) {
  await qe("DELETE FROM posts WHERE slug = ?", slug);
}

// ---- Marketing: banners & campaigns ----

export type MarketingBanner = {
  id: number;
  title: string;
  subtitle: string;
  kicker: string;
  cta: string;
  cta_href: string;
  cta2: string;
  image: string;
  card_kicker: string;
  card_title: string;
  card_subtitle: string;
  stat1_label: string;
  stat1_value: string;
  stat2_label: string;
  stat2_value: string;
  sort: number;
  active: number;
  created_at: string;
  updated_at: string;
};

export type MarketingCampaign = {
  id: number;
  name: string;
  slug: string;
  description: string;
  discount_label: string;
  image: string | null;
  cta_href: string;
  start_date: string | null;
  end_date: string | null;
  active: number;
  created_at: string;
  updated_at: string;
};

export async function listBanners(): Promise<MarketingBanner[]> {  return (await qr("SELECT * FROM marketing_banners ORDER BY sort ASC, id ASC")) as MarketingBanner[];
}

export async function getBannerById(id: number): Promise<MarketingBanner | undefined> {  return (await q1("SELECT * FROM marketing_banners WHERE id = ?", id)) as MarketingBanner | undefined;
}

export async function upsertBanner(
  input: Omit<MarketingBanner, "id" | "created_at" | "updated_at"> & { id?: number }
): Promise<MarketingBanner> {  const now = new Date().toISOString();
  const row = {
    ...input,
    active: input.active ? 1 : 0,
    updated_at: now,
  };
  if (input.id) {
    await qe("UPDATE marketing_banners SET title = @title, subtitle = @subtitle, kicker = @kicker, cta = @cta, cta_href = @cta_href, cta2 = @cta2, image = @image, card_kicker = @card_kicker, card_title = @card_title, card_subtitle = @card_subtitle, stat1_label = @stat1_label, stat1_value = @stat1_value, stat2_label = @stat2_label, stat2_value = @stat2_value, sort = @sort, active = @active, updated_at = @updated_at WHERE id = @id", { ...row, id: input.id });
    invalidateMarketingCache();
    return (await getBannerById(input.id))!;
  }
  const inserted = await q1<{ id: number }>("INSERT INTO marketing_banners (title, subtitle, kicker, cta, cta_href, cta2, image, card_kicker, card_title, card_subtitle, stat1_label, stat1_value, stat2_label, stat2_value, sort, active, created_at, updated_at) VALUES (@title, @subtitle, @kicker, @cta, @cta_href, @cta2, @image, @card_kicker, @card_title, @card_subtitle, @stat1_label, @stat1_value, @stat2_label, @stat2_value, @sort, @active, @created_at, @updated_at) RETURNING id", { ...row, created_at: now });
  invalidateMarketingCache();
  return (await getBannerById(inserted!.id))!;
}

export async function deleteBanner(id: number) {
  await qe("DELETE FROM marketing_banners WHERE id = ?", id);
  invalidateMarketingCache();
}

export async function getActiveBanners(): Promise<MarketingBanner[]> {
  const now = Date.now();
  if (bannersCache && now - bannersCache.at < MARKETING_TTL_MS) return bannersCache.data;
  const rows = (await qr("SELECT * FROM marketing_banners WHERE active = 1 ORDER BY sort ASC, id ASC")) as MarketingBanner[];
  bannersCache = { at: now, data: rows };
  return rows;
}

export async function listCampaigns(): Promise<MarketingCampaign[]> {  return (await qr("SELECT * FROM marketing_campaigns ORDER BY COALESCE(end_date, '9999-12-31') DESC, id DESC")) as MarketingCampaign[];
}

export async function getCampaignBySlug(slug: string): Promise<MarketingCampaign | undefined> {  return (await q1("SELECT * FROM marketing_campaigns WHERE slug = ?", slug)) as MarketingCampaign | undefined;
}

export async function upsertCampaign(
  input: Omit<MarketingCampaign, "id" | "created_at" | "updated_at"> & { id?: number }
): Promise<MarketingCampaign> {  const now = new Date().toISOString();
  const row = {
    ...input,
    active: input.active ? 1 : 0,
    updated_at: now,
  };
  if (input.id) {
    await qe("UPDATE marketing_campaigns SET name = @name, slug = @slug, description = @description, discount_label = @discount_label, image = @image, cta_href = @cta_href, start_date = @start_date, end_date = @end_date, active = @active, updated_at = @updated_at WHERE id = @id", { ...row, id: input.id });
    invalidateMarketingCache();
    return (await getCampaignBySlug(input.slug))!;
  }
  await qe("INSERT INTO marketing_campaigns (name, slug, description, discount_label, image, cta_href, start_date, end_date, active, created_at, updated_at) VALUES (@name, @slug, @description, @discount_label, @image, @cta_href, @start_date, @end_date, @active, @created_at, @updated_at)", { ...row, created_at: now });
  invalidateMarketingCache();
  return (await getCampaignBySlug(input.slug))!;
}

export async function deleteCampaign(id: number) {
  await qe("DELETE FROM marketing_campaigns WHERE id = ?", id);
  invalidateMarketingCache();
}

export async function getActiveCampaigns(): Promise<MarketingCampaign[]> {  const today = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  if (campaignsCache && now - campaignsCache.at < MARKETING_TTL_MS) return campaignsCache.data;
  const rows = (await qr("SELECT * FROM marketing_campaigns WHERE active = 1 AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?) ORDER BY COALESCE(end_date, '9999-12-31') ASC, id ASC", today, today)) as MarketingCampaign[];
  campaignsCache = { at: now, data: rows };
  return rows;
}

const MARKETING_TTL_MS = 60 * 1000;
let bannersCache: { at: number; data: MarketingBanner[] } | null = null;
let campaignsCache: { at: number; data: MarketingCampaign[] } | null = null;

export function invalidateMarketingCache() {
  bannersCache = null;
  campaignsCache = null;
}

// ---- Abandoned-cart recovery & back-in-stock notifications ----

export type DbAbandonedCart = {
  id: string;
  email: string;
  name: string;
  phone: string;
  items: string;
  updated_at: string;
  reminded_at: string | null;
};

/** Upserts the cart snapshot captured when a shopper fills in checkout details. */
export async function upsertAbandonedCart(input: { email: string; name?: string; phone?: string; items: unknown[] }): Promise<void> {
  const existing = (await q1("SELECT id FROM abandoned_carts WHERE email = ?", input.email)) as { id: string } | undefined;
  const items = JSON.stringify(input.items ?? []);
  if (!input.items?.length) {
    // Empty cart = they ordered or cleared it — stop tracking.
    await qe("DELETE FROM abandoned_carts WHERE email = ?", input.email);
    return;
  }
  if (existing) {
    await qe("UPDATE abandoned_carts SET name = ?, phone = ?, items = ?, updated_at = ? WHERE email = ?", input.name ?? "", input.phone ?? "", items, new Date().toISOString(), input.email);
    return;
  }
  await qe(
    "INSERT INTO abandoned_carts (id, email, name, phone, items, updated_at, reminded_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
    randomUUID(),
    input.email,
    input.name ?? "",
    input.phone ?? "",
    items,
    new Date().toISOString()
  );
}

/** Carts idle for at least `olderThanMs`, not yet reminded. */
export async function listAbandonedCartsToRemind(olderThanMs: number): Promise<DbAbandonedCart[]> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  return (await qr(
    "SELECT * FROM abandoned_carts WHERE reminded_at IS NULL AND updated_at < ? ORDER BY updated_at ASC LIMIT 200",
    cutoff
  )) as DbAbandonedCart[];
}

export async function markAbandonedCartReminded(id: string) {
  await qe("UPDATE abandoned_carts SET reminded_at = ? WHERE id = ?", new Date().toISOString(), id);
}

/** Adds a back-in-stock request; duplicate (product,email) pairs are ignored. */
export async function addRestockRequest(productId: string, email: string): Promise<void> {
  await qe(
    "INSERT INTO restock_notifications (id, product_id, email, notified, created_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT (product_id, email) DO NOTHING",
    randomUUID(),
    productId,
    email,
    new Date().toISOString()
  );
}

/** Pending (not-yet-notified) requests for one product. */
export async function listPendingRestockRequests(productId: string): Promise<{ id: string; email: string }[]> {
  return (await qr(
    "SELECT id, email FROM restock_notifications WHERE product_id = ? AND notified = 0",
    productId
  )) as { id: string; email: string }[];
}

export async function markRestockNotified(ids: string[]) {
  for (const id of ids) {
    await qe("UPDATE restock_notifications SET notified = 1 WHERE id = ?", id);
  }
}

// ---- Addresses ----

export async function listAddressesForUser(userId: string): Promise<DbAddress[]> {  return (await qr("SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC", userId)) as DbAddress[];
}

export async function createAddress(input: {
  user_id: string;
  label: string;
  name: string;
  phone: string;
  address_line: string;
  city: string;
  county: string;
}): Promise<DbAddress> {  const existing = await listAddressesForUser(input.user_id);
  const address: DbAddress = {
    id: randomUUID(),
    user_id: input.user_id,
    label: input.label || "Home",
    name: input.name,
    phone: input.phone,
    address_line: input.address_line,
    city: input.city,
    county: input.county,
    is_default: existing.length === 0 ? 1 : 0,
    created_at: new Date().toISOString(),
  };
  await qe("INSERT INTO addresses (id, user_id, label, name, phone, address_line, city, county, is_default, created_at) VALUES (@id, @user_id, @label, @name, @phone, @address_line, @city, @county, @is_default, @created_at)", address);
  return address;
}

export async function getAddress(id: string): Promise<DbAddress | undefined> {  return (await q1("SELECT * FROM addresses WHERE id = ?", id)) as DbAddress | undefined;
}

export async function deleteAddress(id: string) {
  const addr = await getAddress(id);
  await qe("DELETE FROM addresses WHERE id = ?", id);
  if (addr?.is_default === 1) {
    const next = (await q1("SELECT * FROM addresses WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", addr.user_id)) as DbAddress | undefined;
    if (next) await setDefaultAddress(next.id);
  }
}

export async function setDefaultAddress(id: string) {
  const addr = await getAddress(id);
  if (!addr) return;
  await qe("UPDATE addresses SET is_default = 0 WHERE user_id = ?", addr.user_id);
  await qe("UPDATE addresses SET is_default = 1 WHERE id = ?", id);
}

// ---- Support tickets ----

export async function listTicketsForUser(userId: string): Promise<DbTicket[]> {  return (await qr("SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC", userId)) as DbTicket[];
}

export async function listAllTickets(): Promise<DbTicket[]> {  return (await qr("SELECT t.*, u.name AS user_name, u.email AS user_email FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id ORDER BY (t.status = 'Closed') ASC, t.updated_at DESC")) as (DbTicket & { user_name: string | null; user_email: string | null })[];
}

export async function getTicket(id: string): Promise<DbTicket | undefined> {  return (await q1("SELECT * FROM support_tickets WHERE id = ?", id)) as DbTicket | undefined;
}

export async function createTicket(input: { user_id: string; subject: string; message: string }): Promise<DbTicket> {  const now = new Date().toISOString();
  const ticket: DbTicket = {
    id: `TKT-${Math.floor(10000 + Math.random() * 89999)}`,
    user_id: input.user_id,
    subject: input.subject,
    message: input.message,
    status: "Open",
    created_at: now,
    updated_at: now,
  };
  await qe("INSERT INTO support_tickets (id, user_id, subject, message, status, created_at, updated_at) VALUES (@id, @user_id, @subject, @message, @status, @created_at, @updated_at)", ticket);
  return ticket;
}

export async function listTicketReplies(ticketId: string): Promise<DbTicketReply[]> {  return (await qr("SELECT * FROM ticket_replies WHERE ticket_id = ? ORDER BY created_at ASC", ticketId)) as DbTicketReply[];
}

export async function addTicketReply(input: {
  ticket_id: string;
  user_id?: string | null;
  staff_name?: string | null;
  message: string;
}): Promise<DbTicketReply> {  const reply: DbTicketReply = {
    id: randomUUID(),
    ticket_id: input.ticket_id,
    user_id: input.user_id ?? null,
    staff_name: input.staff_name ?? null,
    message: input.message,
    created_at: new Date().toISOString(),
  };
  const now = new Date().toISOString();
  await qe("INSERT INTO ticket_replies (id, ticket_id, user_id, staff_name, message, created_at) VALUES (@id, @ticket_id, @user_id, @staff_name, @message, @created_at)", reply);
  await qe("UPDATE support_tickets SET updated_at = ?, status = 'Open' WHERE id = ?", now, input.ticket_id);
  return reply;
}

export async function setTicketStatus(id: string, status: string) {
  await qe("UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?", status, new Date().toISOString(), id);
}

// ---- Returns ----

export async function listReturnsForUser(userId: string): Promise<DbReturn[]> {  return (await qr("SELECT * FROM returns WHERE user_id = ? ORDER BY created_at DESC", userId)) as DbReturn[];
}

export async function listAllReturns(): Promise<DbReturn[]> {  return (await qr("SELECT * FROM returns ORDER BY created_at DESC")) as DbReturn[];
}

export async function createReturn(input: {
  user_id: string;
  order_id: string;
  product_name: string;
  qty: number;
  reason: string;
}): Promise<DbReturn> {  const now = new Date().toISOString();
  const ret: DbReturn = {
    id: `RET-${Math.floor(10000 + Math.random() * 89999)}`,
    user_id: input.user_id,
    order_id: input.order_id,
    product_name: input.product_name,
    qty: input.qty,
    reason: input.reason,
    status: "Requested",
    created_at: now,
    updated_at: now,
  };
  await qe("INSERT INTO returns (id, user_id, order_id, product_name, qty, reason, status, created_at, updated_at) VALUES (@id, @user_id, @order_id, @product_name, @qty, @reason, @status, @created_at, @updated_at)", ret);
  return ret;
}

export async function setReturnStatus(id: string, status: string) {
  await qe("UPDATE returns SET status = ?, updated_at = ? WHERE id = ?", status, new Date().toISOString(), id);
}

// ---- Contact messages ----

export async function createContactMessage(input: { name: string; email: string; phone?: string; topic: string; message: string }): Promise<DbContactMessage> {  const msg: DbContactMessage = {
    id: `MSG-${Math.floor(10000 + Math.random() * 89999)}`,
    name: input.name,
    email: input.email.toLowerCase(),
    phone: input.phone ?? "",
    topic: input.topic,
    message: input.message,
    created_at: new Date().toISOString(),
  };
  await qe("INSERT INTO contact_messages (id, name, email, phone, topic, message, created_at) VALUES (@id, @name, @email, @phone, @topic, @message, @created_at)", msg);
  return msg;
}

export async function listContactMessages(): Promise<DbContactMessage[]> {  return (await qr("SELECT * FROM contact_messages ORDER BY created_at DESC")) as DbContactMessage[];
}

export async function deleteContactMessage(id: string) {
  await qe("DELETE FROM contact_messages WHERE id = ?", id);
}

// ---- Product Q&A ----

export async function createProductQuestion(input: { product_id: string; name: string; email: string; question: string }): Promise<DbProductQuestion> {  const q: DbProductQuestion = {
    id: `Q-${Math.floor(10000 + Math.random() * 89999)}`,
    product_id: input.product_id,
    name: input.name,
    email: input.email.toLowerCase(),
    question: input.question,
    answer: null,
    answered_at: null,
    created_at: new Date().toISOString(),
  };
  await qe("INSERT INTO product_questions (id, product_id, name, email, question, answer, answered_at, created_at) VALUES (@id, @product_id, @name, @email, @question, @answer, @answered_at, @created_at)", q);
  return q;
}

export async function listQuestionsForProduct(productId: string): Promise<DbProductQuestion[]> {  return (await qr("SELECT * FROM product_questions WHERE product_id = ? ORDER BY created_at DESC", productId)) as DbProductQuestion[];
}

export async function listAllQuestions(): Promise<DbProductQuestion[]> {  return (await qr("SELECT * FROM product_questions ORDER BY (answer IS NULL) DESC, created_at DESC")) as DbProductQuestion[];
}

export async function answerQuestion(id: string, answer: string) {
  await qe("UPDATE product_questions SET answer = ?, answered_at = ? WHERE id = ?", answer, new Date().toISOString(), id);
}

export async function deleteQuestion(id: string) {
  await qe("DELETE FROM product_questions WHERE id = ?", id);
}

// ---- Notifications ----

export async function createNotification(input: {
  user_id: string;
  type?: string;
  title: string;
  message?: string;
  link?: string | null;
}): Promise<DbNotification> {  const notification: DbNotification = {
    id: randomUUID(),
    user_id: input.user_id,
    type: input.type ?? "general",
    title: input.title,
    message: input.message ?? "",
    link: input.link ?? null,
    read: 0,
    created_at: new Date().toISOString(),
  };
  await qe("INSERT INTO notifications (id, user_id, type, title, message, link, read, created_at) VALUES (@id, @user_id, @type, @title, @message, @link, @read, @created_at)", notification);
  return notification;
}

export async function listNotificationsForUser(userId: string): Promise<DbNotification[]> {  return (await qr("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", userId)) as DbNotification[];
}

export async function countUnreadNotifications(userId: string): Promise<number> {  const row = (await q1("SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = ? AND read = 0", userId)) as { n: number };
  return row.n;
}

export async function markNotificationRead(id: string) {
  await qe("UPDATE notifications SET read = 1 WHERE id = ?", id);
}

export async function markAllNotificationsRead(userId: string) {
  await qe("UPDATE notifications SET read = 1 WHERE user_id = ?", userId);
}

// ---- Reviews ----

export type DbReview = {
  id: string;
  product_id: string;
  user_id: string;
  user_name: string;
  rating: number;
  title: string;
  text: string;
  status: string;
  verified: number;
  helpful: number;
  created_at: string;
};

export async function listReviewsForProduct(productId: string): Promise<DbReview[]> {  return (await qr("SELECT * FROM reviews WHERE product_id = ? AND status = 'approved' ORDER BY created_at DESC", productId)) as DbReview[];
}

export async function listAllReviews(): Promise<DbReview[]> {  return (await qr("SELECT * FROM reviews ORDER BY (status = 'approved') DESC, created_at DESC")) as DbReview[];
}

export async function getReview(id: string): Promise<DbReview | undefined> {  return (await q1("SELECT * FROM reviews WHERE id = ?", id)) as DbReview | undefined;
}

export async function getReviewByUserAndProduct(userId: string, productId: string): Promise<DbReview | undefined> {  return (await q1("SELECT * FROM reviews WHERE user_id = ? AND product_id = ?", userId, productId)) as DbReview | undefined;
}

export async function hasPurchasedProduct(userId: string, productId: string): Promise<boolean> {
  const escaped = productId.replace(/[\\%_]/g, (m) => `\\${m}`);
  const row = (await q1("SELECT COUNT(*)::int AS n FROM orders WHERE user_id = ? AND items LIKE ?", userId, `%"productId":"${escaped}"%`)) as { n: number };
  return (row?.n ?? 0) > 0;
}

export async function createReview(input: {
  product_id: string;
  user_id: string;
  user_name: string;
  rating: number;
  title: string;
  text: string;
  status?: string;
  verified?: number;
}): Promise<DbReview> {  const review: DbReview = {
    id: randomUUID(),
    product_id: input.product_id,
    user_id: input.user_id,
    user_name: input.user_name,
    rating: input.rating,
    title: input.title,
    text: input.text,
    status: input.status ?? "pending",
    verified: input.verified ?? 1,
    helpful: 0,
    created_at: new Date().toISOString(),
  };
  await qe("INSERT INTO reviews (id, product_id, user_id, user_name, rating, title, text, status, verified, helpful, created_at) VALUES (@id, @product_id, @user_id, @user_name, @rating, @title, @text, @status, @verified, @helpful, @created_at)", review);
  return review;
}

const REVIEW_COLUMNS = new Set(["rating", "title", "text", "status", "verified", "helpful"]);

export async function updateReview(id: string, patch: Partial<Pick<DbReview, "rating" | "title" | "text" | "status" | "verified" | "helpful">>) {
  // Column names are interpolated into the SQL text, so they MUST come from
  // this fixed allowlist — never from raw object keys.
  const sets = Object.entries(patch)
    .filter(([k]) => REVIEW_COLUMNS.has(k))
    .map(([k]) => `${k} = @${k}`);
  if (sets.length === 0) return;
  await qe(`UPDATE reviews SET ${sets.join(", ")} WHERE id = @id`, { ...patch, id } as Record<string, unknown>);
}

export async function deleteReview(id: string) {
  await qe("DELETE FROM reviews WHERE id = ?", id);
}

export type DbNewsletterSubscriber = {
  id: string;
  email: string;
  name: string | null;
  source: string;
  status: string;
  unsubscribe_token: string | null;
  unsubscribed_at: string | null;
  created_at: string;
};

export async function subscribeNewsletter(input: {
  email: string;
  name?: string | null;
  source?: string;
}): Promise<{ subscriber: DbNewsletterSubscriber; duplicate: boolean }> {
  const email = input.email.trim().toLowerCase();
  const existing = (await q1(
    "SELECT * FROM newsletter_subscribers WHERE LOWER(email) = ?",
    email
  )) as DbNewsletterSubscriber | undefined;

  if (existing) {
    if (existing.status !== "subscribed") {
      // Re-activate: previously unsubscribed — sign up again means resubscribe.
      const reactivated = {
        ...existing,
        status: "subscribed",
        unsubscribe_token: existing.unsubscribe_token ?? randomUUID(),
        unsubscribed_at: null,
      };
      await qe(
        "UPDATE newsletter_subscribers SET status = @status, unsubscribe_token = @unsubscribe_token, unsubscribed_at = NULL WHERE id = @id",
        reactivated
      );
      return { subscriber: reactivated, duplicate: true };
    }
    return { subscriber: existing, duplicate: true };
  }

  const subscriber: DbNewsletterSubscriber = {
    id: randomUUID(),
    email,
    name: input.name?.trim() || null,
    source: input.source ?? "home",
    status: "subscribed",
    unsubscribe_token: randomUUID(),
    unsubscribed_at: null,
    created_at: new Date().toISOString(),
  };
  await qe(
    "INSERT INTO newsletter_subscribers (id, email, name, source, status, unsubscribe_token, unsubscribed_at, created_at) VALUES (@id, @email, @name, @source, @status, @unsubscribe_token, @unsubscribed_at, @created_at)",
    subscriber
  );
  return { subscriber, duplicate: false };
}

export async function listNewsletterSubscribers(onlyActive = false): Promise<DbNewsletterSubscriber[]> {
  return (await qr(
    onlyActive
      ? "SELECT * FROM newsletter_subscribers WHERE status = 'subscribed' ORDER BY created_at DESC"
      : "SELECT * FROM newsletter_subscribers ORDER BY created_at DESC"
  )) as DbNewsletterSubscriber[];
}

export async function getNewsletterSubscriberById(id: string): Promise<DbNewsletterSubscriber | undefined> {
  return (await q1("SELECT * FROM newsletter_subscribers WHERE id = ?", id)) as DbNewsletterSubscriber | undefined;
}

export async function getNewsletterSubscriberByToken(token: string): Promise<DbNewsletterSubscriber | undefined> {
  return (await q1("SELECT * FROM newsletter_subscribers WHERE unsubscribe_token = ?", token)) as
    | DbNewsletterSubscriber
    | undefined;
}

export async function unsubscribeNewsletter(token: string) {
  await qe(
    "UPDATE newsletter_subscribers SET status = 'unsubscribed', unsubscribed_at = ? WHERE unsubscribe_token = ?",
    new Date().toISOString(),
    token
  );
}

export async function deleteNewsletterSubscriber(id: string) {
  await qe("DELETE FROM newsletter_subscribers WHERE id = ?", id);
}

export async function countNewsletterSubscribers(): Promise<number> {
  const row = (await q1("SELECT COUNT(*)::int AS n FROM newsletter_subscribers WHERE status = 'subscribed'")) as { n: number };
  return row?.n ?? 0;
}

// ---- Newsletter campaigns (send history) ----

export type DbNewsletterCampaign = {
  id: string;
  subject: string;
  body: string;
  source: string;
  source_slug: string | null;
  total: number;
  sent: number;
  failed: number;
  created_at: string;
};

export async function createNewsletterCampaign(input: {
  subject: string;
  body: string;
  source?: string;
  source_slug?: string | null;
  total: number;
  sent: number;
  failed: number;
}): Promise<DbNewsletterCampaign> {
  const campaign: DbNewsletterCampaign = {
    id: randomUUID(),
    subject: input.subject,
    body: input.body,
    source: input.source ?? "manual",
    source_slug: input.source_slug ?? null,
    total: input.total,
    sent: input.sent,
    failed: input.failed,
    created_at: new Date().toISOString(),
  };
  await qe(
    "INSERT INTO newsletter_campaigns (id, subject, body, source, source_slug, total, sent, failed, created_at) VALUES (@id, @subject, @body, @source, @source_slug, @total, @sent, @failed, @created_at)",
    campaign
  );
  return campaign;
}

export async function listNewsletterCampaigns(limit = 50): Promise<DbNewsletterCampaign[]> {
  return (await qr(
    "SELECT * FROM newsletter_campaigns ORDER BY created_at DESC LIMIT ?",
    limit
  )) as DbNewsletterCampaign[];
}

/** Imports every registered user with a valid email into the subscriber list. */
export async function importUsersToNewsletter(): Promise<{ added: number; skipped: number }> {
  const users = (await qr("SELECT name, email FROM users")) as { name: string; email: string }[];
  let added = 0;
  let skipped = 0;
  for (const u of users) {
    const email = (u.email ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      skipped++;
      continue;
    }
    const { duplicate } = await subscribeNewsletter({ email, name: u.name || null, source: "account" });
    if (duplicate) skipped++;
    else added++;
  }
  return { added, skipped };
}


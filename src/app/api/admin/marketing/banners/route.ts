import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-helpers";
import {
  listBanners,
  getBannerById,
  upsertBanner,
  deleteBanner,
  type MarketingBanner,
} from "@/lib/db";

function parseBanner(body: unknown): (Omit<MarketingBanner, "id" | "created_at" | "updated_at"> & { id?: number }) | null {
  const b = body as Record<string, unknown>;
  if (!b || typeof b !== "object") return null;
  const title = String(b.title ?? "").trim();
  const image = String(b.image ?? "").trim();
  if (!title || !image) return null;
  const sort = Number(b.sort);
  return {
    id: typeof b.id === "number" ? b.id : undefined,
    title,
    subtitle: String(b.subtitle ?? "").trim(),
    kicker: String(b.kicker ?? "KimSafety").trim() || "KimSafety",
    cta: String(b.cta ?? "Shop Now").trim() || "Shop Now",
    cta_href: String(b.cta_href ?? "/search").trim() || "/search",
    cta2: String(b.cta2 ?? "Request a Quote").trim() || "Request a Quote",
    image,
    card_kicker: String(b.card_kicker ?? "").trim(),
    card_title: String(b.card_title ?? "").trim(),
    card_subtitle: String(b.card_subtitle ?? "").trim(),
    stat1_label: String(b.stat1_label ?? "Trusted by").trim() || "Trusted by",
    stat1_value: String(b.stat1_value ?? "1,200+ Organizations").trim() || "1,200+ Organizations",
    stat2_label: String(b.stat2_label ?? "Delivered to").trim() || "Delivered to",
    stat2_value: String(b.stat2_value ?? "47 Counties").trim() || "47 Counties",
    sort: Number.isFinite(sort) ? sort : 0,
    active: b.active === true || b.active === undefined ? 1 : 0,
  };
}

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const rows = await listBanners().catch(() => [] as Awaited<ReturnType<typeof listBanners>>);
    return NextResponse.json({ banners: rows.map((b) => ({ ...b, active: Boolean(b.active) })) });
  } catch (err) {
    console.error("[admin/banners] error:", (err as Error).message);
    return NextResponse.json({ banners: [] });
  }
}

export async function POST(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const input = parseBanner(body);
  if (!input) return NextResponse.json({ error: "Title and image are required" }, { status: 400 });
  if (/^javascript:/i.test(input.cta_href) || /^data:/i.test(input.cta_href)) {
    return NextResponse.json({ error: "Button link cannot be javascript: or data:" }, { status: 400 });
  }
  if (input.cta_href !== "/" && !input.cta_href.startsWith("/") && !/^https:\/\//i.test(input.cta_href)) {
    return NextResponse.json({ error: "Button link must start with / or https://" }, { status: 400 });
  }
  if (input.id && !(await getBannerById(input.id))) {
    return NextResponse.json({ error: "Banner not found" }, { status: 404 });
  }
  const banner = await upsertBanner(input);
  return NextResponse.json({ banner: { ...banner, active: Boolean(banner.active) } }, { status: 201 });
}

export async function DELETE(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Missing banner id" }, { status: 400 });
  await deleteBanner(id);
  return NextResponse.json({ ok: true });
}

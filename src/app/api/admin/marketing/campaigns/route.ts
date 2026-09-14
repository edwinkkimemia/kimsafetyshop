import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-helpers";
import { slugify } from "@/lib/utils";
import {
  listCampaigns,
  getCampaignBySlug,
  upsertCampaign,
  deleteCampaign,
  type MarketingCampaign,
} from "@/lib/db";

function parseCampaign(
  body: unknown
): (Omit<MarketingCampaign, "id" | "created_at" | "updated_at"> & { id?: number }) | null {
  const b = body as Record<string, unknown>;
  if (!b || typeof b !== "object") return null;
  const name = String(b.name ?? "").trim();
  if (!name) return null;
  const slug = String(b.slug ?? "").trim().toLowerCase() || slugify(name);
  return {
    id: typeof b.id === "number" ? b.id : undefined,
    name,
    slug: slugify(slug),
    description: String(b.description ?? "").trim(),
    discount_label: String(b.discount_label ?? "").trim(),
    image: typeof b.image === "string" && b.image ? b.image : null,
    cta_href: String(b.cta_href ?? "/search").trim() || "/search",
    start_date: typeof b.start_date === "string" && b.start_date ? b.start_date.slice(0, 10) : null,
    end_date: typeof b.end_date === "string" && b.end_date ? b.end_date.slice(0, 10) : null,
    active: b.active === true || b.active === undefined ? 1 : 0,
  };
}

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const rows = await listCampaigns().catch(() => [] as Awaited<ReturnType<typeof listCampaigns>>);
    return NextResponse.json({ campaigns: rows.map((c) => ({ ...c, active: Boolean(c.active) })) });
  } catch (err) {
    console.error("[admin/campaigns] error:", (err as Error).message);
    return NextResponse.json({ campaigns: [] });
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
  const input = parseCampaign(body);
  if (!input) return NextResponse.json({ error: "Campaign name is required" }, { status: 400 });
  if (/^javascript:/i.test(input.cta_href) || /^data:/i.test(input.cta_href)) {
    return NextResponse.json({ error: "CTA link cannot be javascript: or data:" }, { status: 400 });
  }
  if (input.cta_href !== "/" && !input.cta_href.startsWith("/") && !/^https:\/\//i.test(input.cta_href)) {
    return NextResponse.json({ error: "CTA link must start with / or https://" }, { status: 400 });
  }
  const conflict = await getCampaignBySlug(input.slug);
  if (conflict && conflict.id !== input.id) {
    return NextResponse.json({ error: `Slug "${input.slug}" already exists` }, { status: 409 });
  }
  const campaign = await upsertCampaign(input);
  return NextResponse.json({ campaign: { ...campaign, active: Boolean(campaign.active) } }, { status: 201 });
}

export async function DELETE(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Missing campaign id" }, { status: 400 });
  await deleteCampaign(id);
  return NextResponse.json({ ok: true });
}

import { NextResponse } from "next/server";
import { getActiveBanners, getActiveCampaigns } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Sequential would need 2 connections; Promise.all on same pool with
    // 60s TTL usually hits cache, but on cold miss still safe — fall back to [].
    const [bannersRaw, campaignsRaw] = await Promise.all([
      getActiveBanners().catch(() => []),
      getActiveCampaigns().catch(() => []),
    ]);
    const banners = bannersRaw.map((b) => ({
      id: b.id,
      kicker: b.kicker,
      title: b.title,
      subtitle: b.subtitle,
      cta: b.cta,
      cta_href: b.cta_href,
      cta2: b.cta2,
      card_kicker: b.card_kicker,
      card_title: b.card_title,
      card_subtitle: b.card_subtitle,
      stat1_label: b.stat1_label,
      stat1_value: b.stat1_value,
      stat2_label: b.stat2_label,
      stat2_value: b.stat2_value,
      bg: b.image,
    }));
    const campaigns = campaignsRaw.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      discount_label: c.discount_label,
      image: c.image,
      cta_href: c.cta_href,
      start_date: c.start_date,
      end_date: c.end_date,
    }));
    return NextResponse.json(
      { banners, campaigns },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } }
    );
  } catch (err) {
    console.error("[api/marketing] error:", (err as Error).message);
    return NextResponse.json(
      { banners: [], campaigns: [] },
      { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" } }
    );
  }
}

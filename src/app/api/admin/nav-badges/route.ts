import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-helpers";
import { getNavBadgeCounts } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  // Single round-trip (was 6× Promise.all) — halves connection pressure and
  // avoids 53300 too-many-connections under burst (see logs 17:48:14 4× settings +
  // nav-badges concurrently).
  try {
    const badges = await getNavBadgeCounts();
    return NextResponse.json({ badges });
  } catch (err) {
    console.error("[api/nav-badges] error:", (err as Error).message);
    // Return 200 with zeros so the admin shell doesn't spin retrying.
    return NextResponse.json({
      badges: { orders: 0, tickets: 0, quotes: 0, returns: 0, questions: 0, messages: 0 },
    });
  }
}

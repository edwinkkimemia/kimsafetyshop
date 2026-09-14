import { NextResponse } from "next/server";
import {
  deleteNewsletterSubscriber,
  listNewsletterSubscribers,
  countNewsletterSubscribers,
  getNewsletterSubscriberById,
  subscribeNewsletter,
} from "@/lib/db";
import { requireSuperAdmin } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await requireSuperAdmin();
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const activeOnly = searchParams.get("active") === "1";

  try {
    // Single-query consolidation: COUNT(*) can be derived from subscribers length on small lists,
    // but for correctness keep 2 calls with 53300 fallback — sequential to avoid 2 conns.
    const subscribers = await listNewsletterSubscribers(activeOnly).catch(() => [] as Awaited<ReturnType<typeof listNewsletterSubscribers>>);
    const count = await countNewsletterSubscribers().catch(() => 0);
    return NextResponse.json({ subscribers, count });
  } catch (err) {
    console.error("[admin/newsletter] error:", (err as Error).message);
    return NextResponse.json({ subscribers: [], count: 0 });
  }
}

/** Manually adds a subscriber (email, with optional name) from the admin panel. */
export async function POST(req: Request) {
  const denied = await requireSuperAdmin();
  if (denied) return denied;

  let body: { email?: string; name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const email = (body.email ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }
  const { duplicate } = await subscribeNewsletter({ email, name: body.name?.trim() || null, source: "admin" });
  return NextResponse.json({ ok: true, duplicate }, { status: duplicate ? 200 : 201 });
}

export async function DELETE(req: Request) {
  const denied = await requireSuperAdmin();
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing subscriber id" }, { status: 400 });
  const existing = await getNewsletterSubscriberById(id);
  if (!existing) return NextResponse.json({ error: "Subscriber not found" }, { status: 404 });
  await deleteNewsletterSubscriber(id);
  return NextResponse.json({ ok: true });
}

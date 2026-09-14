import { NextResponse } from "next/server";
import { deleteReview, getReview, listAllReviews, updateReview } from "@/lib/db";
import { requireAdmin } from "@/lib/api-helpers";

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const reviews = await listAllReviews().catch(() => [] as Awaited<ReturnType<typeof listAllReviews>>);
    return NextResponse.json({ reviews });
  } catch (err) {
    console.error("[admin/reviews] error:", (err as Error).message);
    return NextResponse.json({ reviews: [] });
  }
}

export async function PATCH(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: { id?: string; rating?: number; title?: string; text?: string; status?: string; verified?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const id = body.id;
  if (!id) return NextResponse.json({ error: "Missing review id" }, { status: 400 });
  const review = await getReview(id);
  if (!review) return NextResponse.json({ error: "Review not found" }, { status: 404 });

  const patch: Record<string, string | number> = {};
  if (typeof body.rating === "number") {
    if (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) {
      return NextResponse.json({ error: "Rating must be between 1 and 5 stars" }, { status: 400 });
    }
    patch.rating = body.rating;
  }
  if (typeof body.title === "string") patch.title = body.title.trim();
  if (typeof body.text === "string") patch.text = body.text.trim();
  if (typeof body.status === "string") {
    if (!["pending", "approved", "hidden"].includes(body.status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    patch.status = body.status;
  }
  if (typeof body.verified === "number") patch.verified = body.verified ? 1 : 0;

  await updateReview(id, patch);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing review id" }, { status: 400 });
  const review = await getReview(id);
  if (!review) return NextResponse.json({ error: "Review not found" }, { status: 404 });
  await deleteReview(id);
  return NextResponse.json({ ok: true });
}

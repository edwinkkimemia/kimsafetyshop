import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-helpers";
import { deleteContactMessage, listContactMessages } from "@/lib/db";

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const messages = await listContactMessages().catch(() => [] as Awaited<ReturnType<typeof listContactMessages>>);
    return NextResponse.json({ messages });
  } catch (err) {
    console.error("[admin/contact-messages] error:", (err as Error).message);
    return NextResponse.json({ messages: [] });
  }
}

export async function DELETE(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing message id" }, { status: 400 });
  await deleteContactMessage(id);
  return NextResponse.json({ ok: true });
}

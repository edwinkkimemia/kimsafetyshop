import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-helpers";
import { answerQuestion, deleteQuestion, listAllQuestions } from "@/lib/db";

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const questions = await listAllQuestions().catch(() => [] as Awaited<ReturnType<typeof listAllQuestions>>);
    return NextResponse.json({ questions });
  } catch (err) {
    console.error("[admin/questions] error:", (err as Error).message);
    return NextResponse.json({ questions: [] });
  }
}

export async function PATCH(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  let body: { id?: string; answer?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body.id || !body.answer?.trim()) {
    return NextResponse.json({ error: "Question id and answer are required" }, { status: 400 });
  }
  await answerQuestion(body.id, body.answer.trim());
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing question id" }, { status: 400 });
  await deleteQuestion(id);
  return NextResponse.json({ ok: true });
}

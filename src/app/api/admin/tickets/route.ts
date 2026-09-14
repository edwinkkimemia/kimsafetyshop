import { NextResponse } from "next/server";
import {
  addTicketReply,
  getTicket,
  getUserById,
  listAllTickets,
  listTicketReplies,
  setTicketStatus,
} from "@/lib/db";
import { getSessionUser, requireAdmin } from "@/lib/api-helpers";
import { sendTicketReplyEmail } from "@/lib/mailer";

export async function GET(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    const { searchParams } = new URL(req.url);
    const thread = searchParams.get("thread");
    if (thread) {
      const ticket = await getTicket(thread).catch(() => undefined);
      if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
      const replies = await listTicketReplies(thread).catch(() => [] as Awaited<ReturnType<typeof listTicketReplies>>);
      return NextResponse.json({ ticket, replies });
    }

    const tickets = await listAllTickets().catch(() => [] as Awaited<ReturnType<typeof listAllTickets>>);
    return NextResponse.json({ tickets });
  } catch (err) {
    console.error("[admin/tickets] error:", (err as Error).message);
    return NextResponse.json({ tickets: [] });
  }
}

export async function POST(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const user = await getSessionUser();

  let body: { id?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body.id || !body.message?.trim()) {
    return NextResponse.json({ error: "Ticket id and message are required" }, { status: 400 });
  }
  const ticket = await getTicket(body.id);
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  if (ticket.status === "Closed") {
    return NextResponse.json({ error: "This ticket is closed" }, { status: 400 });
  }

  const reply = await addTicketReply({
    ticket_id: body.id,
    user_id: null,
    staff_name: user?.name ?? "KimSafety Support",
    message: body.message.trim(),
  });

  // Email the customer so the reply is not missed — awaited so the SMTP send
  // completes before the serverless function returns.
  try {
    const account = ticket.user_id ? await getUserById(ticket.user_id) : undefined;
    if (account?.email) {
      await sendTicketReplyEmail({
        to: account.email,
        name: account.name,
        ticketId: ticket.id,
        message: body.message.trim(),
        staffName: user?.name ?? "KimSafety Support",
      });
    }
  } catch (err) {
    console.error(`[tickets] reply email failed for ${ticket.id}:`, (err as Error).message);
  }

  return NextResponse.json({ reply }, { status: 201 });
}

export async function PATCH(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: { id?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body.id || !["Closed", "Open"].includes(body.status ?? "")) {
    return NextResponse.json({ error: "Invalid ticket id or status" }, { status: 400 });
  }
  const ticket = await getTicket(body.id);
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  await setTicketStatus(body.id, body.status as string);
  return NextResponse.json({ ok: true });
}

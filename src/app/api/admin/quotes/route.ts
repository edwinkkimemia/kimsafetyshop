import { NextResponse } from "next/server";
import { requireAdmin, getSessionUser } from "@/lib/api-helpers";
import { createQuote, createNotification, deleteQuote, getQuoteById, getUserById, listQuotes, setQuoteStatus } from "@/lib/db";
import { sendQuoteStatusEmail } from "@/lib/mailer";

const VALID = ["Open", "Pending", "Sent", "Accepted", "Expired", "Declined"];

type QuoteItem = { productId: string; name: string; qty: number; price: number; brand?: string | null };

export async function GET(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (id) {
      const quote = await getQuoteById(id).catch(() => undefined);
      if (!quote) return NextResponse.json({ error: "Quote not found" }, { status: 404 });
      const result = { ...quote, items: JSON.parse(quote.items) } as Record<string, unknown>;
      if (quote.user_id && (!quote.email || !quote.phone)) {
        const account = await getUserById(quote.user_id).catch(() => undefined);
        if (account) {
          result.email = quote.email ?? account.email;
          result.phone = quote.phone ?? account.phone ?? null;
        }
      }
      return NextResponse.json({ quote: result });
    }

    const rows = await listQuotes().catch(() => [] as Awaited<ReturnType<typeof listQuotes>>);
    const quotes = rows.map((q) => ({ ...q, items: JSON.parse(q.items) }));
    return NextResponse.json({ quotes });
  } catch (err) {
    console.error("[admin/quotes] error:", (err as Error).message);
    return NextResponse.json({ quotes: [] });
  }
}

export async function POST(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const me = await getSessionUser();

  let body: {
    name?: string;
    company?: string;
    email?: string;
    phone?: string;
    items?: QuoteItem[];
    notes?: string;
    validDays?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const name = body.name?.trim();
  const items = (body.items ?? [])
    .filter((i) => i.name?.trim() && i.qty > 0)
    .map((i) => ({
      productId: i.productId ?? "custom",
      name: i.name.trim(),
      qty: i.qty,
      price: Math.max(0, i.price ?? 0),
      brand: (i.brand?.trim() ? i.brand.trim() : null) as string | null,
    }));

  if (!name) {
    return NextResponse.json({ error: "Customer name is required" }, { status: 400 });
  }
  if (items.length === 0) {
    return NextResponse.json({ error: "Add at least one item with a name and quantity" }, { status: 400 });
  }

  const total = items.reduce((n, i) => n + i.price * i.qty, 0);
  const validDays = Math.min(Math.max(body.validDays ?? 14, 1), 90);
  const validUntil = new Date(Date.now() + validDays * 86400000).toISOString();

  const quote = await createQuote({
    name,
    company: body.company?.trim() || null,
    email: body.email?.trim() || null,
    phone: body.phone?.trim() || null,
    items: JSON.stringify(items),
    total,
    notes: body.notes?.trim() || null,
    valid_until: validUntil,
    created_by_id: me?.id ?? null,
    created_by_name: me?.name ?? me?.email ?? null,
  });

  return NextResponse.json(
    { quote: { ...quote, items: JSON.parse(quote.items) } },
    { status: 201 }
  );
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
  if (!body.id || !VALID.includes(body.status ?? "")) {
    return NextResponse.json({ error: "Invalid quote id or status" }, { status: 400 });
  }
  const quote = await getQuoteById(body.id);
  if (!quote) return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  await setQuoteStatus(body.id, body.status as string);
  if (quote.user_id) {
    await createNotification({
      user_id: quote.user_id,
      type: "quote",
      title: `Quote ${quote.id} is now ${body.status}`,
      message: `Your quotation status changed to ${body.status}.`,
      link: "/account/quotes",
    });
  }
  // Email the customer the status change — awaited so the SMTP send completes
  // before the serverless function returns. Resolve the email from the quote
  // itself or the linked account.
  try {
    const account = quote.user_id ? await getUserById(quote.user_id) : undefined;
    const to = quote.email ?? account?.email ?? null;
    if (to) {
      await sendQuoteStatusEmail({
        to,
        name: account?.name ?? quote.name,
        quoteId: quote.id,
        status: body.status as string,
      });
    }
  } catch (err) {
    console.error(`[quotes] status email failed for ${quote.id}:`, (err as Error).message);
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const me = await getSessionUser();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing quote id" }, { status: 400 });
  const quote = await getQuoteById(id);
  if (!quote) return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  // Staff can only delete quotes they created; superadmins can delete anything.
  if (me?.role !== "superadmin" && (!quote.created_by_id || quote.created_by_id !== me?.id)) {
    return NextResponse.json({ error: "You can only delete quotes you created" }, { status: 403 });
  }
  await deleteQuote(id);
  return NextResponse.json({ ok: true });
}

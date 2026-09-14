import { NextResponse } from "next/server";
import { createAddress, listAddressesForUser } from "@/lib/db";
import { getSessionUser } from "@/lib/api-helpers";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  try {
    const addresses = await listAddressesForUser(user.id).catch(() => [] as Awaited<ReturnType<typeof listAddressesForUser>>);
    return NextResponse.json({ addresses });
  } catch (err) {
    console.error("[addresses] error:", (err as Error).message);
    return NextResponse.json({ addresses: [] });
  }
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { label?: string; name?: string; phone?: string; address_line?: string; city?: string; county?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body.name || !body.address_line) {
    return NextResponse.json({ error: "Name and address are required" }, { status: 400 });
  }
  const address = await createAddress({
    user_id: user.id,
    label: body.label ?? "Home",
    name: body.name,
    phone: body.phone ?? "",
    address_line: body.address_line,
    city: body.city ?? "",
    county: body.county ?? "",
  });
  return NextResponse.json({ address }, { status: 201 });
}

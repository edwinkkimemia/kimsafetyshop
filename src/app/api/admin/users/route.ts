import { NextResponse } from "next/server";
import { requireAdmin, requireSuperAdmin, getSessionUser } from "@/lib/api-helpers";
import { createUser, deleteUser, listUsers, setUserRole, setUserVerified, getUserById, getUserByEmail, updateUserProfile, listCorporateAccounts, getCorporateAccountByUserId, getCorporateAccountByEmail } from "@/lib/db";

export async function GET(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const me = await getSessionUser();
    const isSuper = me?.role === "superadmin";
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    // Staff picker for corporate manager — allow any admin to list staff
    if (searchParams.get("staff") === "1") {
      const allForStaff = await listUsers().catch(() => [] as Awaited<ReturnType<typeof listUsers>>);
      const staff = allForStaff
        .filter((u) => u.role === "admin" || u.role === "superadmin")
        .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, referral_code: u.referral_code }));
      return NextResponse.json({ users: staff });
    }
    const all = await listUsers().catch(() => [] as Awaited<ReturnType<typeof listUsers>>);
    if (all.length === 0) return NextResponse.json({ users: [] });
  const byId = new Map(all.map((u) => [u.id, u.name]));
  // Build corporate lookup (by user_id and by email fallback for accounts without user_id or legacy mismatches)
  const corpByUserId = new Map<string, { id: string; company: string; discount_rate: number; credit_terms: string; status: string; account_manager: string | null; email: string | null }>();
  const corpByEmail = new Map<string, { id: string; company: string; discount_rate: number; credit_terms: string; status: string; account_manager: string | null; email: string | null }>();
  try {
    const corps = await listCorporateAccounts();
    for (const c of corps) {
      const slim = { id: c.id, company: c.company, discount_rate: c.discount_rate, credit_terms: c.credit_terms, status: c.status, account_manager: c.account_manager, email: c.email };
      if (c.user_id) corpByUserId.set(c.user_id, slim);
      if (c.email) corpByEmail.set(c.email.toLowerCase(), slim);
    }
  } catch {
    // if corporate table missing or error, continue without corporate enrichment
  }
  const attachCorporate = (u: { id: string; email: string }) => {
    const byUser = corpByUserId.get(u.id);
    if (byUser) return byUser;
    const byEm = corpByEmail.get(u.email.toLowerCase());
    return byEm ?? null;
  };

  // Single-user fetch (used by /admin/users/[id] page)
  // id may be full UUID, short 8-char prefix, or referral_code (KS-XXXX)
  if (id) {
    const lower = id.toLowerCase();
    let target = all.find((u) => u.id === id);
    if (!target) target = all.find((u) => u.referral_code?.toLowerCase() === lower);
    if (!target) target = all.find((u) => u.id.toLowerCase().startsWith(lower));
    if (!target) target = all.find((u) => u.id.toLowerCase().slice(0, 8) === lower);
    if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });
    // Staff can only view customers unless superadmin
    if (!isSuper && target.role !== "user") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const corp = attachCorporate(target);
    const user = {
      id: target.id,
      name: target.name,
      email: target.email,
      role: target.role,
      company: target.company,
      phone: target.phone,
      verified: target.verified,
      referral_code: target.referral_code,
      referred_by: target.referred_by,
      referred_by_name: target.referred_by ? (byId.get(target.referred_by) ?? null) : null,
      created_at: target.created_at,
      corporate: corp,
      isCorporate: !!corp && corp.status === "Active",
    };
    return NextResponse.json({ user });
  }

  // Staff (non-superadmin) can only see customers, never other staff accounts.
  const users = all
    .filter((u) => isSuper || u.role === "user")
    .map((u) => {
      const corp = attachCorporate(u);
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        company: u.company,
        phone: u.phone,
        verified: u.verified,
        referral_code: u.referral_code,
        referred_by: u.referred_by,
        created_at: u.created_at,
        corporate: corp,
        isCorporate: !!corp && corp.status === "Active",
      };
    });
  // Resolve the referrer's name for every user that was referred.
  const usersWithReferrer = users.map((u) => ({
    ...u,
    referred_by_name: u.referred_by ? (byId.get(u.referred_by) ?? null) : null,
  }));
  return NextResponse.json({ users: usersWithReferrer });
  } catch (err) {
    console.error("[admin/users] GET error:", (err as Error).message);
    return NextResponse.json({ users: [] });
  }
}

export async function POST(req: Request) {
  const denied = await requireSuperAdmin();
  if (denied) return denied;

  let body: { name?: string; email?: string; password?: string; phone?: string; company?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const name = body.name?.trim();
  const email = body.email?.trim().toLowerCase();
  const password = body.password ?? "";

  if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Enter a valid name and email address" }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });
  }
  if (await getUserByEmail(email)) {
    return NextResponse.json({ error: "An account with this email already exists" }, { status: 409 });
  }

  const user = await createUser({
    name,
    email,
    password,
    role: "admin",
    company: body.company?.trim() || undefined,
    phone: body.phone?.trim() || undefined,
    verified: 1,
  });

  return NextResponse.json(
    { user: { id: user.id, name: user.name, email: user.email, role: user.role } },
    { status: 201 }
  );
}

export async function PATCH(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: { id?: string; role?: string; verified?: boolean; name?: string; email?: string; phone?: string | null; company?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  let target = body.id ? await getUserById(body.id) : undefined;
  if (!target && body.id) {
    const allForPatch = await listUsers();
    const lower = body.id.toLowerCase();
    const found = allForPatch.find((u) => u.id === body.id) ?? allForPatch.find((u) => u.referral_code?.toLowerCase() === lower) ?? allForPatch.find((u) => u.id.toLowerCase().startsWith(lower));
    if (found) target = await getUserById(found.id);
  }
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  if (body.role !== undefined) {
    if (body.role !== "user" && body.role !== "admin" && body.role !== "superadmin") {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }
    const deniedSuper = await requireSuperAdmin();
    if (deniedSuper) return deniedSuper;
    const me = await getSessionUser();
    if (target.id === me?.id) {
      return NextResponse.json({ error: "You cannot change your own role" }, { status: 400 });
    }
    await setUserRole(target.id, body.role);
  }

  if (body.verified !== undefined) {
    await setUserVerified(target.id, body.verified ? 1 : 0);
  }

  // Editing profile fields. Staff accounts are superadmin-only; regular
  // customers may be edited by any staff member.
  if (body.name !== undefined || body.email !== undefined || body.phone !== undefined || body.company !== undefined) {
    const me = await getSessionUser();
    const isStaffTarget = target.role !== "user";
    if (isStaffTarget && me?.role !== "superadmin") {
      return NextResponse.json({ error: "Only the superadmin can edit staff accounts" }, { status: 403 });
    }
    // Corporate is single-source via /admin/corporate/* — block direct user edits for active corporate accounts
    let corp: Awaited<ReturnType<typeof getCorporateAccountByUserId>> | undefined;
    try {
      corp = (await getCorporateAccountByUserId(target.id)) ?? (target.email ? await getCorporateAccountByEmail(target.email) : undefined);
    } catch {}
    const isCorpActive = !!corp && corp.status === "Active";
    if (isCorpActive) {
      const wantsCompany = body.company !== undefined && (body.company?.trim() || "") !== (target.company ?? "");
      const wantsName = body.name !== undefined && body.name.trim() !== target.name;
      const wantsEmail = body.email !== undefined && body.email.trim().toLowerCase() !== target.email.toLowerCase();
      const wantsPhone = body.phone !== undefined && (body.phone?.trim() || "") !== (target.phone ?? "");
      if (wantsCompany || wantsName || wantsEmail || wantsPhone) {
        return NextResponse.json(
          { error: `Corporate account ${corp!.id} (${corp!.company}) is managed via Corporate — edit at /admin/corporate/${corp!.id}` },
          { status: 409 }
        );
      }
    }
    const email = body.email?.trim().toLowerCase();
    if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
    }
    if (email && email !== target.email) {
      const other = await getUserByEmail(email);
      if (other && other.id !== target.id) {
        return NextResponse.json({ error: "An account with this email already exists" }, { status: 409 });
      }
    }
    const name = body.name?.trim();
    if (name !== undefined && !name) {
      return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
    }
    await updateUserProfile(target.id, {
      name: name ?? undefined,
      email: email ?? undefined,
      phone: body.phone === undefined ? undefined : body.phone?.trim() || null,
      company: body.company === undefined ? undefined : body.company?.trim() || null,
    });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const denied = await requireSuperAdmin();
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing user id" }, { status: 400 });

  let target = await getUserById(id);
  if (!target) {
    const allForDel = await listUsers();
    const lower = id.toLowerCase();
    const found = allForDel.find((u) => u.id === id) ?? allForDel.find((u) => u.referral_code?.toLowerCase() === lower) ?? allForDel.find((u) => u.id.toLowerCase().startsWith(lower));
    if (found) target = await getUserById(found.id);
  }
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const me = await getSessionUser();
  if (target.id === me?.id) {
    return NextResponse.json({ error: "You cannot delete your own account" }, { status: 400 });
  }

  await deleteUser(target.id);
  return NextResponse.json({ ok: true });
}

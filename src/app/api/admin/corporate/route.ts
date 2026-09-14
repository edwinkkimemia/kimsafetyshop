import { NextResponse } from "next/server";
import { getSessionUser, requireAdmin } from "@/lib/api-helpers";
import {
  createCorporateAccount,
  getCorporateAccountByApplicationId,
  listCorporateApplications,
  provisionUserLogin,
  setCorporateApplicationStatus,
} from "@/lib/db";
import { sendCorporateWelcomeEmail } from "@/lib/mailer";

const VALID = ["Pending", "Reviewing", "Approved", "Declined"];

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const rows = await listCorporateApplications().catch(() => [] as Awaited<ReturnType<typeof listCorporateApplications>>);
    const applications = rows.map((a) => ({
      ...a,
      documents: JSON.parse(a.documents),
    }));
    return NextResponse.json({ applications });
  } catch (err) {
    console.error("[admin/corporate] error:", (err as Error).message);
    return NextResponse.json({ applications: [] });
  }
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
    return NextResponse.json({ error: "Invalid application id or status" }, { status: 400 });
  }
  const me = await getSessionUser();
  await setCorporateApplicationStatus(body.id, body.status as string, me?.id ?? null, me?.name ?? me?.email ?? null);

  let accountCreated = false;
  let tempPassword: string | undefined;

  // Approving an application provisions the corporate account plus a login
  // for the contact person (temporary password returned once for sharing).
  if (body.status === "Approved") {
    const existing = await getCorporateAccountByApplicationId(body.id);
    if (!existing) {
      const apps = await listCorporateApplications();
      const app = apps.find((a) => a.id === body.id);
      if (app && app.email) {
        const provision = await provisionUserLogin({
          name: app.contact_name || app.company,
          email: app.email,
          phone: app.phone || null,
          company: app.company,
        });
        await createCorporateAccount({
          user_id: provision.user_id,
          application_id: app.id,
          company: app.company,
          kra_pin: app.kra_pin,
          industry: app.industry,
          contact_name: app.contact_name,
          phone: app.phone,
          email: app.email,
          notes: app.notes,
          created_by_id: me?.id ?? null,
          created_by_name: me?.name ?? me?.email ?? null,
        });
        if (provision.createdLogin) {
          // AWAITED — on Vercel serverless un-awaited SMTP sends are frozen
          // mid-flight and the welcome email never leaves the function.
          try {
            await sendCorporateWelcomeEmail({
              to: app.email,
              name: app.contact_name || null,
              company: app.company,
              tempPassword: provision.tempPassword,
            });
          } catch (err) {
            console.error("[corporate] welcome email failed:", err);
          }
        }
        accountCreated = true;
        if (provision.createdLogin) tempPassword = provision.tempPassword;
      }
    }
  }

  return NextResponse.json({ ok: true, accountCreated, tempPassword });
}

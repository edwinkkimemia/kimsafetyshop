import { NextResponse } from "next/server";
import {
  countUnreadNotifications,
  listNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/db";
import { getSessionUser } from "@/lib/api-helpers";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  try {
    // Consolidate to single client would be ideal, but Promise.all with 1 max pool queues;
    // fallback to stale empty on 53300 so header badge doesn't spam retries.
    const [notifications, unread] = await Promise.all([
      listNotificationsForUser(user.id).catch(() => []),
      countUnreadNotifications(user.id).catch(() => 0),
    ]);
    return NextResponse.json({ notifications, unread });
  } catch (err) {
    console.error("[notifications] error:", (err as Error).message);
    return NextResponse.json({ notifications: [], unread: 0 });
  }
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { action?: string; id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (body.action === "readAll") {
    await markAllNotificationsRead(user.id);
    return NextResponse.json({ ok: true });
  }
  if (body.action === "read" && body.id) {
    const owned = (await listNotificationsForUser(user.id)).some((n) => n.id === body.id);
    if (!owned) return NextResponse.json({ error: "Notification not found" }, { status: 404 });
    await markNotificationRead(body.id);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

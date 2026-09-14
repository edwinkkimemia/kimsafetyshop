import { NextResponse } from "next/server";
import { getSettingsWithVersion } from "@/lib/db";
import { DEFAULT_SETTINGS } from "@/lib/settings-defaults";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const { settings, version } = await getSettingsWithVersion();
    return NextResponse.json(
      { settings, version },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  } catch (err) {
    // Last-resort fallback: 53300 should already be handled inside
    // getSettingsWithVersion, but if something else throws we still must
    // not return 500 — store.tsx and useSettings both spam this endpoint
    // and a 500 burst fans out into connection retries.
    console.error("[api/settings] error:", (err as Error).message);
    return NextResponse.json(
      { settings: { ...DEFAULT_SETTINGS }, version: "0" },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }
}

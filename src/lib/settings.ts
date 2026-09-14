"use client";

import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS } from "@/lib/settings-defaults";

// Short TTL so a branding/contact update in Admin → Settings reaches the
// storefront quickly. Branding assets additionally carry a ?v= cache-buster
// (see brandedUrl) derived from the settings version, so the browser never
// shows a stale uploaded logo even within the TTL window.
const CACHE_TTL_MS = 60 * 1000;

let cached: { at: number; data: Record<string, string>; version: string } | null = null;
let inflight: Promise<Record<string, string>> | null = null;

export async function fetchSettings(force = false): Promise<Record<string, string>> {
  const now = Date.now();
  if (!force && cached && now - cached.at < CACHE_TTL_MS) return cached.data;
  // Deduplicate concurrent callers (store.tsx + useSettings both fire on mount
  // at the same ms → previously 2× /api/settings; now 1× with shared promise).
  if (inflight) return inflight;
  inflight = (async () => {
    let data: Record<string, string>;
    let version = "0";
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (!res.ok) throw new Error(`settings ${res.status}`);
      const json = await res.json().catch(() => ({}));
      data = { ...DEFAULT_SETTINGS, ...(json.settings ?? {}) };
      version = typeof json.version === "string" ? json.version : "0";
    } catch {
      if (cached) return cached.data;
      data = { ...DEFAULT_SETTINGS };
    }
    cached = { at: Date.now(), data, version };
    return data;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export function settingsVersion(): string {
  return cached?.version ?? "0";
}

/**
 * Appends the settings version to local branding asset URLs (logo). When the
 * admin saves new settings the URL changes, defeating both the browser cache
 * and the Next.js image optimizer cache.
 */
export function brandedUrl(pathOrUrl: string): string {
  if (!pathOrUrl || /^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const v = settingsVersion();
  if (!v || v === "0") return pathOrUrl;
  return `${pathOrUrl}${pathOrUrl.includes("?") ? "&" : "?"}v=${encodeURIComponent(v)}`;
}

/** Drops the memoized copy — called right after an admin saves settings. */
export function invalidateClientSettings() {
  cached = null;
}

export function useSettings(): Record<string, string> {
  const [settings, setSettings] = useState<Record<string, string>>(DEFAULT_SETTINGS);
  useEffect(() => {
    let active = true;
    // Respect TTL (60s) — force only on first mount if cache empty or stale.
    // Previous `fetchSettings(true)` hammered /api/settings on every visibilitychange.
    fetchSettings().then((s) => {
      if (active) setSettings(s);
    });
    // Pick up cross-tab / visibility updates, but respect TTL and debounce
    // to avoid the 4× at 17:44:36 stampede when tab regains focus.
    let visibleDebounce: ReturnType<typeof setTimeout> | null = null;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (visibleDebounce) clearTimeout(visibleDebounce);
      visibleDebounce = setTimeout(() => {
        fetchSettings().then((s) => {
          if (active) setSettings(s);
        });
      }, 2000);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== "kimsafety-settings-version") return;
      fetchSettings(true).then((s) => {
        if (active) setSettings(s);
      });
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("storage", onStorage);
    return () => {
      active = false;
      if (visibleDebounce) clearTimeout(visibleDebounce);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return settings;
}

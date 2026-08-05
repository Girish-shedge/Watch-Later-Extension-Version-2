/**
 * scanAndScore — optional server-side calendar scan.
 *
 * STATUS: written and correct, but NOT DEPLOYED. The live scan path is the
 * client one (`analyzeAndSavePrefs` + `lib/slot-algorithm.js`), which finishes
 * in single-digit milliseconds. This function only earns its keep once a
 * server-held Google refresh token exists (Trigger B / cron); until then it
 * still needs the caller to hand over a Google access token, which means the
 * popup is already open and could have scanned locally.
 *
 * Writes `calendar_slot_scores` ONLY. Suggestions into `user_slot_preferences`
 * stay client-side, so a rescan can never overwrite a user's chosen days/times.
 *
 * Body: { googleAccessToken: string, timeZone: string, triggeredBy?: string }
 * Auth: Bearer Supabase JWT (verify_jwt = true)
 *
 * Keep scoring behaviour in sync with `lib/slot-algorithm.js`; that file is the
 * reference implementation and is covered by tests/slot-algorithm-stress.js.
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { civilNow, isValidTimeZone, zonedToUtcMs } from "./tz.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SRV_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SLOT_RANGES: Record<string, [number, number]> = {
  "Morning (6–9)": [6, 9],
  "Mid-Morning (9–12)": [9, 12],
  "Afternoon (12–3)": [12, 15],
  "Mid-Afternoon (3–6)": [15, 18],
  "Evening (6–9)": [18, 21],
  "Night (9–12)": [21, 24],
  "Late Night (12–3)": [0, 3],
};
const BUCKET_ORDER = Object.keys(SLOT_RANGES);

const SCAN_LOCK_TTL_MS = 10 * 60 * 1000;
const FAILURE_BACKOFF_MS = 60 * 60 * 1000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** 0=Monday … 6=Sunday, matching calendar_slot_scores.weekday. */
function jsDayToWeekday(jsDay: number) {
  return jsDay === 0 ? 6 : jsDay - 1;
}

type Interval = { start: number; end: number };

/** Sorted, disjoint, clamped. Returns [] rather than a hole when all input is junk. */
function mergeIntervals(raw: unknown, clampStart: number, clampEnd: number): Interval[] {
  if (!Array.isArray(raw)) return [];
  const usable: Interval[] = [];
  for (const b of raw) {
    if (!b) continue;
    let start = Date.parse((b as { start?: string }).start ?? "");
    let end = Date.parse((b as { end?: string }).end ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    // Google can return blocks far outside the query window; clamping keeps the
    // scan bounded regardless of what lands in the response.
    if (start < clampStart) start = clampStart;
    if (end > clampEnd) end = clampEnd;
    if (end > start) usable.push({ start, end });
  }
  if (!usable.length) return [];

  usable.sort((a, b) => a.start - b.start);
  const out: Interval[] = [{ ...usable[0] }];
  for (let i = 1; i < usable.length; i++) {
    const cur = usable[i];
    const last = out[out.length - 1];
    if (cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else out.push({ ...cur });
  }
  return out;
}

/** First index whose interval could overlap `from` (merged list is sorted+disjoint). */
function lowerBound(merged: Interval[], from: number) {
  let lo = 0;
  let hi = merged.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (merged[mid].end <= from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function busyMsInRange(merged: Interval[], from: number, to: number) {
  let ms = 0;
  for (let i = lowerBound(merged, from); i < merged.length; i++) {
    const iv = merged[i];
    if (iv.start >= to) break;
    const s = Math.max(iv.start, from);
    const e = Math.min(iv.end, to);
    if (e > s) ms += e - s;
  }
  return ms;
}

async function fetchFreeBusy(token: string, timeMinIso: string, timeMaxIso: string) {
  const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      items: [{ id: "primary" }],
    }),
  });
  if (!res.ok) throw new Error(`freeBusy HTTP ${res.status}`);

  const body = await res.json();
  const cal = body?.calendars?.primary;
  // Google reports per-calendar failures inside a 200 response. Falling back to
  // an empty array here would score the user's whole calendar as free.
  const calError = cal?.errors?.[0]?.reason;
  if (calError) throw new Error(`freeBusy calendar error: ${calError}`);
  if (!Array.isArray(cal?.busy)) throw new Error("freeBusy: malformed response");
  return cal.busy;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "unauthorized" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return json({ error: "unauthorized" }, 401);

  let body: { googleAccessToken?: string; timeZone?: string; triggeredBy?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const token = body.googleAccessToken;
  const timeZone = body.timeZone;
  const triggeredBy = body.triggeredBy || "background_job";
  if (!token) return json({ error: "missing_google_token" }, 400);
  if (!timeZone || !isValidTimeZone(timeZone)) return json({ error: "invalid_time_zone" }, 400);

  const admin = createClient(SUPABASE_URL, SRV_KEY);

  // Same lock/backoff contract as the popup: a run abandoned mid-flight never
  // writes completed_at, so the in-flight lock has to expire on its own.
  const { data: lastRun } = await admin
    .from("calendar_scan_runs")
    .select("status, started_at, completed_at, not_before")
    .eq("user_id", user.id)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastRun) {
    const now = Date.now();
    const locked = lastRun.status === "running" &&
      !lastRun.completed_at &&
      now - Date.parse(lastRun.started_at) < SCAN_LOCK_TTL_MS;
    const backedOff = lastRun.not_before && now < Date.parse(lastRun.not_before);
    if (locked || backedOff) return json({ ok: true, status: "skipped" });
  }

  // Window: first day of last month → last day of next month, in the user's zone.
  const { y, monthIdx } = civilNow(timeZone);
  const startMs = zonedToUtcMs(y, monthIdx - 1, 1, 0, timeZone);
  const endExclusiveMs = zonedToUtcMs(y, monthIdx + 2, 1, 0, timeZone);

  const { data: run } = await admin
    .from("calendar_scan_runs")
    .insert({
      user_id: user.id,
      window_start: new Date(startMs).toISOString().slice(0, 10),
      window_end: new Date(endExclusiveMs - 1).toISOString().slice(0, 10),
      status: "running",
      triggered_by: triggeredBy,
    })
    .select("id")
    .single();

  let busy: unknown;
  try {
    busy = await fetchFreeBusy(
      token,
      new Date(startMs).toISOString(),
      new Date(endExclusiveMs).toISOString(),
    );
  } catch (e) {
    const errorReason = String((e as Error)?.message ?? e);
    if (run?.id) {
      await admin.from("calendar_scan_runs").update({
        status: "failed",
        error_reason: errorReason,
        completed_at: new Date().toISOString(),
        not_before: new Date(Date.now() + FAILURE_BACKOFF_MS).toISOString(),
      }).eq("id", run.id);
    }
    return json({ ok: false, status: "failed", errorReason });
  }

  const cfg = { FREE_RATIO_THRESHOLD: 0.8, MIN_SAMPLE_SIZE: 3, ALGORITHM_VERSION: 1 };
  const { data: cfgRows } = await admin.from("slot_algorithm_config").select("key, value");
  for (const row of cfgRows ?? []) {
    if (row.key in cfg && row.value != null) {
      (cfg as Record<string, number>)[row.key] = Number(row.value);
    }
  }

  const merged = mergeIntervals(busy, startMs, endExclusiveMs);

  const grid: Record<number, Record<string, { free: number; total: number }>> = {};
  for (let w = 0; w < 7; w++) {
    grid[w] = {};
    for (const bucket of BUCKET_ORDER) grid[w][bucket] = { free: 0, total: 0 };
  }

  // Walk civil dates (pure calendar arithmetic), resolving each bucket's
  // boundaries back to real instants in the user's zone.
  for (let cursor = new Date(Date.UTC(y, monthIdx - 1, 1)); ; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const cy = cursor.getUTCFullYear();
    const cm = cursor.getUTCMonth();
    const cd = cursor.getUTCDate();
    const dayStartMs = zonedToUtcMs(cy, cm, cd, 0, timeZone);
    if (dayStartMs >= endExclusiveMs) break;

    const weekday = jsDayToWeekday(cursor.getUTCDay());
    for (const bucket of BUCKET_ORDER) {
      const [h0, h1] = SLOT_RANGES[bucket];
      const s0 = zonedToUtcMs(cy, cm, cd, h0, timeZone);
      // Night (21–24) ends at midnight of the following calendar day.
      const s1 = h1 === 24
        ? zonedToUtcMs(cy, cm, cd + 1, 0, timeZone)
        : zonedToUtcMs(cy, cm, cd, h1, timeZone);

      const winMs = s1 - s0;
      if (winMs <= 0) continue;

      const freeRatio = Math.min(1, Math.max(0, 1 - busyMsInRange(merged, s0, s1) / winMs));
      grid[weekday][bucket].total += 1;
      if (freeRatio >= cfg.FREE_RATIO_THRESHOLD) grid[weekday][bucket].free += 1;
    }
  }

  const scannedAt = new Date().toISOString();
  const rows = [];
  for (let w = 0; w < 7; w++) {
    for (const bucket of BUCKET_ORDER) {
      const cell = grid[w][bucket];
      const lowSample = cell.total < cfg.MIN_SAMPLE_SIZE;
      rows.push({
        user_id: user.id,
        weekday: w,
        time_bucket: bucket,
        score: lowSample ? 0.5 : Math.round((cell.free / cell.total) * 1000) / 1000,
        sample_size: cell.total,
        confidence: lowSample ? "low" : "normal",
        algorithm_version: cfg.ALGORITHM_VERSION,
        scanned_at: scannedAt,
      });
    }
  }

  const { error: upsertErr } = await admin
    .from("calendar_slot_scores")
    .upsert(rows, { onConflict: "user_id,weekday,time_bucket" });

  if (upsertErr) {
    if (run?.id) {
      await admin.from("calendar_scan_runs").update({
        status: "failed",
        error_reason: `score upsert failed: ${upsertErr.message}`,
        completed_at: new Date().toISOString(),
        not_before: new Date(Date.now() + FAILURE_BACKOFF_MS).toISOString(),
      }).eq("id", run.id);
    }
    return json({ ok: false, status: "failed", errorReason: upsertErr.message });
  }

  if (run?.id) {
    await admin.from("calendar_scan_runs")
      .update({ status: "success", completed_at: scannedAt })
      .eq("id", run.id);
  }

  return json({ ok: true, status: "success", rows: rows.length, timeZone });
});

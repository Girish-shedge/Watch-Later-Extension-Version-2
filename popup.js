// popup.js
let availableSlots = [];
let selectedSlotData  = null;
let cachedVideoTitle  = '';
let cachedVideoUrl    = '';
let currentAuthUser   = null;

function setScheduleBtnLabel(text) {
  const btn = document.getElementById('scheduleBtn');
  if (!btn) return;
  const inner = btn.querySelector('.onb-btn-inner');
  if (inner) inner.textContent = text;
  else btn.textContent = text;
}

function formatDurationLabel(totalSec) {
  const s = Math.max(0, Math.floor(totalSec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  // e.g. 1:30:55 | 34:50 | 00:30
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

// "12:34" / "1:02:03" → seconds. Used by duration fetch + selfcheck.
function parseClockDuration(label) {
  if (!label) return 0;
  const parts = String(label).trim().split(':').map(Number);
  if (!parts.length || parts.some(n => !Number.isFinite(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

/** "12 days" / "2 hrs" / "15 mins" — largest unit that still fits. */
function formatRelativeDuration(ms) {
  const mins = Math.max(0, Math.floor(Math.abs(ms) / 60000));
  if (mins < 60) return mins <= 1 ? '1 min' : `${mins} mins`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs === 1 ? '1 hr' : `${hrs} hrs`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

/** Figma schedule stamp: 28/07/22 at 07:22 PM */
function formatHistoryScheduledFor(startTime, now = new Date()) {
  const dt = new Date(startTime);
  if (Number.isNaN(dt.getTime())) return 'Scheduled for —';
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yy = String(dt.getFullYear()).slice(-2);
  const time = dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `Scheduled for ${dd}/${mm}/${yy} at ${time}`;
}

function formatHistoryUpcomingLabel(startTime, now = new Date()) {
  const start = new Date(startTime);
  if (Number.isNaN(start.getTime())) return null;
  const ms = start - now;
  if (ms <= 0 || ms > 24 * 60 * 60 * 1000) return null;
  return `Upcoming in ${formatRelativeDuration(ms)}`;
}

function formatHistoryMissedLabel(endTime, now = new Date()) {
  const end = new Date(endTime);
  if (Number.isNaN(end.getTime()) || now <= end) return null;
  return `Unwatched & Missed since ${formatRelativeDuration(now - end)}`;
}

function formatHistoryMovedToWatched(watchedAt, now = new Date()) {
  const at = new Date(watchedAt);
  if (Number.isNaN(at.getTime())) return 'Moved to Watched';
  return `Moved to Watched ${formatRelativeDuration(now - at)} ago`;
}

function filterHistoryByTitle(list, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list.slice();
  return list.filter(item => String(item.title || '').toLowerCase().includes(q));
}

function paginateList(list, page, pageSize) {
  const size = Math.max(1, pageSize | 0);
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / size) || 1);
  const p = Math.min(Math.max(1, page | 0), pages);
  const start = (p - 1) * size;
  return {
    page: p,
    pages,
    total,
    start: total ? start + 1 : 0,
    end: Math.min(start + size, total),
    items: list.slice(start, start + size)
  };
}

// chrome:// edge:// about: etc. — scripting.executeScript throws / lastError if we touch them.
function isRestrictedBrowserUrl(url) {
  return !url || /^(chrome|edge|about|devtools|chrome-extension|brave|opera|vivaldi):\/\//i.test(url);
}

function getActiveInjectableTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs?.[0];
      if (!tab?.id || isRestrictedBrowserUrl(tab.url)) return resolve(null);
      resolve(tab);
    });
  });
}

async function getVideoDurationSeconds() {
  const tab = await getActiveInjectableTab();
  if (!tab) return 0;
  return new Promise(resolve => {
    // Prefer player chrome / ytInitialPlayerResponse over <video>.duration —
    // during ads video.duration is the ad length, not the content.
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const parseClock = (label) => {
          if (!label) return 0;
          const parts = String(label).trim().split(':').map(Number);
          if (!parts.length || parts.some(n => !Number.isFinite(n))) return 0;
          if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
          if (parts.length === 2) return parts[0] * 60 + parts[1];
          return parts[0];
        };

        const fromLabel = parseClock(
          document.querySelector('.ytp-time-duration')?.textContent
        );
        if (fromLabel > 0) return fromLabel;

        try {
          const len = Number(window.ytInitialPlayerResponse?.videoDetails?.lengthSeconds);
          if (Number.isFinite(len) && len > 0) return len;
        } catch (_) { /* ignore */ }

        try {
          const raw = window.ytplayer?.config?.args?.player_response;
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const len = Number(parsed?.videoDetails?.lengthSeconds);
          if (Number.isFinite(len) && len > 0) return len;
        } catch (_) { /* ignore */ }

        const video = document.querySelector('video');
        if (video && Number.isFinite(video.duration) && video.duration > 0) {
          return video.duration;
        }
        return 0;
      }
    }, results => {
      // Reading lastError clears the "Unchecked runtime.lastError" banner.
      void chrome.runtime.lastError;
      resolve(results?.[0]?.result || 0);
    });
  });
}

async function getVideoDurationInMinutes() {
  const sec = await getVideoDurationSeconds();
  return sec ? Math.ceil(sec / 60) : 0;
}

function populateDropdown(slots) {
  const grid = document.getElementById('slotGrid');
  if (!grid) return;
  grid.innerHTML = '';

  // Figma schedule sheet shows 4 slot cards max.
  slots = Array.isArray(slots) ? slots.slice(0, 4) : [];

  if (!slots.length) {
    grid.innerHTML = '<p class="sched-sheet-label">No slots available</p>';
    selectedSlotData = null;
    return;
  }

  const fmtDate = (d) =>
    `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  const fmtWeekday = (d) => d.toLocaleDateString('en-US', { weekday: 'long' });
  const fmtTime = (d) =>
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  slots.forEach((slot, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sched-slot' + (index === 0 ? ' selected' : '');
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
    btn.dataset.index = String(index);

    if (slot.quickLabel) {
      btn.innerHTML =
        `<div class="sched-slot-head"><span>Quick</span><span></span></div>` +
        `<div class="sched-slot-time">${slot.quickLabel}</div>`;
    } else {
      const start = new Date(slot.start);
      const end = new Date(slot.end);
      btn.innerHTML =
        `<div class="sched-slot-head"><span>${fmtDate(start)}</span><span>${fmtWeekday(start)}</span></div>` +
        `<div class="sched-slot-time">${fmtTime(start)} - ${fmtTime(end)}</div>`;
    }

    btn.addEventListener('click', () => {
      grid.querySelectorAll('.sched-slot').forEach(el => {
        el.classList.remove('selected');
        el.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('selected');
      btn.setAttribute('aria-selected', 'true');
      selectedSlotData = slots[index];
    });

    grid.appendChild(btn);
  });

  selectedSlotData = slots[0];
}


// YouTube thumbnail URLs (HD first). maxres often 200s a 120×90 placeholder — we detect that.
function getYouTubeThumbnail(videoUrl) {
  try {
    const videoId = new URL(videoUrl).searchParams.get('v');
    return videoId
      ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`
      : null;
  } catch {
    return null;
  }
}

function youtubeThumbCandidates(videoUrl) {
  try {
    const videoId = new URL(videoUrl).searchParams.get('v');
    if (!videoId) return [];
    return [
      `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      `https://img.youtube.com/vi/${videoId}/sddefault.jpg`
    ];
  } catch {
    return [];
  }
}

// Loads maxres → hq → sd into one or more <img>s. Skips the tiny 120px maxres placeholder.
function setYouTubeThumbnail(targets, videoUrl) {
  const els = (Array.isArray(targets) ? targets : [targets]).filter(Boolean);
  const urls = youtubeThumbCandidates(videoUrl);
  if (!els.length || !urls.length) return;
  let i = 0;
  const tryNext = () => {
    if (i >= urls.length) return;
    const url = urls[i++];
    const probe = new Image();
    probe.onload = () => {
      // YouTube serves a 120×90 grey stub for missing maxres with HTTP 200
      if (probe.naturalWidth < 200 && i < urls.length) return tryNext();
      els.forEach(el => { el.src = url; });
    };
    probe.onerror = tryNext;
    probe.src = url;
  };
  tryNext();
}

async function handleRemove(item, row) {
  // 1) Delete the Calendar event if present
  const token = (await chrome.storage.local.get('google_access_token')).google_access_token;
  if (item.google_event_id) {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(item.google_event_id)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok && ![404,410].includes(res.status)) {
      console.error('Calendar delete failed', await res.text());
      return showToast('⚠️ Could not remove event');
    }
  }
  // 2) Delete the row from Supabase
  const { error } = await supabaseClient
    .from('videohistory')
    .delete()
    .eq('id', item.id);
  if (error) {
    console.error('❌ Delete history row failed:', error);
    return showToast('⚠️ Could not remove video from history');
  }
  // 3) Persist hidden‐list so it never comes back
  chrome.storage.local.get('hiddenHistory', ({ hiddenHistory }) => {
    const hidden = Array.isArray(hiddenHistory) ? hiddenHistory : [];
    if (!hidden.includes(item.id)) {
      hidden.push(item.id);
      chrome.storage.local.set({ hiddenHistory: hidden });
    }
  });
  // 4) Remove from UI
  row.remove();
  showToast('✅ Video Removed');
}


// ← new helper
// At the top of popup.js, make sure you have this helper:
async function fetchEventTimes(token, eventId) {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?fields=start,end`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error('FETCH_EVENT_FAILED');
  const { start, end } = await res.json();
  return {
    start: new Date(start.dateTime || start.date).toISOString(),
    end:   new Date(end.dateTime   || end.date).toISOString()
  };
}


function getVideoTitle() {
  return getActiveInjectableTab().then(tab => {
    if (!tab) return null;
    return new Promise(resolve => {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const sel = 'ytd-video-primary-info-renderer h1 yt-formatted-string';
          const el  = document.querySelector(sel);
          if (el && el.textContent) return el.textContent.trim();
          return document.title.replace(/ - YouTube$/, '').trim() || null;
        }
      }, results => {
        void chrome.runtime.lastError;
        resolve(results?.[0]?.result ?? null);
      });
    });
  });
}


const SUPABASE_URL = 'https://ayzqfwtoeckgycmqzlve.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5enFmd3RvZWNrZ3ljbXF6bHZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4NTkxODksImV4cCI6MjA1OTQzNTE4OX0.cE10nS3wtqN00wZX3uq_905H4MTj9VfDVPxpopRp_Dw';
// persistSession/autoRefreshToken off: chrome.storage.local is the single source of truth.
// Multiple supabase-js clients each rotating the refresh token is what caused the
// "refresh_token_already_used" revocations → forced re-logins.
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// Write rotated tokens back so the next popup/worker uses the fresh pair.
async function persistSupabaseSession(session) {
  if (!session) return;
  await chrome.storage.local.set({
    supabase_token: session.access_token,
    supabase_refresh: session.refresh_token
  });
}

/**
 * Record a button click in Supabase.
 * @param {string} name  The human‐readable button name
 */
async function recordButtonClick(name) {
  // get the current user
  const {
    data: { user },
    error: authErr
  } = await supabaseClient.auth.getUser();

  if (authErr || !user) {
    console.warn('⚠️ Cannot track click, user not authenticated');
    return;
  }

  const { error: trackErr } = await supabaseClient
    .from('button_clicks')
    .insert([{ user_id: user.id, button_name: name }]);

  if (trackErr) {
    console.error('❌ Button‐click tracking failed:', trackErr.message);
  }
}


const SLOT_RANGES = {
  "Morning (6–9)": [6, 9],
  "Mid-Morning (9–12)": [9, 12],
  "Afternoon (12–3)": [12, 15],
  "Mid-Afternoon (3–6)": [15, 18],
  "Evening (6–9)": [18, 21],
  "Night (9–12)": [21, 24],
  "Late Night (12–3)": [0, 3],
};

/** Mon–Sat chips; Sunday lives on the day-prefs banner. */
const PREFS_DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const PREFS_DAY_LABELS = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday',
  thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};
const PREFS_DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Six daytime chips; late night is the time-prefs banner. */
const PREFS_TIME_DEFS = [
  { key: 'Morning (6–9)', label: '6AM - 9AM' },
  { key: 'Mid-Morning (9–12)', label: '9AM - 12PM' },
  { key: 'Afternoon (12–3)', label: '12PM - 3PM' },
  { key: 'Mid-Afternoon (3–6)', label: '3PM - 6PM' },
  { key: 'Evening (6–9)', label: '6PM - 9PM' },
  { key: 'Night (9–12)', label: '9PM - 12AM' },
];
const PREFS_NIGHT_KEY = 'Late Night (12–3)';
const DEFAULT_PREF_DAYS = ['tue', 'wed', 'sat'];
const DEFAULT_PREF_SLOTS = ['Evening (6–9)', 'Night (9–12)', 'Afternoon (12–3)'];

function prefsBusyHint(freeness) {
  if (freeness >= 0.6) return 'Free days';
  if (freeness >= 0.35) return 'Moderately busy';
  return 'Occupied';
}

function pickTopKeys(scoreByKey, keys, n) {
  return [...keys]
    .sort((a, b) => (scoreByKey[b] || 0) - (scoreByKey[a] || 0))
    .slice(0, n);
}

/** Clip busy intervals into [rangeStart, rangeEnd] and sum overlap ms. */
function busyMsInRange(busy, rangeStart, rangeEnd) {
  const rs = +rangeStart;
  const re = +rangeEnd;
  if (!(re > rs)) return 0;
  let ms = 0;
  for (const b of busy) {
    const bs = +new Date(b.start);
    const be = +new Date(b.end);
    const s = Math.max(bs, rs);
    const e = Math.min(be, re);
    if (e > s) ms += e - s;
  }
  return ms;
}

/**
 * Score preferred weekdays + SLOT_RANGES windows from freeBusy blocks.
 * Returns top-3 days / slots plus Free / Moderately busy / Occupied hints.
 */
function scoreCalendarPrefs(busy, timeMin, timeMax, slotRanges = SLOT_RANGES) {
  const dayFree = Object.fromEntries(PREFS_DOW.map(k => [k, { free: 0, total: 0 }]));
  const slotFree = Object.fromEntries(
    Object.keys(slotRanges).map(k => [k, { free: 0, total: 0 }])
  );

  const start = new Date(timeMin);
  start.setHours(0, 0, 0, 0);
  const end = new Date(timeMax);

  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    const dayKey = PREFS_DOW[d.getDay()];
    const dayStart = new Date(d);
    const dayEnd = new Date(d);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const dayMs = +dayEnd - +dayStart;
    const busyMs = busyMsInRange(busy, dayStart, dayEnd);
    dayFree[dayKey].total += dayMs;
    dayFree[dayKey].free += Math.max(0, dayMs - busyMs);

    for (const [slot, [h0, h1]] of Object.entries(slotRanges)) {
      const s0 = new Date(d);
      s0.setHours(h0, 0, 0, 0);
      const s1 = new Date(d);
      s1.setHours(h1, 0, 0, 0);
      const winMs = +s1 - +s0;
      if (winMs <= 0) continue;
      const bMs = busyMsInRange(busy, s0, s1);
      slotFree[slot].total += winMs;
      slotFree[slot].free += Math.max(0, winMs - bMs);
    }
  }

  const dayScores = {};
  const dayHints = {};
  for (const k of PREFS_DOW) {
    const t = dayFree[k].total || 1;
    const f = dayFree[k].free / t;
    dayScores[k] = f;
    dayHints[k] = prefsBusyHint(f);
  }
  const slotScores = {};
  const slotHints = {};
  for (const k of Object.keys(slotRanges)) {
    const t = slotFree[k].total || 1;
    const f = slotFree[k].free / t;
    slotScores[k] = f;
    slotHints[k] = prefsBusyHint(f);
  }

  const days = pickTopKeys(dayScores, PREFS_DOW, 3);
  const slots = pickTopKeys(slotScores, Object.keys(slotRanges), 3);
  return { days, slots, dayHints, slotHints, dayScores, slotScores };
}

 document.addEventListener('DOMContentLoaded', () => {
   // if the user has “dark” saved, apply it immediately
   if (localStorage.getItem('theme') === 'dark') {
     document.body.classList.add('dark-mode');
   }
   updateThemeIcon();
   if (window.__WL_PREVIEW__) {
     startPreviewMode();
     return;
   }
   initPopup();
 });

if (localStorage.getItem('theme') === 'dark') {
  document.body.classList.add('dark-mode');
}



function showSkeleton(kind = 'schedule') {
  const layer = document.getElementById('skeletonLayer');
  if (!layer) return;
  layer.classList.remove('hidden');
  layer.querySelectorAll('.skel-screen').forEach(el => {
    const on = el.getAttribute('data-skel') === kind;
    el.classList.toggle('is-active', on);
    el.setAttribute('aria-hidden', on ? 'false' : 'true');
  });
}

function hideSkeleton() {
  document.getElementById('skeletonLayer')?.classList.add('hidden');
}

function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");

  setTimeout(() => {
    toast.classList.remove("show");
  }, 2500);
}

/** Preview boot: logged-out onboarding; click through like the real extension. */
function startPreviewMode() {
  document.body.classList.add('wl-preview');
  hideNetworkLostScreen();
  hideSkeleton();
  document.getElementById('realContent')?.classList.remove('hidden');
  chrome.storage.local.remove(
    ['supabase_token', 'supabase_refresh', 'google_access_token', 'userId'],
    () => showOnboarding()
  );
}

/** Fill schedule UI with random dummy video + slots (keeps onboarding visible if open). */
function paintPreviewSchedule() {
  hideSkeleton();
  hideNetworkLostScreen();
  document.getElementById('realContent')?.classList.remove('hidden');

  const samples = [
    {
      src: 'Icon/preview/01-south-china-sea.png',
      title: 'Is China Preparing for War? | South China Sea Update',
      durationSec: 14 * 60 + 32
    },
    {
      src: 'Icon/preview/02-time-story.png',
      title: 'TIME STORY (4K Ultra HD) | Full Movie | Shemaroo',
      durationSec: 2 * 3600 + 18 * 60 + 5
    },
    {
      src: 'Icon/preview/03-billionaire-brain.png',
      title: 'Billionaire Brain Secrets | Figuring Out with Raj Shamani',
      durationSec: 58 * 60 + 41
    },
    {
      src: 'Icon/preview/04-avengers-doomsday.png',
      title: 'Marvel Studios’ Avengers: Doomsday | Official Hindi Trailer',
      durationSec: 2 * 60 + 47
    },
    {
      src: 'Icon/preview/05-big-bang.png',
      title: 'The First Hour of the Big Bang | Explained by Sufiyan',
      durationSec: 22 * 60 + 18
    }
  ];
  const pick = samples[Math.floor(Math.random() * samples.length)];
  const jitter = Math.round(pick.durationSec * (0.85 + Math.random() * 0.3));
  const durationSec = Math.max(30, jitter);

  hideWrongUrlPanel();
  document.getElementById('schedSheet')?.classList.remove('is-prefs');

  const thumbEl = document.getElementById('videoThumb');
  const bgEl = document.getElementById('schedBgImg');
  if (thumbEl) thumbEl.src = pick.src;
  if (bgEl) bgEl.src = pick.src;

  const titleEl = document.getElementById('videoTitle');
  if (titleEl) titleEl.textContent = pick.title;

  const durEl = document.getElementById('videoDuration');
  if (durEl) durEl.textContent = formatDurationLabel(durationSec);

  const now = Date.now();
  const slots = [0, 1, 2, 3].map(i => {
    const start = new Date(now + (i + 1) * 60 * 60 * 1000);
    start.setMinutes(0, 0, 0);
    const end = new Date(start.getTime() + Math.ceil(durationSec / 60) * 60 * 1000);
    return { start: start.toISOString(), end: end.toISOString() };
  });
  availableSlots = slots;
  populateDropdown(slots);
  cachedVideoTitle = pick.title;
  cachedVideoUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  saveLastScheduleSnapshot().then(() => {
    void ensureWatchUrlGate().then(ok => {
      if (ok) return;
      const fixBtn = document.getElementById('wrongUrlFixBtn');
      if (fixBtn) {
        fixBtn.onclick = () => {
          chrome.tabs.update(1, { url: WRONG_URL_FIX });
          paintPreviewSchedule();
          showToast('Preview — sample watch page loaded');
        };
      }
    });
  });

  const scheduleBtn = document.getElementById('scheduleBtn');
  if (scheduleBtn) {
    scheduleBtn.style.display = 'flex';
    scheduleBtn.disabled = false;
    scheduleBtn.onclick = () => {
      const slot = availableSlots?.[0];
      showScheduleSuccessModal({
        title: cachedVideoTitle || document.getElementById('videoTitle')?.textContent,
        start: slot?.start || new Date().toISOString(),
        end: slot?.end || new Date(Date.now() + 3600000).toISOString()
      });
    };
  }

  if (!paintPreviewSchedule._wired) {
    paintPreviewSchedule._wired = true;
    document.getElementById('menuBtn')?.addEventListener('click', () => {
      document.getElementById('profileMenu')?.classList.toggle('hidden');
    });
    document.getElementById('closePopup')?.addEventListener('click', () => {
      showToast('Preview mode — close is a no-op here');
    });
    document.getElementById('logoutBtn')?.addEventListener('click', () => {
      document.getElementById('profileMenu')?.classList.add('hidden');
      chrome.storage.local.remove(
        ['supabase_token', 'supabase_refresh', 'google_access_token', 'userId'],
        () => startPreviewMode()
      );
    });
    document.getElementById('viewHistory')?.addEventListener('click', () => {
      document.getElementById('profileMenu')?.classList.add('hidden');
      openHistoryModal('preview-user');
    });
    wireSchedPrefs('preview-user');
  }
}

async function ensureValidGoogleToken() {
  const { google_access_token } = await new Promise(res =>
    chrome.storage.local.get("google_access_token", res)
  );

  if (!google_access_token) return false;

  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${google_access_token}` }
    });

    if (res.status === 401) {
      // Expected path — don't console.warn (Chrome lists warns as extension errors).
      // Silent first: no consent screen if the user is still signed in to Google.
      const silentOk = await new Promise(resolve =>
        chrome.runtime.sendMessage({ action: 'login', silent: true }, resp => {
          void chrome.runtime.lastError;
          resolve(!!resp?.success);
        })
      );
      if (silentOk) return true;

      showToast("🔄 Re-authenticating Google access...");
      return new Promise(resolve => {
        chrome.runtime.sendMessage({ action: 'login' }, resp => {
          void chrome.runtime.lastError;
          if (resp?.success) {
            showToast("✅ Reconnected to Google!");
            resolve(true);
          } else {
            showToast("❌ Google login failed.");
            resolve(false);
          }
        });
      });
    }

    return true;
  } catch (err) {
    console.error("❌ Token check failed:", err);
    return false;
  }
}

// 🚫 Offline modal (Figma 36:3008) over current screen + fact carousel
const OFFLINE_FACTS = [
  'There are only 158 leap years in the entire planet and solar system!',
  'Honey never spoils — jars from ancient tombs were still edible.',
  'Octopuses have three hearts and blue blood.',
  'Bananas are berries, but strawberries aren’t.',
  'A group of flamingos is called a flamboyance.',
  'YouTube users watch over a billion hours of video every day.',
  'Your calendar has more free slots than you think — we checked.',
  'Wombat poop is cube-shaped so it doesn’t roll away.',
];
const OFFLINE_FACT_COUNT = 5;
const OFFLINE_FACT_MS = 3000;

let offlineFactTimer = null;
let offlineFactIndex = 0;
let offlineFactBatch = [];

/** Shuffle array copy (Fisher–Yates). */
function shuffleCopy(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

function pickOfflineFacts(n = OFFLINE_FACT_COUNT) {
  return shuffleCopy(OFFLINE_FACTS).slice(0, Math.min(n, OFFLINE_FACTS.length));
}

function setOfflineTicker(active) {
  document.querySelectorAll('#offlineTicker .offline-tick').forEach((el, i) => {
    el.classList.toggle('active', i === active);
  });
}

function paintOfflineFact(index, { fade = true } = {}) {
  const el = document.getElementById('offlineFactText');
  if (!el || !offlineFactBatch.length) return;
  const text = offlineFactBatch[index % offlineFactBatch.length];
  const apply = () => {
    el.textContent = text;
    el.classList.remove('is-fading');
    setOfflineTicker(index % OFFLINE_FACT_COUNT);
  };
  if (!fade) return apply();
  el.classList.add('is-fading');
  setTimeout(apply, 180);
}

function stopOfflineFacts() {
  if (offlineFactTimer) {
    clearInterval(offlineFactTimer);
    offlineFactTimer = null;
  }
}

function startOfflineFacts() {
  stopOfflineFacts();
  offlineFactBatch = pickOfflineFacts(OFFLINE_FACT_COUNT);
  offlineFactIndex = 0;
  paintOfflineFact(0, { fade: false });
  offlineFactTimer = setInterval(() => {
    offlineFactIndex = (offlineFactIndex + 1) % offlineFactBatch.length;
    paintOfflineFact(offlineFactIndex);
  }, OFFLINE_FACT_MS);
}

function offlineMountParent() {
  if (document.body.classList.contains('onboarding-active')) {
    return document.getElementById('onboarding');
  }
  return document.getElementById('scheduleScreen') || document.getElementById('popupWrapper') || document.body;
}

function showNetworkLostScreen() {
  const overlay = document.getElementById('networkLostScreen');
  if (!overlay) return;
  const host = offlineMountParent();
  if (host && overlay.parentElement !== host) host.appendChild(overlay);

  hideSkeleton();
  document.getElementById('realContent')?.classList.remove('hidden');

  overlay.hidden = false;
  overlay.classList.remove('hidden');
  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('is-offline');
  startOfflineFacts();
}

function hideNetworkLostScreen() {
  stopOfflineFacts();
  const overlay = document.getElementById('networkLostScreen');
  document.body.classList.remove('is-offline');
  if (!overlay) return;
  overlay.classList.remove('is-open');
  overlay.classList.add('hidden');
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
}

// ── Onboarding (logged-out only; always restarts at screen 1) ──
/** After one scroll step, top card moves to the end (infinite recycle). */
function recycleOnbCardOrder(ids) {
  if (!ids.length) return ids.slice();
  return ids.slice(1).concat(ids[0]);
}

/** Carousel slot: 3 visible — top/bottom 95%, middle 100%; ease morph via paintOnbCardSlots. */
function onb1CardSlot(index, phase) {
  const edge = { width: '95%', opacity: '1' };
  const mid = { width: '100%', opacity: '1' };
  const hidden = { width: '95%', opacity: '0' };
  if (phase === 'rest') {
    if (index === 0) return edge;
    if (index === 1) return mid;
    if (index === 2) return edge;
    return hidden;
  }
  // During scroll: top fades out; mid→top; bottom→mid; next fades in as bottom
  if (index === 0) return { width: '95%', opacity: '0' };
  if (index === 1) return edge;
  if (index === 2) return mid;
  if (index === 3) return edge;
  return hidden;
}

/** Ascending day counts for onboarding cards: start, start+step, … */
function ascendingOnbDays(count, start = 7, step = 7) {
  return Array.from({ length: count }, (_, i) => start + i * step);
}

function formatOnbUnwatchedLabel(days) {
  return `Unwatched since ${days} days`;
}

function formatOnbWatchedLabel(days) {
  return `Watched since ${days} days`;
}

/** Paint labels in ascending order; returns the last day used (for recycle continuation). */
function seedOnbCardLabels(root, formatLabel, start = 7, step = 7) {
  const labels = [...root.querySelectorAll('.onb-label')];
  const days = ascendingOnbDays(labels.length, start, step);
  labels.forEach((el, i) => { el.textContent = formatLabel(days[i]); });
  return days.length ? days[days.length - 1] : start - step;
}

let onbCardAnim = null; // { abort, stack }

/** Abort loop but freeze stack mid-motion (no transform reset — avoids page-transition jerk). */
function pauseOnbCardScroll() {
  const prev = onbCardAnim;
  if (!prev) return;
  prev.abort = true;
  onbCardAnim = null;
  const stack = prev.stack;
  if (!stack) return;
  const frozen = getComputedStyle(stack).transform;
  stack.style.transition = 'none';
  stack.style.transform = frozen === 'none' ? '' : frozen;
}

function stopOnbCardScroll() {
  pauseOnbCardScroll();
  // clear freeze leftovers on both slide stacks
  ['#onboarding1', '#onboarding2'].forEach(sel => {
    const stack = document.querySelector(`${sel} .onb-cards`);
    if (!stack) return;
    stack.style.transition = '';
    stack.style.transform = '';
    stack.querySelectorAll('.onb-card').forEach(c => {
      c.style.transition = '';
      c.style.opacity = '';
      c.style.width = '';
    });
  });
}

function paintOnbCardSlots(stack, phase, durationMs) {
  const cards = [...stack.children];
  if (durationMs > 0) {
    const ease = `width ${durationMs}ms ease-in-out, opacity ${durationMs}ms ease-in-out`;
    cards.forEach(c => { c.style.transition = ease; });
    void stack.offsetHeight;
  } else {
    cards.forEach(c => { c.style.transition = 'none'; });
  }
  cards.forEach((c, i) => {
    const s = onb1CardSlot(i, phase);
    c.style.width = s.width;
    c.style.opacity = s.opacity;
  });
}

/** Slides 1–2: 3 visible cards; mid 100% / edges 95%; morph ease-in-out while scrolling. */
function startOnbCardScroll(screenSel, formatLabel) {
  stopOnbCardScroll();
  const stack = document.querySelector(`${screenSel} .onb-cards`);
  if (!stack) return;
  const state = { abort: false, stack };
  onbCardAnim = state;
  // ponytail: smooth carousel pace; upgrade via Figma motion tokens if they land
  const DURATION_MS = 1600;
  const PAUSE_MS = 900;
  const DAY_STEP = 7;
  const wait = ms => new Promise(r => setTimeout(r, ms));

  let nextDay = seedOnbCardLabels(stack, formatLabel, 7, DAY_STEP) + DAY_STEP;
  paintOnbCardSlots(stack, 'rest', 0);

  (async function loop() {
    while (!state.abort) {
      const first = stack.firstElementChild;
      const second = first?.nextElementSibling;
      if (!first) break;
      // Auto space-between: pitch = live distance between card tops
      const step = second
        ? (second.offsetTop - first.offsetTop)
        : first.offsetHeight;
      stack.style.transition = `transform ${DURATION_MS}ms ease-in-out`;
      void stack.offsetHeight;
      paintOnbCardSlots(stack, 'end', DURATION_MS);
      stack.style.transform = `translateY(-${step}px)`;
      await wait(DURATION_MS);
      if (state.abort) break;
      stack.style.transition = 'none';
      stack.appendChild(first);
      const recycledLabel = first.querySelector('.onb-label');
      if (recycledLabel) {
        recycledLabel.textContent = formatLabel(nextDay);
        nextDay += DAY_STEP;
      }
      stack.style.transform = 'translateY(0)';
      paintOnbCardSlots(stack, 'rest', 0);
      void stack.offsetHeight;
      await wait(PAUSE_MS);
    }
  })();
}

/** First paint / page change: cards ease in from below, then the carousel runs. */
async function enterOnbCardsThenPlay(screenSel, formatLabel) {
  const stack = document.querySelector(`${screenSel} .onb-cards`);
  const ENTER_MS = 900;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  if (!stack) {
    startOnbCardScroll(screenSel, formatLabel);
    return;
  }
  stopOnbCardScroll();
  seedOnbCardLabels(stack, formatLabel, 7, 7);
  paintOnbCardSlots(stack, 'rest', 0);
  stack.style.transition = 'none';
  stack.style.transform = 'translateY(56%)';
  stack.style.opacity = '0';
  void stack.offsetHeight;
  stack.style.transition = `transform ${ENTER_MS}ms cubic-bezier(0.22, 1, 0.36, 1), opacity ${ENTER_MS}ms ease-out`;
  stack.style.transform = 'translateY(0)';
  stack.style.opacity = '1';
  await wait(ENTER_MS);
  stack.style.transition = '';
  stack.style.transform = '';
  stack.style.opacity = '';
  startOnbCardScroll(screenSel, formatLabel);
}

function setOnbTickerActive(screen, activeIndex) {
  const ticks = screen?.querySelectorAll('.onb-tick');
  if (!ticks?.length) return;
  ticks.forEach((t, i) => t.classList.toggle('active', i === activeIndex));
}

const ONB3_YT_ID = 'Sy8V_YYUplg';
let onb3Muted = true; // autoplay only works muted in Chromium

function onb3YtSrc(muted) {
  const m = muted ? '1' : '0';
  // origin helps postMessage; Referer for embeds is injected via DNR (Chrome blocks extension Referer → YT error 153)
  let origin = '';
  try {
    const u = chrome.runtime.getURL('/');
    origin = encodeURIComponent(new URL(u, location.href).origin);
  } catch (_) {
    origin = encodeURIComponent(location.origin);
  }
  // nocookie + muted autoplay; controls=0 → only our bottom-right mute (no CC / top unmute)
  return `https://www.youtube-nocookie.com/embed/${ONB3_YT_ID}?enablejsapi=1&autoplay=1&mute=${m}&loop=1&playlist=${ONB3_YT_ID}&controls=0&fs=0&cc_load_policy=0&modestbranding=1&playsinline=1&rel=0&iv_load_policy=3&disablekb=1&origin=${origin}`;
}

function onb3Post(func, args = []) {
  const iframe = document.getElementById('onb3Yt');
  if (!iframe?.contentWindow) return;
  iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args }), '*');
}

function syncOnb3MuteBtn() {
  const btn = document.getElementById('onb3MuteBtn');
  if (!btn) return;
  btn.classList.toggle('is-muted', onb3Muted);
  btn.setAttribute('aria-pressed', onb3Muted ? 'true' : 'false');
  btn.setAttribute('aria-label', onb3Muted ? 'Unmute video' : 'Mute video');
}

function onb3KickPlayback() {
  onb3Post('playVideo');
  if (onb3Muted) onb3Post('mute');
  else onb3Post('unMute');
  // Drop captions module if YouTube loaded it
  onb3Post('unloadModule', ['captions']);
}

function startOnb3Video({ force = false } = {}) {
  const iframe = document.getElementById('onb3Yt');
  const bg = document.getElementById('onb3BgImg');
  if (bg) bg.src = `https://i.ytimg.com/vi/${ONB3_YT_ID}/hqdefault.jpg`;
  if (!iframe) return;
  // Always start muted so Chromium autoplay isn't blocked
  onb3Muted = true;
  syncOnb3MuteBtn();
  const live = iframe.src.includes(ONB3_YT_ID);
  if (live && !force) {
    onb3KickPlayback();
    return;
  }
  iframe.onload = () => {
    onb3KickPlayback();
    // Retry once — IFrame API can miss the first postMessage
    setTimeout(onb3KickPlayback, 400);
  };
  iframe.src = onb3YtSrc(true);
}

function stopOnb3Video() {
  const iframe = document.getElementById('onb3Yt');
  if (!iframe) return;
  onb3Post('pauseVideo');
  iframe.onload = null;
  iframe.src = '';
}

function resetOnb3SheetPanels() {
  const screen = document.getElementById('onboarding3');
  const intro = document.getElementById('onb3IntroPanel');
  const perms = document.getElementById('onb3PermsPanel');
  screen?.classList.remove('is-perms-on');
  intro?.classList.remove('hidden');
  perms?.classList.add('hidden');
}

/* ─── Onboarding 5: live calendar scan (Figma 96:1047 / 96:1099) ─── */
const ONB_CAL_DAY = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const ONB_CAL_MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const ONB_CAL_ROWS = 3;
let onbCalScan = null; // { raf, abort, resolveDone }
let onbCalScanPromise = null;

/** Mon–Fri week rows that touch `year`/`month` (0-indexed month). */
function onbCalWeekdayRows(year, month) {
  const first = new Date(year, month, 1);
  const dow = first.getDay();
  const toMon = dow === 0 ? -6 : 1 - dow;
  let cursor = new Date(year, month, 1 + toMon);
  const rows = [];
  for (let i = 0; i < 6; i++) {
    const row = [];
    let anyIn = false;
    for (let c = 0; c < 5; c++) {
      const cell = new Date(cursor);
      cell.setDate(cursor.getDate() + c);
      const inMonth = cell.getMonth() === month && cell.getFullYear() === year;
      if (inMonth) anyIn = true;
      row.push({
        day: ONB_CAL_DAY[cell.getDay()],
        date: String(cell.getDate()).padStart(2, '0'),
        inMonth,
      });
    }
    if (anyIn) rows.push(row);
    else if (rows.length) break;
    cursor.setDate(cursor.getDate() + 7);
  }
  return rows;
}

function onbCalMonthsAround(now = new Date()) {
  return [-1, 0, 1].map(off => {
    const d = new Date(now.getFullYear(), now.getMonth() + off, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
}

function paintOnbCalChunk(grid, rows, weekStart) {
  grid.innerHTML = '';
  let start = weekStart;
  if (rows.length >= ONB_CAL_ROWS && start > rows.length - ONB_CAL_ROWS) {
    start = Math.max(0, rows.length - ONB_CAL_ROWS);
  }
  const slice = rows.slice(start, start + ONB_CAL_ROWS);
  while (slice.length < ONB_CAL_ROWS) {
    slice.push(Array.from({ length: 5 }, () => ({ day: '', date: '', inMonth: false, empty: true })));
  }
  slice.forEach((row, ri) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'onb-cal-row';
    row.forEach((cell, ci) => {
      const el = document.createElement('div');
      el.className = 'onb-cal-cell is-pending';
      el.dataset.row = String(ri);
      el.dataset.col = String(ci);
      if (cell.empty) {
        el.innerHTML = '<span class="day">&nbsp;</span><span class="date">&nbsp;</span>';
        el.classList.add('is-out');
      } else {
        el.innerHTML = `<span class="day">${cell.day}</span><span class="date">${cell.date}</span>`;
        if (!cell.inMonth) el.classList.add('is-out');
      }
      if (ri === slice.length - 1 && !cell.empty) {
        el.classList.remove('is-pending');
        el.classList.add('is-peek');
      }
      rowEl.appendChild(el);
    });
    grid.appendChild(rowEl);
  });
}

function stopOnbCalScan() {
  if (!onbCalScan) return;
  onbCalScan.abort = true;
  if (onbCalScan.raf) cancelAnimationFrame(onbCalScan.raf);
  onbCalScan.resolveDone?.();
  onbCalScan = null;
}

/** Decorative scan: prev + current + next month, beam top↔bottom, reveal cells as it passes.
 *  Returns a Promise that resolves when all months are scanned (or aborted). */
function startOnbCalScan() {
  stopOnbCalScan();
  const cal = document.getElementById('onbCal');
  const grid = document.getElementById('onbCalGrid');
  const label = document.getElementById('onbCalMonthLabel');
  const veil = document.getElementById('onbScanVeil');
  const pill = document.getElementById('onbScanPill');
  const pctEl = document.getElementById('onbScanPct');
  if (!cal || !grid || !veil || !pill || !pctEl) return Promise.resolve();

  const months = onbCalMonthsAround();
  const monthRows = months.map(m => onbCalWeekdayRows(m.year, m.month));
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });
  const state = { abort: false, raf: 0, resolveDone };
  onbCalScan = state;

  // ponytail: fixed timings; upgrade if Figma ships motion tokens
  const PASS_MS = 1600;       // one top→bottom (or bottom→top) sweep
  const MONTH_PASSES = 2;     // down then up per chunk
  const ROWS_VISIBLE = ONB_CAL_ROWS;

  let monthIdx = 0;
  let weekStart = 0;
  let pass = 0; // 0 = down, 1 = up
  let passT0 = performance.now();

  const totalChunks = monthRows.reduce((n, rows) => {
    return n + Math.max(1, Math.ceil(rows.length / ROWS_VISIBLE));
  }, 0);
  let chunkDone = 0;

  const setPct = (local01) => {
    const overall = (chunkDone + local01) / Math.max(totalChunks, 1);
    const pct = Math.min(100, Math.round(overall * 100));
    pctEl.textContent = `Scanned ${pct}%`;
  };

  const loadChunk = () => {
    const m = months[monthIdx];
    const rows = monthRows[monthIdx];
    if (label) label.textContent = `${ONB_CAL_MON[m.month]} ${m.year}`;
    paintOnbCalChunk(grid, rows, weekStart);
    pass = 0;
    passT0 = performance.now();
    veil.style.height = '0px';
    pill.style.top = '0px';
  };

  loadChunk();

  const revealAt = (scanY, goingDown) => {
    const calTop = cal.getBoundingClientRect().top;
    grid.querySelectorAll('.onb-cal-row').forEach(rowEl => {
      const cells = [...rowEl.querySelectorAll('.onb-cal-cell')];
      const rr = rowEl.getBoundingClientRect();
      const rowTop = rr.top - calTop;
      const rowBot = rr.bottom - calTop;
      const rowH = Math.max(rowBot - rowTop, 1);

      if (goingDown) {
        // Beam descending: reveal MON→FRI as it crosses each cell
        if (scanY < rowTop) {
          cells.forEach(c => {
            c.classList.remove('is-scanned', 'is-peek');
            c.classList.add('is-pending');
          });
          return;
        }
        if (scanY >= rowBot) {
          cells.forEach(c => {
            c.classList.remove('is-pending', 'is-peek');
            c.classList.add('is-scanned');
          });
          return;
        }
        const frac = (scanY - rowTop) / rowH;
        const colsOn = Math.min(5, Math.ceil(frac * 5));
        cells.forEach((c, i) => {
          c.classList.remove('is-pending', 'is-peek', 'is-scanned');
          if (i < colsOn) c.classList.add('is-scanned');
          else if (i === colsOn) c.classList.add('is-peek');
          else c.classList.add('is-pending');
        });
      } else {
        // Beam ascending: fade days/dates back out as it passes them
        if (scanY <= rowTop) {
          cells.forEach(c => {
            c.classList.remove('is-scanned', 'is-peek');
            c.classList.add('is-pending');
          });
          return;
        }
        if (scanY >= rowBot) {
          cells.forEach(c => {
            c.classList.remove('is-pending', 'is-peek');
            c.classList.add('is-scanned');
          });
          return;
        }
        // Still covering part of the row — FRI fades first as beam rises
        const frac = (scanY - rowTop) / rowH;
        const colsOn = Math.min(5, Math.floor(frac * 5));
        cells.forEach((c, i) => {
          c.classList.remove('is-pending', 'is-peek', 'is-scanned');
          if (i < colsOn) c.classList.add('is-scanned');
          else if (i === colsOn) c.classList.add('is-peek');
          else c.classList.add('is-pending');
        });
      }
    });
  };

  const advanceChunk = () => {
    chunkDone += 1;
    const rows = monthRows[monthIdx];
    weekStart += ROWS_VISIBLE;
    if (weekStart < rows.length) {
      loadChunk();
      return true;
    }
    monthIdx += 1;
    weekStart = 0;
    if (monthIdx < months.length) {
      loadChunk();
      return true;
    }
    // finished all months — park beam at bottom, 100%
    const h = cal.clientHeight;
    veil.style.height = `${h}px`;
    pill.style.top = `${h}px`;
    setPct(1);
    grid.querySelectorAll('.onb-cal-cell').forEach(c => {
      c.classList.remove('is-pending', 'is-peek');
      c.classList.add('is-scanned');
    });
    state.resolveDone?.();
    return false;
  };

  const frame = (now) => {
    if (state.abort) return;
    const h = cal.clientHeight;
    const elapsed = now - passT0;
    let t = Math.min(1, elapsed / PASS_MS);
    // ease-in-out
    t = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const goingDown = pass % 2 === 0;
    const y = goingDown ? t * h : (1 - t) * h;
    veil.style.height = `${Math.max(0, y)}px`;
    pill.style.top = `${y}px`;
    revealAt(y, goingDown);
    // local progress within this chunk (2 passes)
    const local = (pass + t) / MONTH_PASSES;
    setPct(local);

    if (elapsed >= PASS_MS) {
      pass += 1;
      passT0 = now;
      if (pass >= MONTH_PASSES) {
        if (!advanceChunk()) return; // done
      }
    }
    state.raf = requestAnimationFrame(frame);
  };

  state.raf = requestAnimationFrame(frame);
  return done;
}

function bindOnb3PlayerControls() {
  const muteBtn = document.getElementById('onb3MuteBtn');
  const closeBtn = document.getElementById('onb3Close');
  if (muteBtn && !muteBtn.dataset.bound) {
    muteBtn.dataset.bound = '1';
    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onb3Muted = !onb3Muted;
      syncOnb3MuteBtn();
      // Reload under user gesture so unmute isn't blocked by autoplay policy
      const iframe = document.getElementById('onb3Yt');
      if (iframe) {
        iframe.onload = () => {
          onb3KickPlayback();
          setTimeout(onb3KickPlayback, 400);
        };
        iframe.src = onb3YtSrc(onb3Muted);
      }
    });
  }
  if (closeBtn && !closeBtn.dataset.bound) {
    closeBtn.dataset.bound = '1';
    closeBtn.addEventListener('click', () => {
      if (window.__WL_PREVIEW__) showToast('Preview mode — close is a no-op here');
      else window.close();
    });
  }
}

/** Parts that crossfade inside the fixed frame (not the screen shell). */
function onbContentParts(screen) {
  const cards = screen.querySelector('.onb-cards');
  const main = screen.querySelector('.onb-modal-main');
  if (cards || main) return { cards, main, extras: [] };
  // slides 3+: transition direct children (overlay handled separately)
  return {
    cards: screen.querySelector('.onb-cards'),
    main: null,
    extras: [...screen.children].filter(el =>
      !el.classList.contains('onb-cards') && !el.classList.contains('onb-overlay')
    )
  };
}

function hideOnboarding() {
  stopOnbCardScroll();
  stopOnb3Video();
  stopOnbCalScan();
  resetOnb3SheetPanels();
  document.getElementById('onboarding')?.classList.add('hidden');
  document.body.classList.remove('onboarding-active');
}

function showOnboarding() {
  const screens = ['onboarding1', 'onboarding2', 'onboarding3', 'onboarding4', 'onboarding5']
    .map(id => document.getElementById(id));
  let current = 0;
  let transitioning = false;
  const TRANS_MS = 450;
  const TICKER_MS = 500;
  const wait = ms => new Promise(r => setTimeout(r, ms));

  const syncCardAnim = (i) => {
    if (i === 0) enterOnbCardsThenPlay('#onboarding1', formatOnbUnwatchedLabel);
    else if (i === 1) enterOnbCardsThenPlay('#onboarding2', formatOnbUnwatchedLabel);
    else stopOnbCardScroll();
    // Permissions lives inside screen 3 — keep YT running for indices 2 and 3
    if (i === 2 || i === 3) startOnb3Video();
    else stopOnb3Video();
    if (i === 4) {
      enterOnbCardsThenPlay('#onboarding5', formatOnbUnwatchedLabel);
      onbCalScanPromise = startOnbCalScan();
    } else stopOnbCalScan();
  };

  const clearEl = (el) => {
    if (!el) return;
    el.style.transition = '';
    el.style.opacity = '';
    el.style.transform = '';
    el.style.height = '';
  };

  /** Destination card stack sweeps bottom→top, then the infinite carousel starts. */
  const sweepCardsThenPlay = async (screenSel, formatLabel) => {
    await enterOnbCardsThenPlay(screenSel, formatLabel);
  };

  /** Screen 2 → 3: bottom sheet FLIP-expands into schedule-shell intro (Figma 91:757). */
  const morphExpandTo3 = async (from, to) => {
    const MORPH_MS = 560;
    const fromModal = from.querySelector('.onb-modal');
    const toModal = to.querySelector('.onb-intro-sheet') || to.querySelector('.onb-modal');
    const fromMain = from.querySelector('.onb-modal-main');
    const fromCards = from.querySelector('.onb-cards');
    const fromTicker = from.querySelector('.onb-ticker');
    const toVideo = to.querySelector('.sched-video');
    const toNav = to.querySelector('.sched-nav');
    const fadeEase = `opacity ${MORPH_MS}ms ease-in-out`;
    const morphEase = `transform ${MORPH_MS}ms ease-in-out, opacity ${MORPH_MS}ms ease-in-out`;

    resetOnb3SheetPanels();
    to.classList.remove('hidden');
    from.style.zIndex = '1';
    to.style.zIndex = '2';

    [toVideo, toNav].forEach(el => {
      if (!el) return;
      el.style.transition = 'none';
      el.style.opacity = '0';
    });
    to.querySelectorAll('.sched-dim, .sched-bg').forEach(el => {
      el.style.transition = 'none';
      el.style.opacity = '0';
    });

    const first = fromModal.getBoundingClientRect();
    toModal.style.transition = 'none';
    toModal.style.opacity = '1';
    const intro = document.getElementById('onb3IntroPanel');
    const perms = document.getElementById('onb3PermsPanel');
    if (intro) { intro.style.transition = 'none'; intro.style.opacity = '0'; }
    if (perms) perms.classList.add('hidden');
    void to.offsetHeight;
    const last = toModal.getBoundingClientRect();
    const dx = (first.left + first.width / 2) - (last.left + last.width / 2);
    const dy = first.top - last.top;
    const sx = first.width / last.width;
    const sy = first.height / last.height;
    toModal.style.transformOrigin = 'bottom center';
    toModal.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    void toModal.offsetHeight;

    toModal.style.transition = morphEase;
    toModal.style.transform = 'translate(0, 0) scale(1)';
    if (fromMain) {
      fromMain.style.transition = fadeEase;
      fromMain.style.opacity = '0';
    }
    if (fromCards) {
      fromCards.style.transition = fadeEase;
      fromCards.style.opacity = '0';
    }
    if (fromTicker) {
      fromTicker.style.transition = fadeEase;
      fromTicker.style.opacity = '0';
    }
    fromModal.style.transition = fadeEase;
    fromModal.style.opacity = '0';

    await wait(MORPH_MS * 0.55);

    [toVideo, toNav].forEach(el => {
      if (!el) return;
      el.style.transition = fadeEase;
      el.style.opacity = '1';
    });
    to.querySelectorAll('.sched-dim, .sched-bg').forEach(el => {
      el.style.transition = fadeEase;
      el.style.opacity = '1';
    });

    // Start after the card is visible — Chromium skips autoplay while opacity:0
    startOnb3Video({ force: true });

    await wait(MORPH_MS * 0.45);

    if (intro) {
      intro.style.transition = 'opacity 220ms ease-in-out';
      intro.style.opacity = '1';
    }
    await wait(220);

    from.classList.add('hidden');
    from.style.zIndex = '';
    to.style.zIndex = '';
    clearEl(fromMain);
    clearEl(fromCards);
    clearEl(fromTicker);
    clearEl(fromModal);
    clearEl(toModal);
    clearEl(toVideo);
    clearEl(toNav);
    clearEl(intro);
    to.querySelectorAll('.sched-dim, .sched-bg').forEach(clearEl);
  };

  /** Screen 3 intro → permissions: same sheet expands; content builds in (Figma 91:936). */
  const morphIntroToPerms = async () => {
    const MORPH_MS = 480;
    const screen = document.getElementById('onboarding3');
    const sheet = document.getElementById('onb3Sheet');
    const intro = document.getElementById('onb3IntroPanel');
    const perms = document.getElementById('onb3PermsPanel');
    if (!screen || !sheet || !intro || !perms) return;

    const first = sheet.getBoundingClientRect();
    intro.style.transition = `opacity ${MORPH_MS * 0.35}ms ease-in-out`;
    intro.style.opacity = '0';
    await wait(MORPH_MS * 0.35);

    intro.classList.add('hidden');
    perms.classList.remove('hidden');
    perms.style.transition = 'none';
    perms.style.opacity = '0';
    [...perms.children].forEach(el => {
      el.style.transition = 'none';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
    });
    screen.classList.add('is-perms-on');
    void sheet.offsetHeight;
    const last = sheet.getBoundingClientRect();
    const sy = first.height / Math.max(last.height, 1);
    sheet.style.transition = 'none';
    sheet.style.transformOrigin = 'bottom center';
    sheet.style.transform = `scaleY(${sy})`;
    void sheet.offsetHeight;
    sheet.style.transition = `transform ${MORPH_MS}ms ease-in-out`;
    sheet.style.transform = 'scaleY(1)';

    await wait(MORPH_MS * 0.45);
    perms.style.transition = `opacity ${MORPH_MS * 0.55}ms ease-in-out`;
    perms.style.opacity = '1';

    // Heading + actions fade in; cards 1 → 2 → 3 stagger opacity 0→1
    const heading = perms.querySelector('.onb-heading');
    const actions = perms.querySelector('.onb-actions');
    const permsRow = perms.querySelector('.onb-perms');
    const permCards = [...perms.querySelectorAll('.onb-perm')];
    [heading, actions, permsRow].forEach(el => {
      if (!el) return;
      el.style.transition = 'opacity 320ms ease-in-out';
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    });
    permCards.forEach((card) => {
      card.style.transition = 'none';
      card.style.opacity = '0';
      card.style.transform = 'translateY(10px)';
    });
    void perms.offsetHeight;
    const CARD_MS = 420;
    const CARD_STAGGER = 220;
    permCards.forEach((card, idx) => {
      card.style.transition = `opacity ${CARD_MS}ms ease-in-out ${idx * CARD_STAGGER}ms, transform ${CARD_MS}ms ease-in-out ${idx * CARD_STAGGER}ms`;
      card.style.opacity = '1';
      card.style.transform = 'translateY(0)';
    });
    await wait(MORPH_MS * 0.55 + CARD_MS + CARD_STAGGER * Math.max(0, permCards.length - 1));
    clearEl(sheet);
    clearEl(intro);
    clearEl(perms);
    [...perms.children].forEach(clearEl);
    permCards.forEach(clearEl);
  };

  const morphPermsToIntro = async () => {
    const MORPH_MS = 400;
    const screen = document.getElementById('onboarding3');
    const sheet = document.getElementById('onb3Sheet');
    const intro = document.getElementById('onb3IntroPanel');
    const perms = document.getElementById('onb3PermsPanel');
    if (!screen || !sheet || !intro || !perms) return;

    const first = sheet.getBoundingClientRect();
    perms.style.transition = `opacity ${MORPH_MS * 0.4}ms ease-in-out`;
    perms.style.opacity = '0';
    await wait(MORPH_MS * 0.4);

    perms.classList.add('hidden');
    intro.classList.remove('hidden');
    intro.style.transition = 'none';
    intro.style.opacity = '0';
    screen.classList.remove('is-perms-on');
    void sheet.offsetHeight;
    const last = sheet.getBoundingClientRect();
    const sy = first.height / Math.max(last.height, 1);
    sheet.style.transition = 'none';
    sheet.style.transformOrigin = 'bottom center';
    sheet.style.transform = `scaleY(${sy})`;
    void sheet.offsetHeight;
    sheet.style.transition = `transform ${MORPH_MS}ms ease-in-out`;
    sheet.style.transform = 'scaleY(1)';
    intro.style.transition = `opacity ${MORPH_MS}ms ease-in-out`;
    intro.style.opacity = '1';
    await wait(MORPH_MS);
    clearEl(sheet);
    clearEl(intro);
    clearEl(perms);
  };

  const goTo = async (i) => {
    if (transitioning || i === current || !screens[i]) return;
    // Index 3 is the permissions panel on screen 3 (onboarding4 is a stub)
    if (i === 3 && !screens[2]) return;
    transitioning = true;
    const prev = current;
    const dir = i > prev ? 1 : -1;
    const from = screens[prev === 3 ? 2 : prev] || screens[prev];
    const to = screens[i === 3 ? 2 : i];

    pauseOnbCardScroll();

    // → schedule shell (screen 3): morph from slide 2, or hard-cut from ticker/other
    if (i === 2 && prev !== 3) {
      if (prev === 1) {
        await morphExpandTo3(screens[1], screens[2]);
      } else {
        screens[prev]?.classList.add('hidden');
        screens[prev] && (screens[prev].style.zIndex = '');
        resetOnb3SheetPanels();
        const dest = screens[2];
        dest.classList.remove('hidden');
        dest.querySelectorAll('.sched-video, .sched-nav, .sched-dim, .sched-bg, .onb-intro-sheet').forEach(el => {
          clearEl(el);
          el.style.opacity = '1';
        });
        clearEl(document.getElementById('onb3IntroPanel'));
        startOnb3Video({ force: true });
      }
      syncCardAnim(2);
      current = 2;
      transitioning = false;
      return;
    }

    // 3 intro → permissions (same modal morph)
    if (prev === 2 && i === 3) {
      await morphIntroToPerms();
      syncCardAnim(i);
      current = i;
      transitioning = false;
      return;
    }

    // permissions → 3 intro
    if (prev === 3 && i === 2) {
      await morphPermsToIntro();
      syncCardAnim(i);
      current = i;
      transitioning = false;
      return;
    }

    // Leaving permissions for scanning
    if (prev === 3 && i === 4) {
      screens[2]?.classList.add('hidden');
      screens[3]?.classList.add('hidden');
      resetOnb3SheetPanels();
      stopOnb3Video();
      const scan = screens[4];
      scan.classList.remove('hidden');
      scan.classList.add('is-overlay-on');
      scan.style.opacity = '0';
      void scan.offsetHeight;
      scan.style.transition = `opacity ${TRANS_MS}ms ease-in-out`;
      scan.style.opacity = '1';
      await wait(TRANS_MS);
      clearEl(scan);
      syncCardAnim(i);
      current = i;
      transitioning = false;
      return;
    }
    if (prev === 3) {
      await morphPermsToIntro();
      resetOnb3SheetPanels();
      // fall through: from is still screen 3 visually
    }

    if (prev === 2 || prev === 3 || prev === 4) {
      from.classList.remove('is-overlay-on');
    }
    if ((prev === 2 || prev === 3) && i !== 2 && i !== 3) stopOnb3Video();

    const fromParts = onbContentParts(from);
    const toParts = onbContentParts(to);
    const fromTicker = from.querySelector('.onb-ticker');
    const toTicker = to.querySelector('.onb-ticker');
    const between12 = (prev === 0 || prev === 1) && (i === 0 || i === 1);
    const tickerPair = fromTicker && toTicker && between12;

    to.classList.remove('hidden');
    from.style.zIndex = '1';
    to.style.zIndex = '2';
    if (i === 4) to.classList.add('is-overlay-on');

    if (tickerPair) {
      fromTicker.style.visibility = 'hidden';
      setOnbTickerActive(to, prev);
      void toTicker.offsetWidth;
    }

    const fadeEase = `opacity ${TRANS_MS}ms ease-in-out`;
    const slideEase = `opacity ${TRANS_MS}ms ease-in-out, transform ${TRANS_MS}ms ease-in-out`;

    const prepIn = (el, withSlide) => {
      if (!el) return;
      el.style.transition = 'none';
      el.style.opacity = '0';
      if (withSlide) el.style.transform = `translateX(${dir * 16}px)`;
    };
    const prepOut = (el, withSlide) => {
      if (!el) return;
      el.style.transition = withSlide ? slideEase : fadeEase;
    };

    // 1↔2: cards sweep in after modal crossfade (handled below)
    if (between12) {
      prepIn(toParts.main, true);
      if (toParts.cards) {
        toParts.cards.style.transition = 'none';
        toParts.cards.style.opacity = '0';
        toParts.cards.style.transform = 'translateY(72%)';
      }
    } else {
      prepIn(toParts.cards, false);
      prepIn(toParts.main, true);
    }
    toParts.extras.forEach(el => prepIn(el, true));
    void to.offsetHeight;

    prepOut(fromParts.cards, false);
    prepOut(fromParts.main, true);
    fromParts.extras.forEach(el => prepOut(el, true));
    if (toParts.main) toParts.main.style.transition = slideEase;
    toParts.extras.forEach(el => { el.style.transition = slideEase; });
    if (!between12 && toParts.cards) toParts.cards.style.transition = fadeEase;
    void to.offsetHeight;

    if (fromParts.cards) fromParts.cards.style.opacity = '0';
    if (fromParts.main) {
      fromParts.main.style.opacity = '0';
      fromParts.main.style.transform = `translateX(${dir * -16}px)`;
    }
    fromParts.extras.forEach(el => {
      el.style.opacity = '0';
      el.style.transform = `translateX(${dir * -16}px)`;
    });
    if (toParts.main) {
      toParts.main.style.opacity = '1';
      toParts.main.style.transform = 'translateX(0)';
    }
    toParts.extras.forEach(el => {
      el.style.opacity = '1';
      el.style.transform = 'translateX(0)';
    });
    if (!between12 && toParts.cards) toParts.cards.style.opacity = '1';

    if (tickerPair) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setOnbTickerActive(to, i));
      });
    }

    await wait(Math.max(TRANS_MS, tickerPair ? TICKER_MS : 0));

    if (tickerPair) {
      setOnbTickerActive(to, i);
      fromTicker.style.visibility = '';
    }

    from.classList.add('hidden');
    from.style.zIndex = '';
    to.style.zIndex = '';
    clearEl(fromParts.cards);
    clearEl(fromParts.main);
    fromParts.extras.forEach(clearEl);
    clearEl(toParts.main);
    toParts.extras.forEach(clearEl);

    current = i;
    if (between12) {
      await sweepCardsThenPlay(i === 0 ? '#onboarding1' : '#onboarding2', formatOnbUnwatchedLabel);
    } else {
      clearEl(toParts.cards);
      syncCardAnim(i);
    }
    transitioning = false;
  };

  document.body.classList.add('onboarding-active');
  document.getElementById('onboarding')?.classList.remove('hidden');
  bindOnb3PlayerControls();
  resetOnb3SheetPanels();
  screens.forEach((s, j) => {
    s.classList.toggle('hidden', j !== 0);
    s.style.zIndex = '';
    s.classList.remove('is-overlay-on');
    const parts = onbContentParts(s);
    clearEl(parts.cards);
    clearEl(parts.main);
    parts.extras.forEach(clearEl);
    const tick = s.querySelector('.onb-ticker');
    if (tick) tick.style.visibility = '';
  });
  setOnbTickerActive(screens[0], 0);
  syncCardAnim(0);
  current = 0;
  void ensureWatchUrlGate();

  const onb1Next = document.getElementById('onb1Next');
  const onb2Back = document.getElementById('onb2Back');
  const onb2Next = document.getElementById('onb2Next');
  const onb3Back = document.getElementById('onb3Back');
  const onb3Next = document.getElementById('onb3Next');
  const onb4Back = document.getElementById('onb4Back');
  if (onb1Next) onb1Next.onclick = () => goTo(1);
  if (onb2Back) onb2Back.onclick = () => goTo(0);
  if (onb2Next) onb2Next.onclick = () => goTo(2);
  if (onb3Back) onb3Back.onclick = () => goTo(1);
  if (onb3Next) onb3Next.onclick = () => goTo(3);
  if (onb4Back) onb4Back.onclick = () => goTo(2);

  // Ticker dots jump to slides 1–3 (indices 0–2)
  document.querySelectorAll('[data-onb-goto]').forEach(tick => {
    if (tick.dataset.bound) return;
    tick.dataset.bound = '1';
    const jump = () => {
      const target = Number(tick.getAttribute('data-onb-goto'));
      if (Number.isFinite(target)) goTo(target);
    };
    tick.addEventListener('click', jump);
    tick.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        jump();
      }
    });
  });

  // "Yes, I allow" launches the OAuth flow — keep this modal open until the user
  // finishes (success → scanning) or cancels/fails (stay / back to intro).
  const allowBtn = document.getElementById('onb4Next');
  if (!allowBtn) return;
  allowBtn.onclick = () => {
    allowBtn.disabled = true; // single-flight: no parallel OAuth popups
    chrome.runtime.sendMessage({ action: 'login' }, resp => {
      void chrome.runtime.lastError;
      allowBtn.disabled = false;
      if (!resp?.success) {
        showToast('Google authentication failed. Please try again.');
        return;
      }
      const first = (resp.name || '').trim().split(' ')[0];
      const scanName = document.getElementById('scanName');
      if (scanName) scanName.textContent = (first || 'there') + ',';
      goTo(4);

      // Analyze calendar while the scan animation runs; morph to schedule when both finish.
      (async () => {
        try {
          const stored = await new Promise(r =>
            chrome.storage.local.get(['userId', 'google_access_token'], r)
          );
          const analyzeP = analyzeAndSavePrefs(stored.userId, stored.google_access_token);
          const scanP = onbCalScanPromise || Promise.resolve();
          await Promise.all([analyzeP, scanP]);
          await initPopup();
        } catch (err) {
          console.error('Post-login scan handoff failed:', err);
          try { await initPopup(); } catch (_) { /* ignore */ }
        }
        hideOnboarding();
      })();
    });
  };
}

function bindThemeToggle() {
  const btn  = document.querySelector('.theme-toggle');
  const wave = document.getElementById('themeWave');
  const img = btn?.querySelector('img');

  btn?.addEventListener('click', () => {
    if (img) {
     // fade it out
     img.style.opacity = '0';
   }
    // pick the right background
    wave.style.background = document.body.classList.contains('dark-mode')
      ? '#ffffff'
      : '#1e1e1e';
    // use the CSS keyframe name
    wave.style.animation = 'zomatoWave 1.8s ease-in-out forwards';    
    wave.style.opacity   = '1';

    setTimeout(() => {
      const isDark = document.body.classList.toggle('dark-mode');
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
      // ← update the little sun/moon icon
      updateThemeIcon();
      // ← fade it back in
      if (img) img.style.opacity = '1';
    }, 600);

    setTimeout(() => {
      wave.style.opacity    = '0';
      wave.style.animation  = 'none';
      wave.style.height     = '0';
    }, 1800);
  });
}

    async function tryScheduleEventOnce(google_access_token, slot, title, authUser, videoUrl) {  
    const channelInfo = await fetchCurrentYouTubeChannelInfo();   // returns { name, … } :contentReference[oaicite:0]{index=0}:contentReference[oaicite:1]{index=1}
    const channelName = channelInfo?.name || 'Unknown Channel';
    const event = {
    summary: title,
    description:
       `1) Video Link : ${videoUrl}` + `\n` +
       `2) YT Channel : ${channelName}` + `\n` +
       `<b> Scheduled with Watch Later Extension </b>`,
    start: { dateTime: slot.start },
    end: { dateTime: slot.end },
    colorId: '6'
  };

  try {
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${google_access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(event)
    });

    const json = await res.json();

    if (res.ok && json.id) {
      return { success: true, eventId: json.id };
    } else {
      return { success: false, error: json };
    }
  } catch (err) {
    return { success: false, error: err };
  }
}

function updateThemeIcon() {
  const img = document.querySelector('.theme-toggle img');
  if (!img) return;
  // if we're in dark-mode, next icon should be lightmode.svg (sun), else moon
  const isDark = document.body.classList.contains('dark-mode');
  img.src = isDark ? 'Icon/lightmode.svg' : 'Icon/darkmode.svg';
}


async function initPopup() {

  // ——— Network status handlers (once) ———
  if (!initPopup._netWired) {
    initPopup._netWired = true;
    window.addEventListener('offline', showNetworkLostScreen);
    window.addEventListener('online', () => {
      hideNetworkLostScreen();
      initPopup();
    });
    document.getElementById('tryAgainBtn')?.addEventListener('click', () => {
      if (navigator.onLine) {
        hideNetworkLostScreen();
        initPopup();
      } else {
        showToast('Still offline… please check your connection');
      }
    });
  }

  // Offline: keep current context under the modal
  if (!navigator.onLine) {
    hideSkeleton();
    document.getElementById('realContent')?.classList.remove('hidden');
    const { supabase_token, supabase_refresh } = await new Promise(res =>
      chrome.storage.local.get(['supabase_token', 'supabase_refresh'], res)
    );
    if (!supabase_token || !supabase_refresh) {
      showOnboarding();
      document.getElementById('scheduleBtn').style.display = 'none';
    } else if (typeof restoreLastScheduleSnapshot === 'function') {
      await restoreLastScheduleSnapshot();
    }
    showNetworkLostScreen();
    return;
  }

    // make sure close-icon always works
  document.getElementById('closePopup')?.addEventListener('click', () => window.close());

  const { supabase_token, supabase_refresh } = await new Promise(res =>
    chrome.storage.local.get(['supabase_token', 'supabase_refresh'], res)
  );

  if (!supabase_token || !supabase_refresh) {
    // hide loading, show the basic UI
    hideSkeleton();
    document.getElementById('realContent').classList.remove('hidden');

    // onboarding covers the login screen until the user finishes both slides
    showOnboarding();
    
    // **hide logged-in only controls** in logged-out state
    document.getElementById('scheduleBtn').style.display = 'none';
    document.getElementById('streakProgress')?.classList.add('hidden');

    // 👍👎 in logged-out state prompt login
    document.getElementById('thumbUpBtn')?.addEventListener('click', () => {
      showToast('🔒 Login first');
    });
    document.getElementById('thumbDownBtn')?.addEventListener('click', () => {
      showToast('🔒 Login first');
    });
    document.querySelector('.theme-toggle')?.addEventListener('click', () => {
     showToast('🔒 Login first');
    });

    return;
  }

  // Preview: mock tokens → paint schedule with dummy data (no Supabase/Calendar).
  if (window.__WL_PREVIEW__) {
    paintPreviewSchedule();
    return;
  }

  // Logged-in: show shimmer while fetching session/user
  showSkeleton('schedule');
  document.getElementById('realContent').classList.add('hidden');


  const el = {
    greeting: document.getElementById('greeting'),
    videoTitle: document.getElementById('videoTitle'),
    surveyWrapper: document.getElementById('survey-container'),
    scheduleBtn: document.getElementById('scheduleBtn'),
    feedback: document.getElementById('feedback'),
    profileIcon: document.getElementById('profileIcon'),
    overlay: document.getElementById('overlay'),
    footer: document.getElementById('footer'),
    profileMenu: document.getElementById('profileMenu'),
    closePopup: document.getElementById('closePopup'),
    viewHistory: document.getElementById('viewHistory'),
    slotPreferences: document.getElementById('slotPreferences'),
    logoutBtn: document.getElementById('logoutBtn'),
    thumbUp: document.getElementById('thumbUpBtn'),
    thumbDown: document.getElementById('thumbDownBtn'),
    sampleText: document.getElementById('sampleText'),
    slotSelectorRow: document.getElementById('slotSelectorRow'),
    streakProgress: document.getElementById('streakProgress'),
  };
  

el.closePopup = document.getElementById('closePopup');
el.closePopup?.addEventListener('click', () => window.close());

  wireSchedPrefs(window.currentUserId);

  document.getElementById('menuBtn')?.addEventListener('click', () => {
    el.profileMenu?.classList.toggle('hidden');
    el.overlay?.classList.toggle('hidden');
  });
  el.overlay?.addEventListener('click', () => {
    el.profileMenu?.classList.add('hidden');
    el.overlay?.classList.add('hidden');
  });

document.querySelector('.coffee-btn')?.addEventListener('click', () => {
  window.open('https://watchlaterextension.in/howitworks', '_blank');
});


// ───  1) Insert a “Share on Twitter” entry into the profile menu  ───
const shareItem = document.createElement('div');
shareItem.id        = 'shareOnTwitterBtn';
shareItem.className = 'profile-menu-item';
shareItem.textContent = 'Share on Twitter';

// Append it alongside your other dropdown items
el.profileMenu?.appendChild(shareItem);

// When clicked, open our new “share” modal and hide the menu
shareItem.addEventListener('click', () => {
  openShareModal();
  el.profileMenu?.classList.add('hidden');
  el.overlay?.classList.add('hidden');
});

document.getElementById('enterReferralBtn')
        ?.addEventListener('click', openEnterReferralModal);



  el.logoutBtn?.addEventListener('click', () => {
  openLogoutModal();
  // hide the profile menu and its overlay so they don’t stick around
  el.profileMenu?.classList.add('hidden');
  el.overlay?.classList.add('hidden');
  });

  // REFER A FRIEND handler ← add this:
  const referBtn = document.getElementById('referFriendBtn');
  referBtn?.addEventListener('click', () => {
    openReferFriendModal();
    el.profileMenu?.classList.add('hidden');
    el.overlay?.classList.add('hidden');
  });

  el.greeting?.classList.add('hidden');
  if (el.greeting) el.greeting.textContent = '';
  if (el.videoTitle) el.videoTitle.textContent = '';
  el.feedback?.classList.add('hidden');
  el.footer?.classList.add('hidden');
  if (el.scheduleBtn) el.scheduleBtn.style.display = 'none';
  if (el.profileIcon) el.profileIcon.style.display = 'none';
  el.streakProgress?.classList.add('hidden');       // ✅ hide progress bar
  el.slotSelectorRow?.classList.add('hidden'); 
  el.themeToggle = document.querySelector('.theme-toggle');

  el.themeToggle?.addEventListener('click', () => {
    const wave = document.getElementById('themeWave');
    if (!wave) return;

    wave.style.background = document.body.classList.contains('dark-mode')
      ? '#ffffff'
      : '#1e1e1e';

    // Apply bounce animation
    wave.style.animation = 'zomatoWave 2s ease-out forwards';
    wave.style.opacity = '1';

    // Switch theme mid-animation
    setTimeout(() => {
      const isDark = document.body.classList.toggle('dark-mode');
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
      // ← update the little sun/moon icon
      updateThemeIcon();
      // ← fade it back in
    }, 600);

    // Reset wave after animation
    setTimeout(() => {
      wave.style.opacity = '0';
      wave.style.animation = 'none';
      wave.style.height = '0';
    }, 1400);
  });


    el.feedbackBtn = document.getElementById('feedbackBtn');
    el.feedbackBtn?.addEventListener('click', () => {
      if (window.currentUserId) openFeedbackModal(window.currentUserId);
      el.profileMenu?.classList.add('hidden');
      el.overlay?.classList.add('hidden');
    });


  if (!supabase_token || !supabase_refresh) return;

  // setSession auto-refreshes when the access token is expired; if it does,
  // the refresh token rotates, so ALWAYS persist what comes back.
  const { data: sessData, error: sessErr } = await supabaseClient.auth.setSession({
    access_token: supabase_token,
    refresh_token: supabase_refresh
  });
  if (sessErr) {
    console.error('Session restore failed, trying silent Google re-login', sessErr);
    // Refresh-token chain is broken (rotation race / revocation). Before making the
    // user click login, try a silent OAuth round-trip — no UI if they're still
    // signed in to Google.
    const recovered = await new Promise(res =>
      chrome.runtime.sendMessage({ action: 'login', silent: true }, r => res(r?.success))
    );
    if (recovered) return initPopup();

    // hide shimmer, show logged-out UI
    hideSkeleton();
    document.getElementById('realContent').classList.remove('hidden');
    bindThemeToggle();
    document.getElementById('scheduleBtn').style.display = 'none';
    document.getElementById('streakProgress')?.classList.add('hidden');
    return;
  }
  await persistSupabaseSession(sessData?.session);

  const { data: { user: authUser }, error: userErr } = await supabaseClient.auth.getUser();

  // ── 1) Only proceed if login actually succeeded ──
  if (userErr || !authUser) {
    // (optional) render your logged-out UI here…
    return;
  }

  window.currentUserId = authUser.id;

  // ── 2) Now safe to run the “show once” popup logic ──
  {
    const { data: profile, error: profileErr } = await supabaseClient
      .from('users')
      .select('referral_popup_shown')
      .eq('id', authUser.id)
      .single();

    if (!profileErr && profile && !profile.referral_popup_shown) {
      openEnterReferralModal();
      const { error: updErr } = await supabaseClient
        .from('users')
        .update({ referral_popup_shown: true })
        .eq('id', authUser.id);
      if (updErr) console.error('Could not set popup flag:', updErr);
    }
  }
  document.getElementById('viewHistory')?.addEventListener('click', () =>
   openHistoryModal(window.currentUserId)
  );

  let { data: userRow } = await supabaseClient
    .from('users').select('name').eq('id', authUser.id).maybeSingle();

  if (!userRow) {
    // Row missing (old 'Users'-casing bug). Self-heal instead of hard-logout:
    // we already have a valid session, so just recreate the profile row.
    userRow = {
      name: authUser.user_metadata?.name || authUser.email
    };
    await supabaseClient.from('users').upsert({
      id: authUser.id,
      email: authUser.email,
      name: authUser.user_metadata?.name,
      avatar_url: authUser.user_metadata?.picture
    });
  }

  el.greeting.classList.add('hidden');
  // footer / streak aren't part of the v2 schedule screen
  el.footer?.classList.add('hidden');
  el.feedback.classList.remove('hidden');

  initStreak(authUser.id);
  el.scheduleBtn.style.display = 'flex'; // onb-btn uses flex
  // streak + old slot row stay hidden — not in the v2 schedule screen
  el.streakProgress?.classList.add('hidden');
  el.slotSelectorRow?.classList.add('hidden');
  el.themeToggle = document.querySelector('.theme-toggle');

  // Avatar lives in the profile menu path only; header uses the hamburger.
  // Keep #profileIcon in the DOM (hidden) so other code that queries it stays safe.
  const profileUrl = authUser.user_metadata?.avatar_url;
  if (profileUrl && el.profileIcon) {
    el.profileIcon.src = profileUrl;
    el.profileIcon.alt = 'Profile';
  }

  el.slotPreferences?.addEventListener('click', () => {
    openSchedPrefs('time');
    el.profileMenu?.classList.add('hidden');
    el.overlay?.classList.add('hidden');
  });
  document.getElementById('dayPreferences')?.addEventListener('click', () => {
    openSchedPrefs('day');
    el.profileMenu?.classList.add('hidden');
    el.overlay?.classList.add('hidden');
  });
  wireSchedPrefs(authUser.id);

  // 0) Make sure our token is still valid (and re-auth if needed)
  const valid = await ensureValidGoogleToken();
  if (!valid) {
    showFeedback("Please log in again to access your calendar.", "error");
    return;
  }
  const { google_access_token } = await new Promise(res =>
    chrome.storage.local.get("google_access_token", res)
  );

if (el.videoTitle) el.videoTitle.textContent = 'Loading video…';

  const activeTab = await getActiveInjectableTab().catch(() => null);
  cachedVideoUrl = activeTab?.url || '';
  if (!(await ensureWatchUrlGate())) {
    hideSkeleton();
    document.getElementById('realContent')?.classList.remove('hidden');
    return;
  }

  const videoDuration = await getVideoDurationInMinutes() || 10;
  const originalSlots = await fetchAvailableCalendarSlots(
    authUser.id,
    google_access_token,
    videoDuration
  );

  availableSlots = originalSlots;
  populateDropdown(availableSlots);

  const thumbEl = document.getElementById('videoThumb');
  const bgEl = document.getElementById('schedBgImg');
  const durEl = document.getElementById('videoDuration');

  if (getYouTubeThumbnail(cachedVideoUrl)) {
    setYouTubeThumbnail([thumbEl, bgEl], cachedVideoUrl);
  }

  const durationSec = await getVideoDurationSeconds();
  if (durEl) durEl.textContent = formatDurationLabel(durationSec);

  const title = await getVideoTitle();
  cachedVideoTitle = title?.replace(/^\(\d+\)\s*/, '') || 'Untitled';

  const duration = Math.ceil((durationSec || 0) / 60);
  if (duration > 180) {
    el.videoTitle.textContent =
      `This video is ${duration} minutes long (over 3 hours) and cannot be scheduled.`;
    populateDropdown([]);
    el.scheduleBtn.disabled = true;
  } else {
    el.videoTitle.textContent = cachedVideoTitle;
    el.scheduleBtn.disabled = false;
    hideWrongUrlPanel();
    saveLastScheduleSnapshot();
  }

el.scheduleBtn.onclick = async () => {
  recordButtonClick('Schedule to Google Calendar');
  if (!selectedSlotData) return;

  el.scheduleBtn.disabled   = true;
  setScheduleBtnLabel('Checking for ads…');

  // 2) Get the active tab ID once — skip chrome:// / edge://
  const activeTab = await getActiveInjectableTab();
  if (!activeTab) {
    showToast('Open a YouTube video to schedule.');
    el.scheduleBtn.disabled = false;
    setScheduleBtnLabel('Schedule to Google Calendar');
    return;
  }

  // 3) Inject into the page to check for an ad
  const [adCheck] = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    func: () => {
      const player = document.querySelector(".html5-video-player");
      return player?.classList.contains("ad-showing") ?? false;
    }
  }).catch(() => [null]);

  if (adCheck?.result) {
    // 4) If an ad is playing, show an error and reset
    showToast("Please wait until the ad finishes before scheduling.");
    el.scheduleBtn.disabled   = false;
    setScheduleBtnLabel('Schedule to Google Calendar');
    return;
  }

  // 5) No ad – proceed with scheduling
  setScheduleBtnLabel('Scheduling…');

  // 6) Pull down the Google token (alias it to avoid redeclaration)
  const { google_access_token: googleAccessToken } = await new Promise((resolve) =>
    chrome.storage.local.get("google_access_token", resolve)
  );

  // 7) Fetch the real YouTube URL from the active tab
  const videoUrl = activeTab.url;   // ← THIS is your YouTube link

  const middleEls = [
    document.getElementById('scheduleScreen'),
    el.greeting,
    el.slotSelectorRow,
    el.surveyWrapper
  ];

  // Condition 3: Network Lost
  if (!navigator.onLine) {
    showNetworkLostScreen();
    el.scheduleBtn.disabled = false;
    setScheduleBtnLabel('Schedule to Google Calendar');
    return;
  }

  const valid = await ensureValidGoogleToken();
  if (!valid) {
    el.scheduleBtn.disabled = false;
    setScheduleBtnLabel('Schedule to Google Calendar');
    return;
  }

  // Duplicate guard (project rule): don't create a second calendar event
  // for a video that's already scheduled and unwatched.
  const { data: dup } = await supabaseClient
    .from('videohistory')
    .select('id')
    .eq('user_id', authUser.id)
    .eq('video_url', videoUrl)
    .eq('watched', false)
    .limit(1)
    .maybeSingle();
  if (dup) {
    showToast('📅 This video is already scheduled');
    el.scheduleBtn.disabled = false;
    setScheduleBtnLabel('Schedule to Google Calendar');
    return;
  }

  let { google_access_token } = await new Promise(res =>
    chrome.storage.local.get("google_access_token", res)
  );

  let result = await tryScheduleEventOnce(
    google_access_token,
    selectedSlotData,
    cachedVideoTitle,
    authUser,
    videoUrl
  );

  // Retry once if token was invalid
  if (!result.success && result.error?.error?.code === 401) {
    const reauth = await ensureValidGoogleToken();
    if (!reauth) {
      showFeedback('❌ Failed to re-authenticate with Google.', 'error');
    } else {
      google_access_token = (await new Promise(res =>
        chrome.storage.local.get("google_access_token", res)
      )).google_access_token;

      result = await tryScheduleEventOnce(
        google_access_token,
        selectedSlotData,
        cachedVideoTitle,
        authUser,
        videoUrl // was missing → retried events lost their YouTube link
      );
    }
  }

if (result.success) {
  // play the ding sound
  const audio = new Audio(chrome.runtime.getURL('ding.mp3'));
  audio.play().catch(err => console.warn('Could not play ding sound:', err));

  showScheduleSuccessModal({
    title: cachedVideoTitle,
    start: selectedSlotData.start,
    end: selectedSlotData.end
  });

    // 2a) grab Google’s eventId
    const newEventId = result.eventId;
    // 2b) insert history row *with* the eventId
    // ✅ FIX: Assign thumbnailUrl explicitly before using it
    const thumbnailUrl = getYouTubeThumbnail(videoUrl);
    
    await supabaseClient.from("videohistory").insert([{      
      user_id: authUser.id,
      title: cachedVideoTitle,
      video_url: videoUrl,
      start_time: selectedSlotData.start,
      end_time: selectedSlotData.end,
      google_event_id: newEventId,
      thumbnail: thumbnailUrl, // Include thumbnail in insert
    }]);
    await initStreak(authUser.id);

  } else {
    // Condition 2: Failure
    console.error('❌ Scheduling failed:', result.error);

    middleEls.forEach(x => x?.classList.add('hidden'));
    document.querySelector('.navbar').classList.add('disabled');
    document.getElementById('footer').classList.add('disabled');

    document.getElementById('failedMessage').textContent =
      'Failed to schedule event';
    document.getElementById('failureScreen').classList.remove('hidden');

    document.getElementById('retryLink').onclick = () => {
      document.getElementById('failureScreen').classList.add('hidden');
      middleEls.forEach(x => x?.classList.remove('hidden'));
      document.querySelector('.navbar').classList.remove('disabled');
      document.getElementById('footer').classList.remove('disabled');
    };

    setTimeout(() => {
      document.getElementById('failureScreen').classList.add('hidden');
      middleEls.forEach(x => x?.classList.remove('hidden'));
      document.querySelector('.navbar').classList.remove('disabled');
      document.getElementById('footer').classList.remove('disabled');
    }, 5000);
  }

  // Re-enable button
  el.scheduleBtn.disabled = false;
  setScheduleBtnLabel('Schedule to Google Calendar');
};

 el.thumbUp?.addEventListener("click", async () => {
   if (!cachedVideoUrl) {
     return showToast("❌ Could not record feedback (no video URL)");
   }
   // 1) disable the footer UI
   el.footer.style.pointerEvents = 'none';
   el.footer.style.opacity      = '0.6';

   try {
     // 2) submit feedback
     await supabaseClient.from("feedback")
       .insert([{ user_id: authUser.id, type: "like", video_url: cachedVideoUrl }]);
     showToast("✅ Thanks for your feedback!");
   } catch (err) {
     console.error("Feedback error:", err);
     showToast("⚠️ Could not send feedback");
   } finally {
     // 3) re-enable the footer UI
     el.footer.style.pointerEvents = '';
     el.footer.style.opacity      = '';
   }
 });

 el.thumbDown?.addEventListener("click", async () => {
   if (!cachedVideoUrl) {
     return showToast("❌ Could not record feedback (no video URL)");
   }
   el.footer.style.pointerEvents = 'none';
   el.footer.style.opacity      = '0.6';

   try {
     await supabaseClient.from("feedback")
       .insert([{ user_id: authUser.id, type: "hate", video_url: cachedVideoUrl }]);
     showToast("✅ Thanks for your feedback!");
   } catch (err) {
     console.error("Feedback error:", err);
     showToast("⚠️ Could not send feedback");
   } finally {
     el.footer.style.pointerEvents = '';
     el.footer.style.opacity      = '';
   }
 });

    // Once everything is loaded, swap back to real UI
  hideSkeleton();
  document.getElementById('realContent').classList.remove('hidden');
  // 🌟 Show “New Updated” banner on login success
const banner = document.getElementById('updateBanner');
if (banner) {
  banner.classList.remove('hidden');
  document.getElementById('bannerClose')?.addEventListener('click', () => {
    banner.classList.add('hidden');
  });
}

}

function ordinalDay(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** Figma 58:6710 — `06:16 PM - 7:17 PM / Sunday / 23rd Mar` */
function formatSuccessSlotLabel(startIso, endIso) {
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return '';
  const tf = { hour: '2-digit', minute: '2-digit', hour12: true };
  const startT = s.toLocaleTimeString('en-US', tf);
  const endT = e.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const weekday = s.toLocaleDateString('en-US', { weekday: 'long' });
  const mon = s.toLocaleDateString('en-US', { month: 'short' });
  return `${startT} - ${endT} / ${weekday} / ${ordinalDay(s.getDate())} ${mon}`;
}

function formatSuccessGhostTime(startIso, endIso) {
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return '';
  const startT = s.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const endT = e.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${startT} - ${endT}`;
}

function successMountParent() {
  return document.getElementById('scheduleScreen') || document.getElementById('popupWrapper');
}

function mountSuccessOverlay() {
  const overlay = document.getElementById('successOverlay');
  const host = successMountParent();
  if (!overlay || !host) return overlay;
  if (overlay.parentElement !== host) host.appendChild(overlay);
  return overlay;
}

function closeScheduleSuccessModal() {
  const overlay = document.getElementById('successOverlay');
  document.getElementById('scheduleScreen')?.classList.remove('is-success-open');
  document.body.classList.remove('is-success-open');
  if (!overlay) return;
  overlay.classList.remove('is-open');
  overlay.classList.add('hidden');
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
}

function wireSuccessOverlayOnce() {
  if (wireSuccessOverlayOnce._wired) return;
  wireSuccessOverlayOnce._wired = true;
  document.getElementById('successGoBackBtn')?.addEventListener('click', () => {
    closeScheduleSuccessModal();
  });
  document.getElementById('successViewPlaylistBtn')?.addEventListener('click', () => {
    closeScheduleSuccessModal();
    openHistoryModal(window.currentUserId || historyState.userId || 'preview-user');
  });
  document.getElementById('successBackdrop')?.addEventListener('click', () => {
    closeScheduleSuccessModal();
  });
}

/** Figma 58:6710 — show after a successful Calendar schedule. */
function showScheduleSuccessModal({ title, start, end } = {}) {
  wireSuccessOverlayOnce();
  const overlay = mountSuccessOverlay();
  if (!overlay) return;

  const t = String(title || cachedVideoTitle || 'Video').trim() || 'Video';
  const frontTime = formatSuccessSlotLabel(start, end);
  const ghostTime = formatSuccessGhostTime(start, end);

  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  setText('successCardTitle', t);
  setText('successGhostTitle', t);
  setText('successCardTime', frontTime);
  setText('successGhostTime', ghostTime);

  document.getElementById('scheduleScreen')?.classList.add('is-success-open');
  document.body.classList.add('is-success-open');
  overlay.hidden = false;
  overlay.classList.remove('hidden');
  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');
}

/**
 * Opens the View history playlist overlay (Figma 102:1204).
 */
const HISTORY_PAGE_SIZE = 4;
const historyState = {
  userId: null,
  filter: 'scheduled',
  page: 1,
  query: '',
  items: null,
  counts: { scheduled: 0, watched: 0, forced: 0 },
  wired: false
};

function historyMountParent() {
  return document.getElementById('scheduleScreen') || document.getElementById('popupWrapper');
}

function mountHistoryOverlay() {
  const overlay = document.getElementById('historyOverlay');
  const host = historyMountParent();
  if (!overlay || !host) return overlay;
  if (overlay.parentElement !== host) host.appendChild(overlay);
  return overlay;
}

function closeHistoryModal() {
  const overlay = document.getElementById('historyOverlay');
  document.getElementById('scheduleScreen')?.classList.remove('is-history-open');
  document.body.classList.remove('is-history-open');
  closeHistoryFilterMenu();
  if (!overlay) return;
  overlay.classList.remove('is-open');
  overlay.classList.add('hidden');
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
}

function closeHistoryFilterMenu() {
  const menu = document.getElementById('historyFilterMenu');
  const wrap = document.getElementById('historyFilter');
  const btn = document.getElementById('historyFilterBtn');
  if (menu) {
    menu.classList.add('hidden');
    menu.hidden = true;
  }
  wrap?.classList.remove('is-open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function wireHistoryOverlayOnce() {
  if (historyState.wired) return;
  historyState.wired = true;

  document.getElementById('historyBackBtn')?.addEventListener('click', () => closeHistoryModal());
  document.getElementById('historyCloseBtn')?.addEventListener('click', () => closeHistoryModal());
  document.getElementById('historyBackdrop')?.addEventListener('click', () => closeHistoryModal());

  document.getElementById('historyFilterBtn')?.addEventListener('click', e => {
    e.stopPropagation();
    const menu = document.getElementById('historyFilterMenu');
    const wrap = document.getElementById('historyFilter');
    const btn = document.getElementById('historyFilterBtn');
    const open = menu && !menu.hidden;
    if (open) return closeHistoryFilterMenu();
    if (menu) {
      menu.hidden = false;
      menu.classList.remove('hidden');
    }
    wrap?.classList.add('is-open');
    if (btn) btn.setAttribute('aria-expanded', 'true');
  });

  document.getElementById('historyFilterMenu')?.addEventListener('click', e => {
    const opt = e.target.closest('[data-filter]');
    if (!opt) return;
    historyState.filter = opt.dataset.filter;
    historyState.page = 1;
    closeHistoryFilterMenu();
    paintHistoryPage();
  });

  document.addEventListener('click', e => {
    const wrap = document.getElementById('historyFilter');
    if (wrap && !wrap.contains(e.target)) closeHistoryFilterMenu();
  });

  const search = document.getElementById('historySearchInput');
  const clearBtn = document.getElementById('historySearchClear');
  search?.addEventListener('input', () => {
    historyState.query = search.value || '';
    historyState.page = 1;
    const has = !!historyState.query.trim();
    if (clearBtn) {
      clearBtn.hidden = !has;
      clearBtn.classList.toggle('hidden', !has);
    }
    paintHistoryPage();
  });
  clearBtn?.addEventListener('click', () => {
    if (search) search.value = '';
    historyState.query = '';
    historyState.page = 1;
    clearBtn.hidden = true;
    clearBtn.classList.add('hidden');
    paintHistoryPage();
  });

  document.getElementById('historyPrevBtn')?.addEventListener('click', () => {
    if (historyState.page <= 1) return;
    historyState.page -= 1;
    paintHistoryPage();
  });
  document.getElementById('historyNextBtn')?.addEventListener('click', () => {
    historyState.page += 1;
    paintHistoryPage();
  });
}

function paintHistorySkeleton() {
  const container = document.getElementById('historyList');
  if (!container) return;
  const widths = [86, 72, 90, 64];
  container.setAttribute('aria-busy', 'true');
  container.innerHTML = widths.map((w, i) => `
    <div class="history-row-wrap" aria-hidden="true">
      <div class="history-row history-skel-row">
        <div class="history-row-body">
          <div class="skeleton history-skel-title" style="width:${w}%"></div>
          <div class="skeleton history-skel-sub"></div>
        </div>
      </div>
      ${i < widths.length - 1 ? '<hr class="history-divider" />' : ''}
    </div>
  `).join('');

  const filterLabel = document.getElementById('historyFilterLabel');
  if (filterLabel) {
    filterLabel.innerHTML = '<span class="skeleton history-skel-filter"></span>';
  }
  const pager = document.getElementById('historyPagerLabel');
  if (pager) {
    pager.innerHTML = '<span class="skeleton history-skel-pager"></span>';
  }
  const prev = document.getElementById('historyPrevBtn');
  const next = document.getElementById('historyNextBtn');
  if (prev) prev.disabled = true;
  if (next) next.disabled = true;
}

function openHistoryModal(userId) {
  document.getElementById('profileMenu')?.classList.add('hidden');
  if (typeof closeSchedPrefs === 'function') closeSchedPrefs();

  historyState.userId = userId;
  historyState.filter = 'scheduled';
  historyState.page = 1;
  historyState.query = '';
  historyState.items = null;

  const search = document.getElementById('historySearchInput');
  const clearBtn = document.getElementById('historySearchClear');
  if (search) search.value = '';
  if (clearBtn) {
    clearBtn.hidden = true;
    clearBtn.classList.add('hidden');
  }

  wireHistoryOverlayOnce();
  const overlay = mountHistoryOverlay();
  if (!overlay) return;

  document.getElementById('scheduleScreen')?.classList.add('is-history-open');
  document.body.classList.add('is-history-open');
  overlay.hidden = false;
  overlay.classList.remove('hidden');
  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');

  const isPreview = !userId || userId === 'preview-user';
  if (!isPreview) paintHistorySkeleton();

  loadHistoryItems(userId).then(() => {
    document.getElementById('historyList')?.removeAttribute('aria-busy');
    paintHistoryPage();
  });
}

function splitHistoryLists(items) {
  const scheduled = items.filter(i => !i.watched && !i.forced);
  const watched = items.filter(i => i.watched && !i.forced);
  const forced = items.filter(i => i.forced);
  return { scheduled, watched, forced };
}

/** Newest first — created_at for scheduled/forced; watched_at when on Watched. */
function sortHistoryNewestFirst(list, filter) {
  return list.slice().sort((a, b) => {
    const keyA = filter === 'watched'
      ? (a.watched_at || a.created_at || a.start_time)
      : (a.created_at || a.start_time);
    const keyB = filter === 'watched'
      ? (b.watched_at || b.created_at || b.start_time)
      : (b.created_at || b.start_time);
    return new Date(keyB) - new Date(keyA);
  });
}

function activeHistoryList() {
  const lists = splitHistoryLists(historyState.items || []);
  let list = lists.scheduled;
  if (historyState.filter === 'watched') list = lists.watched;
  else if (historyState.filter === 'forced') list = lists.forced;
  return sortHistoryNewestFirst(list, historyState.filter);
}

async function loadHistoryItems(userId) {
  if (!userId || userId === 'preview-user') {
    historyState.items = getPreviewHistoryItems();
    const lists = splitHistoryLists(historyState.items);
    historyState.counts = {
      scheduled: lists.scheduled.length,
      watched: lists.watched.length,
      forced: lists.forced.length
    };
    return;
  }

  const { data, error } = await supabaseClient
    .from('videohistory')
    .select('id,title,video_url,start_time,end_time,watched,watched_at,created_at,google_event_id,forced,removed')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Failed to load history:', error.message, error.details);
    showToast(`❌ Could not load history: ${error.message}`);
    historyState.items = [];
    historyState.counts = { scheduled: 0, watched: 0, forced: 0 };
    return;
  }

  const { hiddenHistory } = await new Promise(r => chrome.storage.local.get('hiddenHistory', r));
  const hiddenIds = Array.isArray(hiddenHistory) ? hiddenHistory : [];
  const visibleItems = (data || []).filter(item => !hiddenIds.includes(item.id));

  const { google_access_token: token } = await new Promise(r =>
    chrome.storage.local.get('google_access_token', r)
  );

  await Promise.all(
    visibleItems.map(async item => {
      if (!item.google_event_id || item.forced) return;
      try {
        const actual = await fetchEventTimes(token, item.google_event_id);
        const storedStartIso = new Date(item.start_time).toISOString();
        const storedEndIso = new Date(item.end_time).toISOString();
        if (storedStartIso !== actual.start || storedEndIso !== actual.end) {
          await supabaseClient.from('videohistory').update({ forced: true }).eq('id', item.id);
          item.forced = true;
        }
      } catch {
        await supabaseClient.from('videohistory').update({ forced: true }).eq('id', item.id);
        item.forced = true;
      }
    })
  );

  await Promise.all(
    visibleItems.map(async item => {
      if (item.removed) return;
      try {
        const r = await fetch(
          `https://www.youtube.com/oembed?url=${encodeURIComponent(item.video_url)}&format=json`
        );
        if (!r.ok) throw new Error();
      } catch {
        await supabaseClient
          .from('videohistory')
          .update({ removed: true, forced: true })
          .eq('id', item.id);
        item.removed = true;
        item.forced = true;
      }
    })
  );

  historyState.items = visibleItems;
  const lists = splitHistoryLists(visibleItems);
  historyState.counts = {
    scheduled: lists.scheduled.length,
    watched: lists.watched.length,
    forced: lists.forced.length
  };
}

function getPreviewHistoryItems() {
  const now = Date.now();
  const h = ms => new Date(now + ms).toISOString();
  // created_at descending order → newest entries first in the list
  return [
    { id: 'p1', title: 'Celestial Skies: A Journey Through the Stars | 8K Video | Meditative', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', start_time: h(3 * 86400000), end_time: h(3 * 86400000 + 3600000), created_at: h(-1000), watched: false, forced: false, removed: false },
    { id: 'p2', title: 'Oceanic Dreams: Deep Sea Exploration | 4K Video | Relaxing', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', start_time: h(2 * 3600000), end_time: h(3 * 3600000), created_at: h(-2000), watched: false, forced: false, removed: false },
    { id: 'p3', title: 'Ancient Ruins: Mysteries of the Past | 6K Video | Educational', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', start_time: h(-2 * 86400000), end_time: h(-2 * 86400000 + 3600000), created_at: h(-3000), watched: false, forced: true, removed: true },
    { id: 'p4', title: 'Deep Sea Exploration: Uncharted Waters | 4K Documentary', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', start_time: h(5 * 86400000), end_time: h(5 * 86400000 + 3600000), created_at: h(-4000), watched: false, forced: false, removed: false },
    { id: 'p5', title: 'Wildlife Wonders: Secrets of the Jungle | 6K Nature', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', start_time: h(-12 * 86400000), end_time: h(-12 * 86400000 + 3600000), created_at: h(-5000), watched: false, forced: false, removed: false },
    { id: 'p6', title: 'Mountain Light: Alpine Sunrise Timelapse', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', start_time: h(-40 * 86400000), end_time: h(-40 * 86400000 + 3600000), created_at: h(-6000), watched: true, watched_at: h(-45 * 86400000), forced: false, removed: false },
    { id: 'p7', title: 'City Rain: Night Streets Ambience', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', start_time: h(-3 * 86400000), end_time: h(-3 * 86400000 + 3600000), created_at: h(-7000), watched: true, watched_at: h(-120000), forced: false, removed: false },
    { id: 'p8', title: 'Calendar Drift Demo Video', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', start_time: h(86400000), end_time: h(86400000 + 3600000), created_at: h(-8000), watched: false, forced: true, removed: false, google_event_id: 'preview' },
    { id: 'p9', title: 'Forest Canopy: Soft Wind Ambience 4K', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', start_time: h(7 * 86400000), end_time: h(7 * 86400000 + 3600000), created_at: h(-9000), watched: false, forced: false, removed: false },
    { id: 'p10', title: 'Desert Night: Stars Over Dunes', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', start_time: h(10 * 86400000), end_time: h(10 * 86400000 + 3600000), created_at: h(-10000), watched: false, forced: false, removed: false }
  ];
}

function updateHistoryFilterLabels() {
  const { scheduled, watched, forced } = historyState.counts;
  const labels = {
    scheduled: `Scheduled (${scheduled})`,
    watched: `Watched (${watched})`,
    forced: `Forced (${forced})`
  };
  const main = document.getElementById('historyFilterLabel');
  if (main) main.textContent = labels[historyState.filter] || labels.scheduled;
  document.querySelectorAll('#historyFilterMenu [data-filter]').forEach(btn => {
    const key = btn.dataset.filter;
    btn.textContent = labels[key] || btn.textContent;
    btn.setAttribute('aria-selected', key === historyState.filter ? 'true' : 'false');
  });
}

function paintHistoryPage() {
  const container = document.getElementById('historyList');
  if (!container) return;

  updateHistoryFilterLabels();

  const filtered = filterHistoryByTitle(activeHistoryList(), historyState.query);
  const page = paginateList(filtered, historyState.page, HISTORY_PAGE_SIZE);
  historyState.page = page.page;

  const pager = document.getElementById('historyPagerLabel');
  if (pager) {
    pager.textContent = `${page.start}-${page.end} of ${page.total} rows`;
  }
  const prev = document.getElementById('historyPrevBtn');
  const next = document.getElementById('historyNextBtn');
  if (prev) prev.disabled = page.page <= 1;
  if (next) next.disabled = page.page >= page.pages;

  if (!page.total) {
    const msgs = {
      scheduled: 'No YouTube video scheduled yet',
      watched: "You haven't marked any video as Watched",
      forced: 'No forced items'
    };
    container.innerHTML = `<div class="history-empty">${msgs[historyState.filter] || 'No videos'}</div>`;
    return;
  }

  container.innerHTML = '';
  const now = new Date();
  page.items.forEach((item, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'history-row-wrap';
    wrap.appendChild(buildHistoryRow(item, historyState.filter, now));
    if (idx < page.items.length - 1) {
      const hr = document.createElement('hr');
      hr.className = 'history-divider';
      wrap.appendChild(hr);
    }
    container.appendChild(wrap);
  });
}

function escapeHistoryHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHistoryRow(item, filter, now) {
  const row = document.createElement('div');
  row.className = 'history-row' + (item.removed ? ' is-removed' : '');
  row.dataset.id = item.id;

  const title = item.removed ? 'Video removed by the Channel' : (item.title || 'Untitled');
  let subtitleHtml;
  if (item.removed) {
    subtitleHtml = `<div class="history-row-sub">Video removed by the Channel</div>`;
  } else if (filter === 'watched') {
    subtitleHtml = `<div class="history-row-sub">${escapeHistoryHtml(formatHistoryMovedToWatched(item.watched_at || item.start_time, now))}</div>`;
  } else if (filter === 'forced') {
    subtitleHtml = `<div class="history-row-sub">${escapeHistoryHtml(formatHistoryScheduledFor(item.start_time, now))}</div>`;
  } else {
    const missed = formatHistoryMissedLabel(item.end_time, now);
    const upcoming = !missed && formatHistoryUpcomingLabel(item.start_time, now);
    const scheduled = formatHistoryScheduledFor(item.start_time, now);
    if (missed) {
      subtitleHtml = `<div class="history-row-sub">${escapeHistoryHtml(missed)}</div>`;
    } else if (upcoming) {
      subtitleHtml = `
        <div class="history-row-sub history-row-sub--swap" aria-label="${escapeHistoryHtml(upcoming)}">
          <div class="history-sub-track">
            <div class="history-sub-line">${escapeHistoryHtml(scheduled)}</div>
            <div class="history-sub-line">${escapeHistoryHtml(upcoming)}</div>
          </div>
        </div>`;
    } else {
      subtitleHtml = `<div class="history-row-sub">${escapeHistoryHtml(scheduled)}</div>`;
    }
  }

  const showWatch = filter === 'scheduled' && !item.removed;
  const href = item.removed ? '#' : escapeHistoryHtml(item.video_url || '#');
  const actions = `
    <div class="history-row-actions">
      ${showWatch ? `
        <button type="button" class="history-action history-action--watch" data-action="watch" title="Mark as Watched" aria-label="Mark as Watched">
          <span class="history-action-inner">
            <img class="history-icon" src="Icon/history-icon-check.svg" width="18" height="18" alt="" />
          </span>
        </button>` : ''}
      <button type="button" class="history-action history-action--delete" data-action="delete" title="Delete" aria-label="Delete">
        <span class="history-action-inner">
          <img class="history-icon" src="Icon/history-icon-trash.svg" width="18" height="18" alt="" />
        </span>
      </button>
    </div>`;

  row.innerHTML = `
    <div class="history-row-body">
      <a class="history-row-title" href="${href}" target="_blank" rel="noopener">${escapeHistoryHtml(title)}</a>
      ${subtitleHtml}
    </div>
    ${actions}
  `;

  if (item.removed) {
    row.querySelector('.history-row-title')?.addEventListener('click', e => e.preventDefault());
  }

  row.querySelector('[data-action="watch"]')?.addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    await markHistoryWatched(item, row);
  });
  row.querySelector('[data-action="delete"]')?.addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    await deleteHistoryItem(item, row);
  });

  return row;
}

function animateHistoryRowOut(row) {
  const wrap = row?.closest?.('.history-row-wrap') || row;
  return new Promise(resolve => {
    if (!wrap) return resolve();
    const startH = wrap.offsetHeight;
    wrap.style.height = `${startH}px`;
    wrap.style.overflow = 'hidden';
    // force reflow so height transition can run
    void wrap.offsetHeight;
    wrap.classList.add('is-exiting');
    window.setTimeout(() => {
      wrap.classList.add('is-collapsing');
      wrap.style.height = '0px';
      wrap.style.marginBottom = '0px';
      window.setTimeout(resolve, 360);
    }, 360);
  });
}

function refreshHistoryCounts() {
  const lists = splitHistoryLists(historyState.items || []);
  historyState.counts = {
    scheduled: lists.scheduled.length,
    watched: lists.watched.length,
    forced: lists.forced.length
  };
}

async function markHistoryWatched(item, row) {
  if (historyState.userId === 'preview-user') {
    item.watched = true;
    item.watched_at = new Date().toISOString();
    item.forced = false;
  } else {
    const watched_at = new Date().toISOString();
    const { error } = await supabaseClient
      .from('videohistory')
      .update({ watched: true, watched_at })
      .eq('id', item.id);
    if (error) {
      console.error(error);
      return showToast('⚠️ Could not mark as watched');
    }
    item.watched = true;
    item.watched_at = watched_at;
  }
  if (row) await animateHistoryRowOut(row);
  refreshHistoryCounts();
  showToast('✅ Moved to Watched');
  paintHistoryPage();
}

async function deleteHistoryItem(item, row) {
  if (historyState.userId === 'preview-user') {
    if (row) await animateHistoryRowOut(row);
    historyState.items = (historyState.items || []).filter(i => i.id !== item.id);
    showToast('✅ Video Removed');
  } else {
    let removed = false;
    await handleRemove(item, { remove() { removed = true; } });
    if (!removed) return;
    if (row) await animateHistoryRowOut(row);
    historyState.items = (historyState.items || []).filter(i => i.id !== item.id);
  }
  refreshHistoryCounts();
  paintHistoryPage();
}


function openFeedbackModal(userId) {
  const overlay = document.createElement('div');
  overlay.id = 'feedbackOverlay';
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'favourite-modal';

modal.innerHTML = `
  <div class="modal-header">
    <h2 class="modal-title">Feedback</h2>
    <button class="close-modal">
      <img src="Icon/close.svg" alt="Close" width="16" height="16" />
    </button>
  </div>
  <p class="modal-subheading">Your feedback matters to us</p>
  <textarea id="feedbackInput" rows="4" placeholder="Share your thoughts..." class="feedback-textarea"></textarea>
  <div class="feedback-actions">
    <button id="submitFeedback" class="confirm-btn small-btn" disabled>Send</button>
  </div>
`;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  modal.querySelector('.close-modal').onclick = () => overlay.remove();

  const textarea = document.getElementById('feedbackInput');
  const sendBtn = document.getElementById('submitFeedback');

  textarea.addEventListener('input', () => {
    const hasText = textarea.value.trim().length > 0;
    sendBtn.disabled = !hasText;
    sendBtn.style.opacity = hasText ? '1' : '0.6';
  });

  sendBtn.onclick = async () => {
    recordButtonClick('Send');
    const feedbackText = textarea.value.trim();
    if (!feedbackText) return;

    const { error } = await supabaseClient.from('feedback').insert([{
    user_id: userId,
    message: feedbackText,
    video_url: cachedVideoUrl    
  }]);

  if (error) {
    console.error("❌ Feedback insert failed:", error);
    showToast("Failed to send feedback.");
  } else {
    showToast("✅ Thanks for your feedback!");
    overlay.remove();
  }
  };
}

// ─── Referral helper ──────────────────────────────────────────────────────────
// Utility: generate a random 6-char alphanumeric code
function generateSixCharCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Main: create & show the “Refer a Friend” modal
async function openReferFriendModal() {
  document.getElementById('profileMenu')?.classList.add('hidden');

  // 1) auth check
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) { alert('Please log in to get your referral code.'); return; }

  // 2) fetch or insert code
  let { data: rc, error } = await supabaseClient
    .from('referral_codes').select('id,code').eq('user_id', user.id).single();

  if (error && error.code === 'PGRST116') {
    const newCode = generateSixCharCode();
    ({ data: rc, error } = await supabaseClient
      .from('referral_codes').insert({ user_id: user.id, code: newCode })
      .select('id,code').single());
    if (error) { console.error(error); alert('Could not generate code.'); return; }
  } else if (error) {
    console.error(error); alert('Could not fetch code.'); return;
  }

  // 3) count redemptions
  const { count } = await supabaseClient
    .from('referral_redemptions').select('id', { head: true, count: 'exact' })
    .eq('referral_code_id', rc.id);

  // 4) build & show modal
  const overlay = document.createElement('div');
  overlay.id = 'referOverlay';
  overlay.className = 'modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'favourite-modal';
  modal.innerHTML = `
    <div class="modal-header">
      <h2 class="modal-title">Refer a friend</h2>
      <button class="close-modal" id="closeReferModal">
        <img src="Icon/close.svg" alt="Close" width="16" height="16"/>
      </button>
    </div>
<p class="modal-subheading"> Free YT premium for a month.
  <a 
    href="https://www.youtube.com/" 
    target="_blank" 
    rel="noopener noreferrer"
    class="modal-link"
  >
    How?
  </a>
</p>

    <div class="refer-banner">
    <img src="Icon/refer-banner.png" alt="Refer & Earn!" />
    </div>
  <div class="referral-section">
    <input type="text" id="referralInput" readonly value="${rc.code}" />
    <div class="button-group" style="display: flex; gap: 8px; margin-top: 12px;">
      <!-- both buttons share the same “confirm-btn” class -->
      <button id="copyReferralBtn"  class="confirm-btn">Copy</button>
      <button id="claimGiftBtn" class="confirm-btn" disabled>Claim Gift</button>
    </div>
  </div>
    <p id="referralCount" class="referral-count">
      You’ve referred ${count || 0}/10 friend${count === 1 ? '' : 's'} so far.
      <newline>
        <a 
        href="https://chat.whatsapp.com/BzDVcfdmh4iLEbRipHuxwZ" 
        target="_blank" 
        rel="noopener noreferrer"
        class="modal-link"
        >
        Leaderboard View
        </a>
    </p>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const claimBtn = modal.querySelector('#claimGiftBtn');
  if (claimBtn) {
    if ((count || 0) >= 10) claimBtn.disabled = false;
    claimBtn.addEventListener("click", () => {
      recordButtonClick("Claim Gift");
      const message = "Hey, I have completed 10 referrals";
      const waUrl = `https://wa.me/9373869224?text=${encodeURIComponent(message)}`;
      window.open(waUrl, "_blank");
    });
  }

  // 5) wiring: close
  modal.querySelector('#closeReferModal')?.addEventListener('click', () => overlay.remove());
  // 6) wiring: copy
  const copyBtn = modal.querySelector('#copyReferralBtn');
  copyBtn?.addEventListener('click', async () => {
    recordButtonClick('Copy');

    const code = rc.code;  // your 6-char code
    const textToCopy = 
      `Hey, sign in to Watch Later Extension using my referral code "${code}" and get free YouTube Premium for a month.\n\n` +
      `For more, visit: https://watchlaterextension.in \n` + 
      'Download the extension from: https://chromewebstore.google.com/detail/watch-later-extension-for/hknbikdihdbodldlkfjoipipmgfafbol';

    try {
      await navigator.clipboard.writeText(textToCopy);
      copyBtn.textContent = 'Copied!';
      copyBtn.disabled   = true;
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
        copyBtn.disabled   = false;
      }, 3000);
    } catch (err) {
      console.error('Clipboard write failed', err);
      alert('Could not copy automatically. Please copy manually.');
    }
  });
}

// ─── “Enter referral code” modal ─────────────────────────────────────────
async function openEnterReferralModal() {
  document.getElementById('profileMenu')?.classList.add('hidden');

  // Build overlay + modal
  const overlay = document.createElement('div');
  overlay.id = 'enterReferralOverlay';
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'favourite-modal';
  modal.innerHTML = `
    <div class="modal-header">
      <h2 class="modal-title">Enter referral code</h2>
      <button class="close-modal" id="closeEnterReferral">
        <img src="Icon/close.svg" alt="Close" width="16" height="16"/>
      </button>
    </div>
    <p class="modal-subheading">
      Enter the 6-digit referral code from your friend.
        <a 
        href="https://www.youtube.com/" 
        target="_blank" 
        rel="noopener noreferrer"
        class="modal-link"
        >
        How it works?
        </a>
    </p>
    <input type="text" id="enterReferralInput" maxlength="6" class="referral-input" placeholder="ABC123" />
    <p id="enterReferralError" class="error-message"></p>
    <button id="checkReferralBtn" class="confirm-btn">Check</button>
    <p id="enterReferralResult" class="referral-result"></p>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Close handler
  modal.querySelector('#closeEnterReferral').onclick = () => overlay.remove();

  // Wire up “Check”
  const input    = modal.querySelector('#enterReferralInput');
  const errorEl  = modal.querySelector('#enterReferralError');
  const resultEl = modal.querySelector('#enterReferralResult');
  const btn      = modal.querySelector('#checkReferralBtn');

    // ——— If the user has already redeemed, show that state ———
  const { data: { user } } = await supabaseClient.auth.getUser();
  const { data: redemption } = await supabaseClient
    .from('referral_redemptions')
    .select('referral_code_id')
    .eq('redeemed_user_id', user.id)
    .maybeSingle();

  if (redemption?.referral_code_id) {
    // fetch their code + the friend who gave it
    const { data: rc } = await supabaseClient
      .from('referral_codes')
      .select('code, user_id')
      .eq('id', redemption.referral_code_id)
      .single();

    const { data: friend } = await supabaseClient
      .from('users')
      .select('name')
      .eq('id', rc.user_id)
      .single();

    // display and lock the UI
    input.value        = rc.code;
    input.disabled     = true;
    btn.disabled       = true;
    resultEl.textContent = `Referred from ${friend.name}`;
    resultEl.classList.add('referred');   // mark for orange styling

    // skip wiring up the click handler
    return;
  }
  // — end “already redeemed” logic —


  btn.addEventListener('click', async () => {
    recordButtonClick('Check');
    // reset messages
    errorEl.textContent = '';
    resultEl.textContent = '';

    // 1) immediately switch text
    btn.textContent = 'Checking…';
    
      // 0️⃣ Check connectivity
  if (!navigator.onLine) {
    alert('🚫 You appear to be offline. Please check your internet connection and try again.');
    btn.textContent = 'Check';
    return;
  }

  // trim and normalize the input code
  const code = input.value.trim().toUpperCase();
  if (code.length !== 6) {
    errorEl.textContent = 'Please enter a 6-character code.';
    btn.textContent = 'Check';
    return;
  }

    btn.disabled = true;

    // 1) Lookup the code
    const { data: rc, error: rcErr } = await supabaseClient
      .from('referral_codes')
      .select('id, user_id')
      .eq('code', code)
      .single();

    if (rcErr || !rc) {
      errorEl.textContent = 'That code is not valid.';
      btn.disabled = false;
      btn.textContent = 'Check';
      return;
    }

    // 2) Ensure logged in
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
     errorEl.textContent = 'Please log in to redeem a code.';
     btn.disabled = false;
     btn.textContent = 'Check'      
     return;
    }

    // 3) No self-referral
    if (user.id === rc.user_id) {
      errorEl.textContent = 'You cannot enter your own code.';
      btn.disabled = false;
      btn.textContent = 'Check';
      return;
    }

    // 4) One-time only
    const { data: used } = await supabaseClient
      .from('referral_redemptions')
      .select('id')
      .eq('redeemed_user_id', user.id)
      .maybeSingle();
    if (used) {
      errorEl.textContent = 'You have already used a referral code.';
      btn.textContent = 'Check';
      return;
    }

    // 5) Fetch friend’s name
    const { data: friend, error: fErr } = await supabaseClient
      .from('users')      
      .select('name')
      .eq('id', rc.user_id)
      .maybeSingle();   // <-- returns `friend = null`, no error

    if (fErr || !friend) {
      errorEl.textContent = 'This code is invalid, the user does not exist.';
      btn.disabled = false;
      return;
    }

    // 6) Record redemption
    const { error: insErr } = await supabaseClient
      .from('referral_redemptions')
      .insert({ referral_code_id: rc.id, redeemed_user_id: user.id });

    if (insErr) {
      console.error(insErr);
      errorEl.textContent = 'Something went wrong. Try again.';
      btn.textContent = 'Check';
      btn.disabled = false;
      return;
    }

    // 6a) Notify via Resend edge-function
    const { error: notifyErr } = await supabaseClient.functions.invoke(
      'sendreferralnotification',
      {
        body: {
          referrerId:   rc.user_id,
          friendName:   friend.name,
          referralCode: code
        }
      }
    );
    if (notifyErr) {
      console.error('Notification failed', notifyErr.message);
    }

    // 7) Success!
    resultEl.innerHTML = `Referred from <span class="referrer-name">${friend.name}</span>`;
    resultEl.classList.add('referral-success')    
    btn.disabled = true;
    btn.textContent = 'Check';        // ← reset the label immediately
    input.disabled  = true;
  });
}


function openLogoutModal() {
  const overlay = document.createElement('div');
  overlay.id = 'logoutOverlay';
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'favourite-modal'; // reuse existing modal styling

  modal.innerHTML = `
    <div class="modal-header">
      <h2 class="modal-title">Are you sure?</h2>
      <button class="close-modal">
        <img src="Icon/close.svg" alt="Close" width="16" height="16" />
      </button>
    </div>
    <p class="modal-subheading">
      Do you want us to remember your details or erase it completely.
    </p>
    <label style="font-size: 14px; display: flex; align-items: center; gap: 8px; margin: 15px 0;">
      <input type="checkbox" id="rememberInfo" checked />
      Remember my information
    </label>
    <p id="deleteWarning" style="display: none; color: #d32f2f; font-size: 14px; margin-top: -10px; margin-bottom: 15px;">
      ⚠️ Your information will be deleted permanently from our database.
    </p>
    <button id="confirmLogout" class="confirm-btn" style="margin-top: 10px;">Log Out</button>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const checkbox = document.getElementById('rememberInfo');
  const warning = document.getElementById('deleteWarning');

checkbox?.addEventListener('change', () => {
  if (warning) warning.style.display = checkbox.checked ? 'none' : 'block';
});


  modal.querySelector('.close-modal')?.addEventListener('click', () => overlay.remove());

modal.querySelector('#confirmLogout')?.addEventListener('click', async () => {
  recordButtonClick('Log Out');
  const remember = document.getElementById('rememberInfo').checked;
  const { data: { user } } = await supabaseClient.auth.getUser();

  if (!remember) {
    // ❌ Wipe user completely from Supabase
    await supabaseClient.from('UserTokens').delete().eq('user_id', user.id);
    await supabaseClient.from('videohistory').delete().eq('user_id', user.id);
    await supabaseClient.from('UserSlots').delete().eq('user_id', user.id);
    await supabaseClient.from('users').delete().eq('id', user.id);

    chrome.storage.local.clear(() => {
      console.log("🗑️ All local and remote data erased.");
    });
  } else {
    // ✅ Keep minimal metadata in Supabase
    const { data: userData } = await supabaseClient.auth.getUser();

    await supabaseClient.from('users').upsert({
      id: userData.user.id,
      email: userData.user.email,
      name: userData.user.user_metadata.name,
      avatar_url: userData.user.user_metadata.picture
    });

    const session = await supabaseClient.auth.getSession();
    await supabaseClient.from('UserTokens').upsert({
      user_id: userData.user.id,
      access_token: encodeToken(session.data.session.access_token),
      refresh_token: encodeToken(session.data.session.refresh_token)
    });

    chrome.storage.local.remove([
      'supabase_token',
      'supabase_refresh',
      'google_access_token'
    ]);
  }

  await supabaseClient.auth.signOut();
  overlay.remove();
  location.reload();
});

}


async function fetchCurrentYouTubeChannelInfo() {
  const tab = await getActiveInjectableTab();
  if (!tab) return null;
  return new Promise(resolve => {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const name =
          document.querySelector('ytd-channel-name a')?.innerText ||
          document.querySelector('#text-container yt-formatted-string')?.innerText ||
          '';

        const subs =
          document.querySelector('#owner-sub-count')?.innerText ||
          document.querySelector('yt-formatted-string#subscriber-count')?.innerText ||
          '';

        const thumbnail =
          document.querySelector('#owner #avatar img')?.src ||
          document.querySelector('ytd-video-owner-renderer #avatar img')?.src ||
          '';

        const url = document.querySelector('ytd-channel-name a')?.href || "";
        let id = "";

        const match = url.match(/(channel|user|c|@[^/]+)\/([^/?]+)/i);
        if (match) {
          id = match[2];
        } else if (url.includes('/@')) {
          id = url.split('/@')[1]?.split(/[/?]/)[0];
        }

        return { name, subs, thumbnail, id };
      }
    }, res => {
      void chrome.runtime.lastError;
      resolve(res?.[0]?.result || null);
    });
  });
}



async function fetchFreeBusyRange(accessToken, timeMin, timeMax) {
  const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      items: [{ id: 'primary' }],
    }),
  });
  if (res.status === 401) {
    const ok = await ensureValidGoogleToken();
    if (!ok) return [];
    const { google_access_token } = await new Promise(r =>
      chrome.storage.local.get('google_access_token', r)
    );
    return fetchFreeBusyRange(google_access_token, timeMin, timeMax);
  }
  const json = await res.json();
  return json?.calendars?.primary?.busy || [];
}

/** Prev month → next month freeBusy window for preference scoring. */
function prefsAnalysisWindow(now = new Date()) {
  const timeMin = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const timeMax = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59, 999);
  return { timeMin, timeMax };
}

async function analyzeCalendarPrefs(accessToken) {
  const { timeMin, timeMax } = prefsAnalysisWindow();
  if (!accessToken || window.__WL_PREVIEW__ || accessToken === 'preview-google') {
    return {
      days: DEFAULT_PREF_DAYS.slice(),
      slots: DEFAULT_PREF_SLOTS.slice(),
      dayHints: Object.fromEntries(PREFS_DOW.map(k => [k, 'Free days'])),
      slotHints: Object.fromEntries(Object.keys(SLOT_RANGES).map(k => [k, 'Free days'])),
    };
  }
  // ponytail: one freeBusy call for ~90d; split if Google starts rejecting large ranges
  const busy = await fetchFreeBusyRange(accessToken, timeMin, timeMax);
  return scoreCalendarPrefs(busy, timeMin, timeMax);
}

async function loadUserPrefs(userId) {
  if (!userId) {
    return { days: DEFAULT_PREF_DAYS.slice(), slots: DEFAULT_PREF_SLOTS.slice() };
  }
  if (window.__WL_PREVIEW__) {
    const { preview_user_slots } = await new Promise(r =>
      chrome.storage.local.get('preview_user_slots', r)
    );
    if (preview_user_slots?.days?.length && preview_user_slots?.slots?.length) {
      return preview_user_slots;
    }
    return { days: DEFAULT_PREF_DAYS.slice(), slots: DEFAULT_PREF_SLOTS.slice() };
  }
  const { data, error } = await supabaseClient
    .from('UserSlots')
    .select('days, slots')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) {
    return { days: [], slots: [] };
  }
  return {
    days: Array.isArray(data.days) ? data.days : [],
    slots: Array.isArray(data.slots) ? data.slots : [],
  };
}

async function saveUserPrefs(userId, { days, slots }) {
  if (!userId) return false;
  const payload = {
    user_id: userId,
    days: days?.length ? days : DEFAULT_PREF_DAYS.slice(),
    slots: slots?.length ? slots : DEFAULT_PREF_SLOTS.slice(),
  };
  if (window.__WL_PREVIEW__) {
    await new Promise(r => chrome.storage.local.set({ preview_user_slots: payload }, r));
    return true;
  }
  const { error } = await supabaseClient.from('UserSlots').upsert(payload);
  if (error) {
    console.error('Failed to save UserSlots prefs:', error);
    return false;
  }
  return true;
}

async function analyzeAndSavePrefs(userId, accessToken) {
  const existing = await loadUserPrefs(userId);
  // Already personalized (days + slots) — don't overwrite on re-login
  if (existing.days?.length && existing.slots?.length) return existing;
  let result;
  try {
    result = await analyzeCalendarPrefs(accessToken);
  } catch (err) {
    console.error('Calendar pref analysis failed:', err);
    result = {
      days: DEFAULT_PREF_DAYS.slice(),
      slots: DEFAULT_PREF_SLOTS.slice(),
      dayHints: {},
      slotHints: {},
    };
  }
  await saveUserPrefs(userId, result);
  await new Promise(r =>
    chrome.storage.local.set({
      prefs_hints: { days: result.dayHints || {}, slots: result.slotHints || {} },
    }, r)
  );
  return result;
}

async function fetchAvailableCalendarSlots(userId, accessToken, videoDurationMin = 10) {
  const bufferMin = 15;
  const totalDuration = videoDurationMin + bufferMin;

  try {
    let prefs = await loadUserPrefs(userId);
    if (!prefs.slots?.length) {
      prefs = {
        days: DEFAULT_PREF_DAYS.slice(),
        slots: DEFAULT_PREF_SLOTS.slice(),
      };
      await saveUserPrefs(userId, prefs);
    }
    const rawSlots = prefs.slots.filter(s => SLOT_RANGES[s]);
    const preferredDays = (prefs.days?.length ? prefs.days : PREFS_DOW).map(d => d.toLowerCase());

    const now = new Date();
    const slotTimes = [];

    for (let day = 0; day < 7; day++) {
      const date = new Date(now);
      date.setDate(now.getDate() + day);
      const dayKey = PREFS_DOW[date.getDay()];
      if (!preferredDays.includes(dayKey)) continue;

      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      const dateStr = `${y}-${m}-${d}`;

      for (const slot of rawSlots) {
        const [startHour, endHour] = SLOT_RANGES[slot] || [];
        if (startHour == null || endHour == null) continue;

        const startTime = new Date(`${dateStr}T${String(startHour).padStart(2, '0')}:00:00`);
        const endTime = new Date(`${dateStr}T${String(endHour).padStart(2, '0')}:00:00`);

        for (
          let start = new Date(startTime);
          start <= new Date(endTime.getTime() - totalDuration * 60 * 1000);
          start = new Date(start.getTime() + totalDuration * 60 * 1000)
        ) {
          if (day === 0 && start < now) continue;
          const end = new Date(start.getTime() + videoDurationMin * 60 * 1000);
          slotTimes.push({
            start: start.toISOString(),
            end: end.toISOString(),
            label: `${slot} – ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} to ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
          });
        }
      }
    }

    const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        timeMin: new Date().toISOString(),
        timeMax: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        items: [{ id: 'primary' }],
      }),
    });

    const json = await res.json();
    const busy = json?.calendars?.primary?.busy || [];

    const free = slotTimes.filter(slot =>
      !busy.some(b =>
        new Date(b.start) < new Date(slot.end) &&
        new Date(b.end) > new Date(slot.start)
      )
    );

    return free.slice(0, 4);
  } catch (err) {
    console.error('❌ Slot fetch failed:', err);
    return [];
  }
}


/* ── 36:2102 / 36:3080 Wrong URL — overlay over current screen ── */
const LAST_SCHEDULE_KEY = 'lastScheduleSnapshot';
const WRONG_URL_FIX = 'https://www.youtube.com/watch?v=n4CNG2KXbDk&t=63s';

function isYouTubeWatchUrl(url) {
  try {
    const u = new URL(url || '');
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.replace(/^www\./, '');
    if (host !== 'youtube.com') return false;
    if (u.pathname !== '/watch') return false;
    return !!u.searchParams.get('v');
  } catch {
    return false;
  }
}

function wrongUrlMountParent() {
  if (document.body.classList.contains('onboarding-active')) {
    return document.getElementById('onboarding');
  }
  return document.getElementById('scheduleScreen') || document.getElementById('popupWrapper');
}

function mountWrongUrlOverlay() {
  const overlay = document.getElementById('wrongUrlOverlay');
  const host = wrongUrlMountParent();
  if (!overlay || !host) return overlay;
  if (overlay.parentElement !== host) host.appendChild(overlay);
  return overlay;
}

/** true = on a watch page (modal closed); false = Wrong URL shown */
async function ensureWatchUrlGate() {
  const tab = await getActiveInjectableTab().catch(() => null);
  if (isYouTubeWatchUrl(tab?.url)) {
    hideWrongUrlPanel();
    return true;
  }
  const onOnboarding = document.body.classList.contains('onboarding-active');
  await showWrongUrlPanel({ restore: !onOnboarding });
  return false;
}

function saveLastScheduleSnapshot() {
  const title = document.getElementById('videoTitle')?.textContent || '';
  const durationLabel = document.getElementById('videoDuration')?.textContent || '';
  const thumbUrl = document.getElementById('videoThumb')?.getAttribute('src') || '';
  if (!title || title === 'Loading video…') return Promise.resolve();
  return new Promise(res => chrome.storage.local.set({
    [LAST_SCHEDULE_KEY]: {
      title,
      durationLabel,
      thumbUrl,
      videoUrl: cachedVideoUrl || '',
      slots: Array.isArray(availableSlots) ? availableSlots.slice(0, 4) : []
    }
  }, res));
}

async function restoreLastScheduleSnapshot() {
  const data = await new Promise(res => chrome.storage.local.get(LAST_SCHEDULE_KEY, res));
  const snap = data?.[LAST_SCHEDULE_KEY];
  if (!snap) return false;

  const titleEl = document.getElementById('videoTitle');
  const durEl = document.getElementById('videoDuration');
  const thumbEl = document.getElementById('videoThumb');
  const bgEl = document.getElementById('schedBgImg');
  if (titleEl && snap.title) titleEl.textContent = snap.title;
  if (durEl && snap.durationLabel) durEl.textContent = snap.durationLabel;
  if (snap.thumbUrl) {
    if (thumbEl) thumbEl.src = snap.thumbUrl;
    if (bgEl) bgEl.src = snap.thumbUrl;
  } else if (snap.videoUrl) {
    setYouTubeThumbnail([thumbEl, bgEl], snap.videoUrl);
  }
  if (Array.isArray(snap.slots) && snap.slots.length) {
    availableSlots = snap.slots;
    populateDropdown(snap.slots);
  }
  cachedVideoUrl = snap.videoUrl || cachedVideoUrl;
  cachedVideoTitle = snap.title || cachedVideoTitle;
  return true;
}

function hideWrongUrlPanel() {
  const overlay = document.getElementById('wrongUrlOverlay');
  document.getElementById('scheduleScreen')?.classList.remove('is-wrong-url');
  document.getElementById('onboarding')?.classList.remove('is-wrong-url');
  document.body.classList.remove('is-wrong-url');
  if (overlay) {
    overlay.classList.remove('is-open');
    overlay.classList.add('hidden');
    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');
  }
  const scheduleBtn = document.getElementById('scheduleBtn');
  if (scheduleBtn && isYouTubeWatchUrl(cachedVideoUrl)) scheduleBtn.disabled = false;
}

async function showWrongUrlPanel({ restore = true } = {}) {
  if (typeof closeSchedPrefs === 'function') closeSchedPrefs();
  if (restore) await restoreLastScheduleSnapshot();

  const overlay = mountWrongUrlOverlay();
  const panel = document.getElementById('wrongUrlPanel');
  if (!overlay || !panel) return;

  const host = overlay.parentElement;
  host?.classList.add('is-wrong-url');
  document.body.classList.add('is-wrong-url');
  overlay.hidden = false;
  overlay.classList.remove('hidden');
  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');

  const scheduleBtn = document.getElementById('scheduleBtn');
  if (scheduleBtn) scheduleBtn.disabled = true;
  document.getElementById('slotGrid')?.querySelectorAll('.sched-slot').forEach(b => { b.disabled = true; });

  const fixBtn = document.getElementById('wrongUrlFixBtn');
  if (fixBtn && !fixBtn.dataset.wired) {
    fixBtn.dataset.wired = '1';
    fixBtn.addEventListener('click', async () => {
      recordButtonClick('Open any video on YouTube and retry');
      const tab = await getActiveInjectableTab().catch(() => null);
      if (tab?.id != null) {
        chrome.tabs.update(tab.id, { url: WRONG_URL_FIX });
      } else {
        chrome.tabs.create({ url: WRONG_URL_FIX });
      }
      window.close();
    });
  }
}

/* ── 36:2189 / 58:7076 Change Preferences: day → time in .sched-sheet ── */
const PREFS_CHECK_SVG =
  '<svg class="prefs-day-check" viewBox="0 0 20 20" width="20" height="20" fill="none" aria-hidden="true">' +
  '<path d="m4.5 10.5 3.5 3.5 7.5-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

let prefsCollapsedBox = null;
let prefsHintsCache = { days: {}, slots: {} };

function setBannerPressed(btn, on) {
  if (!btn) return;
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function ensurePrefsDays() {
  const root = document.getElementById('prefsDays');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  for (let i = 0; i < 3; i++) {
    const row = document.createElement('div');
    row.className = 'prefs-days-row';
    for (let j = 0; j < 2; j++) {
      const key = PREFS_DAY_KEYS[i * 2 + j];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'prefs-day';
      btn.dataset.day = key;
      btn.setAttribute('aria-pressed', 'false');
      btn.innerHTML =
        `<span class="prefs-day-hint">Moderately busy</span>` +
        `<span class="prefs-day-label">${PREFS_CHECK_SVG}<span class="prefs-day-name">${PREFS_DAY_LABELS[key]}</span></span>`;
      btn.addEventListener('click', () => {
        const on = !btn.classList.contains('is-selected');
        btn.classList.toggle('is-selected', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      row.appendChild(btn);
    }
    root.appendChild(row);
  }
}

function ensurePrefsTimes() {
  const root = document.getElementById('prefsTimes');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  for (let i = 0; i < 3; i++) {
    const row = document.createElement('div');
    row.className = 'prefs-days-row';
    for (let j = 0; j < 2; j++) {
      const def = PREFS_TIME_DEFS[i * 2 + j];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'prefs-day';
      btn.dataset.slot = def.key;
      btn.setAttribute('aria-pressed', 'false');
      btn.innerHTML =
        `<span class="prefs-day-hint">Moderately busy</span>` +
        `<span class="prefs-day-label">${PREFS_CHECK_SVG}<span class="prefs-day-name">${def.label}</span></span>`;
      btn.addEventListener('click', () => {
        const on = !btn.classList.contains('is-selected');
        btn.classList.toggle('is-selected', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      row.appendChild(btn);
    }
    root.appendChild(row);
  }
}

async function loadPrefsHints() {
  const { prefs_hints } = await new Promise(r => chrome.storage.local.get('prefs_hints', r));
  prefsHintsCache = {
    days: prefs_hints?.days || {},
    slots: prefs_hints?.slots || {},
  };
}

function applyPrefsSelection(prefs) {
  const days = new Set((prefs.days || []).map(d => d.toLowerCase()));
  const slots = new Set(prefs.slots || []);

  document.querySelectorAll('#prefsDays .prefs-day').forEach(btn => {
    const key = btn.dataset.day;
    const on = days.has(key);
    btn.classList.toggle('is-selected', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const hint = btn.querySelector('.prefs-day-hint');
    if (hint) hint.textContent = prefsHintsCache.days[key] || 'Moderately busy';
  });
  setBannerPressed(document.getElementById('prefsSundayBtn'), days.has('sun'));

  document.querySelectorAll('#prefsTimes .prefs-day').forEach(btn => {
    const key = btn.dataset.slot;
    const on = slots.has(key);
    btn.classList.toggle('is-selected', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const hint = btn.querySelector('.prefs-day-hint');
    if (hint) hint.textContent = prefsHintsCache.slots[key] || 'Moderately busy';
  });
  setBannerPressed(document.getElementById('prefsNightBtn'), slots.has(PREFS_NIGHT_KEY));
}

function readPrefsFromUi() {
  const days = [...document.querySelectorAll('#prefsDays .prefs-day.is-selected')]
    .map(b => b.dataset.day);
  if (document.getElementById('prefsSundayBtn')?.getAttribute('aria-pressed') === 'true') {
    days.push('sun');
  }
  const slots = [...document.querySelectorAll('#prefsTimes .prefs-day.is-selected')]
    .map(b => b.dataset.slot);
  if (document.getElementById('prefsNightBtn')?.getAttribute('aria-pressed') === 'true') {
    slots.push(PREFS_NIGHT_KEY);
  }
  return { days, slots };
}

function showPrefsStep(step) {
  const day = document.getElementById('schedPrefsPanel');
  const time = document.getElementById('schedTimePrefsPanel');
  const isDay = step === 'day';
  day?.classList.toggle('hidden', !isDay);
  day?.setAttribute('aria-hidden', isDay ? 'false' : 'true');
  time?.classList.toggle('hidden', isDay);
  time?.setAttribute('aria-hidden', isDay ? 'true' : 'false');
}

function prefsSheetBox(sheet, screen) {
  const s = screen.getBoundingClientRect();
  const r = sheet.getBoundingClientRect();
  return {
    left: r.left - s.left,
    right: s.right - r.right,
    top: r.top - s.top,
    bottom: s.bottom - r.bottom,
  };
}

function applyPrefsSheetBox(sheet, box) {
  sheet.style.position = 'absolute';
  sheet.style.left = `${box.left}px`;
  sheet.style.right = `${box.right}px`;
  sheet.style.top = `${box.top}px`;
  sheet.style.bottom = `${box.bottom}px`;
  sheet.style.width = 'auto';
  sheet.style.zIndex = '5';
  sheet.style.margin = '0';
}

function clearPrefsSheetBox(sheet) {
  sheet.style.position = '';
  sheet.style.left = '';
  sheet.style.right = '';
  sheet.style.top = '';
  sheet.style.bottom = '';
  sheet.style.width = '';
  sheet.style.zIndex = '';
  sheet.style.margin = '';
}

async function openSchedPrefs(step = 'day') {
  const sheet = document.getElementById('schedSheet');
  const backdrop = document.getElementById('schedPrefsBackdrop');
  const screen = document.getElementById('scheduleScreen');
  if (!sheet || !backdrop || !screen) return;

  ensurePrefsDays();
  ensurePrefsTimes();
  await loadPrefsHints();
  const userId = wireSchedPrefs._userId;
  const prefs = await loadUserPrefs(userId);
  if (!prefs.days?.length && !prefs.slots?.length) {
    applyPrefsSelection({ days: DEFAULT_PREF_DAYS, slots: DEFAULT_PREF_SLOTS });
  } else {
    applyPrefsSelection({
      days: prefs.days?.length ? prefs.days : DEFAULT_PREF_DAYS,
      slots: prefs.slots?.length ? prefs.slots : DEFAULT_PREF_SLOTS,
    });
  }

  showPrefsStep(step);

  if (!sheet.classList.contains('is-prefs')) {
    prefsCollapsedBox = prefsSheetBox(sheet, screen);
    applyPrefsSheetBox(sheet, prefsCollapsedBox);
    sheet.classList.add('is-prefs');
    backdrop.hidden = false;
    backdrop.setAttribute('aria-hidden', 'false');
    void sheet.offsetHeight;
    requestAnimationFrame(() => {
      backdrop.classList.add('is-open');
      clearPrefsSheetBox(sheet);
    });
  }
}

function closeSchedPrefs() {
  const sheet = document.getElementById('schedSheet');
  const dayPanel = document.getElementById('schedPrefsPanel');
  const timePanel = document.getElementById('schedTimePrefsPanel');
  const backdrop = document.getElementById('schedPrefsBackdrop');
  const screen = document.getElementById('scheduleScreen');
  if (!sheet || !screen || !sheet.classList.contains('is-prefs')) return;

  const start = prefsSheetBox(sheet, screen);
  const end = prefsCollapsedBox || { left: 8, right: 8, top: start.top, bottom: 8 };

  applyPrefsSheetBox(sheet, start);
  sheet.classList.remove('is-prefs');
  dayPanel?.classList.add('hidden');
  dayPanel?.setAttribute('aria-hidden', 'true');
  timePanel?.classList.add('hidden');
  timePanel?.setAttribute('aria-hidden', 'true');
  backdrop?.classList.remove('is-open');

  void sheet.offsetHeight;
  requestAnimationFrame(() => applyPrefsSheetBox(sheet, end));

  const finish = (ev) => {
    if (ev && ev.target !== sheet) return;
    if (ev && ev.propertyName && ev.propertyName !== 'top') return;
    sheet.removeEventListener('transitionend', finish);
    clearPrefsSheetBox(sheet);
    if (backdrop) {
      backdrop.hidden = true;
      backdrop.setAttribute('aria-hidden', 'true');
    }
  };
  sheet.addEventListener('transitionend', finish);
  setTimeout(() => finish({ target: sheet, propertyName: 'top' }), 500);
}

async function refreshSlotsAfterPrefsSave(userId) {
  if (!userId || window.__WL_PREVIEW__) {
    if (window.__WL_PREVIEW__) paintPreviewSchedule();
    return;
  }
  const { google_access_token: token } = await new Promise(r =>
    chrome.storage.local.get('google_access_token', r)
  );
  const duration = (await getVideoDurationInMinutes()) || 10;
  const updatedSlots = await fetchAvailableCalendarSlots(userId, token, duration);
  availableSlots = updatedSlots;
  populateDropdown(updatedSlots);
}

function wireSchedPrefs(userId) {
  wireSchedPrefs._userId = userId || wireSchedPrefs._userId || null;
  if (wireSchedPrefs._done) return;
  wireSchedPrefs._done = true;

  document.getElementById('changePrefsBtn')?.addEventListener('click', () => openSchedPrefs('day'));
  document.getElementById('prefsCloseBtn')?.addEventListener('click', () => closeSchedPrefs());
  document.getElementById('prefsTimeCloseBtn')?.addEventListener('click', () => closeSchedPrefs());
  document.getElementById('schedPrefsBackdrop')?.addEventListener('click', () => closeSchedPrefs());
  document.getElementById('prefsNextBtn')?.addEventListener('click', () => showPrefsStep('time'));
  document.getElementById('prefsTimeBackBtn')?.addEventListener('click', () => showPrefsStep('day'));
  document.getElementById('prefsSaveBtn')?.addEventListener('click', async () => {
    const id = wireSchedPrefs._userId;
    const selected = readPrefsFromUi();
    if (!selected.days.length || !selected.slots.length) {
      showToast('Pick at least one day and one time slot');
      return;
    }
    const btn = document.getElementById('prefsSaveBtn');
    if (btn) btn.disabled = true;
    const ok = await saveUserPrefs(id, selected);
    if (btn) btn.disabled = false;
    if (!ok && !window.__WL_PREVIEW__) {
      showToast('Failed to save preferences');
      return;
    }
    closeSchedPrefs();
    await refreshSlotsAfterPrefsSave(id);
    showToast('Preferences saved');
  });
  document.getElementById('prefsSundayBtn')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const on = btn.getAttribute('aria-pressed') !== 'true';
    setBannerPressed(btn, on);
  });
  document.getElementById('prefsNightBtn')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const on = btn.getAttribute('aria-pressed') !== 'true';
    setBannerPressed(btn, on);
  });
}

function showFeedback(message, type = '') {
  const fb = document.getElementById('feedback');
  fb.textContent = message;
  fb.className = type === 'error'
    ? 'feedback error'
    : type === 'success'
    ? 'feedback success'
    : 'feedback';
}

function calcDailyStreak(dates) {
  // unique YYYY-MM-DD strings of every activity day
  const days = new Set(
    dates.map(d => {
      const dt = new Date(d);
      dt.setHours(0,0,0,0);              // local-midnight
      return dt.toISOString().slice(0,10);
    })
  );

  // walk backwards from today
  let streak = 0;
  const today = new Date();
  today.setHours(0,0,0,0);

  for (let i = 0; i < 365; i++) {       // safety cap
    const probe = new Date(today);
    probe.setDate(today.getDate() - i);
    const key = probe.toISOString().slice(0,10);

    if (days.has(key)) streak++;
    else break;                         // gap → streak ends
  }
  return streak;
}

async function initStreak(userId) {
  const fill    = document.getElementById("streakFill");
  const marker  = document.getElementById("streakMarker");

  const { data, error } = await supabaseClient
    .from("videohistory")
    .select("created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error || !data) {
    console.error("❌ Failed to fetch streak data:", error);
    return updateStreakUI(0);
  }

  // NEW: true daily streak (capped at 10 for UI)
  const streak = Math.min( calcDailyStreak(data.map(r => r.created_at)), 10 );
  updateStreakUI(streak);
}

function updateStreakUI(streakCount) {
  const percent = Math.min((streakCount / 10) * 100, 100); // Ensure max 100%
  const fill = document.getElementById("streakFill");
  const marker = document.getElementById("streakMarker");

  fill.style.width = `${percent}%`;
  marker.style.left = `${percent}%`; // ✅ move icon with fill
  marker.title = `Video Streak: ${streakCount}/10`;

  if (streakCount === 10) {
    showConfetti();
  }
}

function encodeToken(token) {
  return btoa(unescape(encodeURIComponent(token)));
}

function showConfetti() {
  const el = document.createElement("div");
  el.className = "confetti";
  el.textContent = "🎉";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

/**
 * Build & display a simple “Share This Extension on Twitter” modal:
 *   • Heading: “Share it on Twitter”
 *   • Subheading: “Help us grow”
 *   • A banner image of your choice
 *   • A “Tweet” button that opens twitter.com/intent/tweet with prefilled text
 */
function openShareModal() {
  // 1) Hide any open profile menu
  document.getElementById('profileMenu')?.classList.add('hidden');

  // 2) Create the overlay + modal container
  const overlay = document.createElement('div');
  overlay.id = 'shareOverlay';
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'favourite-modal';
  modal.style.width = '300px'; // adjust width as needed
  modal.innerHTML = `
    <div class="modal-header">
      <h2 class="modal-title">Share it on Twitter</h2>
      <button class="close-modal" id="closeShareModal">
        <img src="Icon/close.svg" alt="Close" width="16" height="16" />
      </button>
    </div>
    <p class="modal-subheading">Help us grow</p>
    <!-- Banner image: point to your static asset here -->
    <img 
      id="shareBanner" 
      src="Icon/ShareTwitter.png" 
      alt="Share Banner" 
      style="width:100%; border-radius:8px; margin:12px 0;"
    />
    <button id="tweetBtn" class="confirm-btn" style="margin-top:0;">
      Tweet
    </button>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // 3) Close-modal logic
  modal.querySelector('#closeShareModal').onclick = () => overlay.remove();

  // 4) Tweet button logic
modal.querySelector('#tweetBtn').onclick = () => {
  recordButtonClick('Tweet');
const tweetText = encodeURIComponent(`
Just discovered this amazing extension🚀!

Still been procrastinating over your videos on YouTube Watch Later list?

Not any more: https://watchlaterextension.in/

#WatchLaterExtension #Productivity #YouTube
`);

  const twitterUrl = `https://twitter.com/intent/tweet?text=${tweetText}`;
  window.open(twitterUrl, '_blank');
};

}

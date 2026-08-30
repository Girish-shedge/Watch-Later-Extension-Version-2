// popup.js
let availableSlots = [];
let selectedSlotData  = null;
let cachedVideoTitle  = '';
let cachedVideoUrl    = '';
let currentAuthUser   = null;
let multiSessionState = { plan: null, assigned: [], complete: false, loading: false };

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

function computeMultiFrameHeight(sessionCount = 3) {
  const cardH = 59; /* Figma 533:5985 */
  const cardGap = 8;
  const cardsRowH = sessionCount * cardH + Math.max(0, sessionCount - 1) * cardGap;
  const shellH = cardsRowH + 16; /* 8px pad × 2 — Figma 533:5983 */
  const areaH = 28 + shellH; /* banner 48 − 20px overlap */
  const sheetH = 12 + 20 + 16 + areaH + 16 + 40 + 12; /* header 20 + CTA --btn-h 40 — Figma 533:5969 */
  /* Screen pad 8; gaps 16 — Option A (Figma 532:2708) */
  return Math.ceil(8 + 44 + 16 + 172.514 + 16 + sheetH + 8);
}

function multiSessionCardSkeletonHtml() {
  return `
    <div class="multi-session-card multi-session-card--skeleton">
      <div class="multi-session-card-row">
        <span class="skeleton multi-session-skel-part"></span>
        <span class="skeleton multi-session-skel-date"></span>
      </div>
      <hr class="multi-session-card-divider" aria-hidden="true" />
      <div class="multi-session-card-row multi-session-card-row--time">
        <span class="skeleton multi-session-skel-time"></span>
        <span class="skeleton multi-session-skel-offset"></span>
      </div>
    </div>`;
}

function paintMultiSessionCardsSkeleton(sessionCount = 2) {
  const cards = document.getElementById('multiSessionCards');
  if (!cards) return;
  cards.innerHTML = '';
  for (let i = 0; i < sessionCount; i++) {
    cards.insertAdjacentHTML('beforeend', multiSessionCardSkeletonHtml());
  }
}

function paintScheduleMultiSkeleton(sessionCount = 2) {
  const host = document.getElementById('skelMultiCards');
  if (!host) return;
  host.innerHTML = '';
  for (let i = 0; i < sessionCount; i++) {
    host.insertAdjacentHTML('beforeend', `
      <div class="skel-multi-card">
        <div class="skel-multi-card-row">
          <span class="skeleton skel-multi-part"></span>
          <span class="skeleton skel-multi-date"></span>
        </div>
        <span class="skeleton skel-multi-divider"></span>
        <div class="skel-multi-card-row">
          <span class="skeleton skel-multi-time"></span>
          <span class="skeleton skel-multi-offset"></span>
        </div>
      </div>`);
  }
  const shell = document.getElementById('skelMultiShell');
  if (shell) {
    const rowH = sessionCount * 59 + Math.max(0, sessionCount - 1) * 8;
    shell.style.minHeight = `${rowH + 16}px`;
  }
}

function applyPopupFrameHeight(isMulti) {
  const defaultH = '499px';
  const h = isMulti
    ? `${computeMultiFrameHeight(multiSessionState.plan?.sessionCount || 3)}px`
    : defaultH;
  document.documentElement.style.setProperty('--frame-h-active', h);
  document.documentElement.classList.toggle('is-multi-session-frame', isMulti);
  for (const sel of ['html', 'body', '.popup-container', '#popupWrapper']) {
    const el = sel === 'html' ? document.documentElement : sel === 'body' ? document.body : document.querySelector(sel);
    if (!el) continue;
    el.style.height = h;
    el.style.minHeight = h;
  }
}

function setScheduleMode(mode) {
  const single = document.getElementById('schedSingleHome');
  const multi = document.getElementById('schedMultiHome');
  if (!single || !multi) return;
  const isMulti = mode === 'multi';
  single.hidden = isMulti;
  single.classList.toggle('hidden', isMulti);
  multi.hidden = !isMulti;
  multi.classList.toggle('hidden', !isMulti);
  multi.setAttribute('aria-hidden', isMulti ? 'false' : 'true');
  const sheetLabel = document.getElementById('schedSheetLabel');
  if (sheetLabel) sheetLabel.textContent = isMulti ? 'Select Slot' : 'Select Time Slot';
  document.getElementById('schedSheet')?.classList.toggle('is-multi-session', isMulti);
  document.getElementById('scheduleScreen')?.classList.toggle('is-multi-session', isMulti);
  applyPopupFrameHeight(isMulti);
}

function formatSessionCardDate(iso) {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const wd = d.toLocaleDateString('en-US', { weekday: 'short' });
  return `${dd}/${mm}/${wd}`;
}

function formatSessionCardTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function paintMultiSessionUI() {
  const algo = typeof WLSlotAlgorithm !== 'undefined' ? WLSlotAlgorithm : null;
  const plan = multiSessionState.plan;
  const assigned = multiSessionState.assigned || [];
  const complete = multiSessionState.complete;

  const bannerText = document.getElementById('multiSessionBannerText');
  const eachLabel = document.getElementById('multiSessionEachLabel');
  const partialNote = document.getElementById('multiSessionPartialNote');
  const cards = document.getElementById('multiSessionCards');
  const schedBtn = document.getElementById('scheduleMultiBtn');
  const regenBtn = document.getElementById('regenerateSlotsBtn');
  const blockedNote = document.getElementById('schedMultiBlockedNote');

  if (!plan || !algo || !cards) return;

  if (regenBtn) regenBtn.disabled = multiSessionState.loading;

  if (bannerText) bannerText.textContent = algo.multiSessionBannerText(plan);
  if (eachLabel) eachLabel.textContent = `${plan.sessionLengthMin} mins each`;

  const found = assigned.length;
  const total = plan.sessionCount;
  if (partialNote) {
    const showPartial = found > 0 && !complete;
    partialNote.hidden = !showPartial;
    partialNote.classList.toggle('hidden', !showPartial);
    if (showPartial) {
      partialNote.textContent =
        `We found ${found} of ${total} sessions. Try Regenerate List or widen your day/time preferences.`;
    }
  }

  if (multiSessionState.loading) {
    paintMultiSessionCardsSkeleton(plan.sessionCount);
    if (schedBtn) schedBtn.disabled = true;
    if (document.getElementById('scheduleScreen')?.classList.contains('is-multi-session')) {
      applyPopupFrameHeight(true);
    }
    return;
  }

  cards.innerHTML = '';
  plan.sessions.forEach((sess, idx) => {
    const row = assigned[idx];
    const card = document.createElement('div');
    card.className = 'multi-session-card';
    const slot = row?.slot;
    const dateStr = slot ? formatSessionCardDate(slot.start) : '—';
    const timeStr = slot
      ? `${formatSessionCardTime(slot.start)} - ${formatSessionCardTime(slot.end)}`
      : 'No slot found';
    const offsetStr = algo.formatVideoOffsetRange(sess.videoOffsetStartSec, sess.videoOffsetEndSec);
    card.innerHTML = `
      <div class="multi-session-card-row">
        <span class="multi-session-card-part">Part ${sess.sessionIndex}/${sess.sessionCount}</span>
        <span class="multi-session-card-date">${escapeHistoryHtml(dateStr)}</span>
      </div>
      <hr class="multi-session-card-divider" />
      <div class="multi-session-card-row multi-session-card-row--time">
        <span class="multi-session-card-clock">${escapeHistoryHtml(timeStr)}</span>
        <span class="multi-session-card-offset">${escapeHistoryHtml(offsetStr)}</span>
      </div>`;
    cards.appendChild(card);
  });

  if (schedBtn) {
    schedBtn.disabled = !complete || multiSessionState.loading;
    schedBtn.title = complete ? '' : 'Complete all sessions first';
  }
  if (blockedNote) {
    const showBlocked = !complete && found > 0;
    blockedNote.hidden = !showBlocked;
    blockedNote.classList.toggle('hidden', !showBlocked);
  }

  if (document.getElementById('scheduleScreen')?.classList.contains('is-multi-session')) {
    applyPopupFrameHeight(true);
  }
}

function paintMultiSessionWhySheet(plan) {
  const algo = typeof WLSlotAlgorithm !== 'undefined' ? WLSlotAlgorithm : null;
  const hero = document.getElementById('multiSessionWhyHero');
  const title = document.getElementById('multiSessionWhyTitle');
  if (!plan || !algo || !hero || !title) return;

  const count = Math.min(5, Math.max(2, plan.sessionCount));
  hero.src = `Icon/multi-session/why-${count}.png`;
  const dur = algo.formatSessionLengthWhy(plan.sessionLengthMin);
  title.innerHTML = `
    <div class="multi-why-heading-row">
      <span>Split into</span>
      <span class="onb-chip multi-why-chip">${plan.sessionCount}</span>
      <span>sessions</span>
    </div>
    <div class="multi-why-heading-row">
      <span>of</span>
      <span class="onb-chip multi-why-chip">${escapeHistoryHtml(dur)}</span>
      <span>each, sized to fit</span>
    </div>
    <div class="multi-why-heading-row">
      <span>your usual free time</span>
    </div>`;
}

function openMultiSessionWhySheet() {
  const plan = multiSessionState.plan;
  if (!plan) return;
  paintMultiSessionWhySheet(plan);
  const overlay = mountOverlay('multiSessionWhyOverlay');
  if (!overlay) return;
  openOverlay(overlay);
}

function closeMultiSessionWhySheet() {
  const overlay = document.getElementById('multiSessionWhyOverlay');
  if (overlay) closeOverlay(overlay);
}

function wireMultiSessionUiOnce() {
  if (wireMultiSessionUiOnce._done) return;
  wireMultiSessionUiOnce._done = true;

  document.getElementById('multiSessionWhyBtn')?.addEventListener('click', e => {
    e.stopPropagation();
    openMultiSessionWhySheet();
  });
  document.getElementById('multiSessionWhyBackdrop')?.addEventListener('click', closeMultiSessionWhySheet);
  document.getElementById('multiSessionWhyCloseBtn')?.addEventListener('click', closeMultiSessionWhySheet);

  document.getElementById('regenerateSlotsBtn')?.addEventListener('click', () => {
    void regenerateMultiSessionSlots();
  });

  document.getElementById('scheduleMultiBtn')?.addEventListener('click', () => {
    void scheduleMultiSessionVideo();
  });
}

function multiSessionSlotKey(row) {
  const start = row?.slot?.start || row?.start;
  if (!start) return null;
  const date = row.date || String(start).slice(0, 10);
  return `${date}|${start}`;
}

function shufflePreviewMultiSessions() {
  const plan = multiSessionState.plan;
  if (!plan) return false;
  multiSessionState._regenSeed = (multiSessionState._regenSeed || 0) + 1;
  const seed = multiSessionState._regenSeed;
  const now = Date.now();
  const assigned = plan.sessions.map((sess, i) => {
    const start = new Date(now + (i + 1 + seed) * 24 * 60 * 60 * 1000);
    start.setHours(9 + (seed % 4), (16 + seed * 7) % 60, 0, 0);
    const end = new Date(start.getTime() + sess.durationMin * 60 * 1000);
    return {
      ...sess,
      slot: { start: start.toISOString(), end: end.toISOString() },
      date: start.toISOString().slice(0, 10),
      start: start.toISOString(),
    };
  });
  multiSessionState.assigned = assigned;
  multiSessionState.complete = true;
  return true;
}

async function regenerateMultiSessionSlots() {
  if (!multiSessionState.plan || multiSessionState.loading) return;

  const prevStarts = (multiSessionState.assigned || []).map(s => s.slot?.start).join('|');
  multiSessionState.loading = true;
  paintMultiSessionUI();

  try {
    if (window.__WL_PREVIEW__) {
      if (shufflePreviewMultiSessions()) showToast('Sessions updated', 'success');
      return;
    }

    const { google_access_token } = await new Promise(r =>
      chrome.storage.local.get('google_access_token', r)
    );
    const userId = currentAuthUser?.id;
    if (!userId || !google_access_token) {
      showToast('Could not regenerate — sign in again', 'error');
      return;
    }

    const excludeSlotKeys = new Set(
      (multiSessionState.assigned || []).map(multiSessionSlotKey).filter(Boolean)
    );
    const result = await fetchMultiSessionSlots(
      userId,
      google_access_token,
      multiSessionState.plan,
      { excludeSlotKeys }
    );
    multiSessionState.assigned = result.sessions;
    multiSessionState.complete = result.complete;

    const nextStarts = result.sessions.map(s => s.slot?.start).join('|');
    if (!result.sessions.length) {
      showToast('No slots found — try Change Preferences', 'info');
    } else if (prevStarts === nextStarts) {
      showToast('No other slots found — try Change Preferences', 'info');
    } else {
      showToast('Sessions updated', 'success');
    }
  } catch (err) {
    console.error('Regenerate multi-session slots failed:', err);
    showToast('Could not regenerate sessions', 'error');
  } finally {
    multiSessionState.loading = false;
    paintMultiSessionUI();
  }
}

async function loadMultiSessionSchedule(userId, token, videoDurationMin) {
  const algo = typeof WLSlotAlgorithm !== 'undefined' ? WLSlotAlgorithm : null;
  if (!algo) return false;
  const config = await loadSlotAlgoConfig();
  const plan = algo.computeSessionPlan(videoDurationMin, config);
  if (!plan) return false;

  wireMultiSessionUiOnce();
  setScheduleMode('multi');
  multiSessionState = { plan, assigned: [], complete: false, loading: true };
  paintMultiSessionUI();

  try {
    const result = await fetchMultiSessionSlots(userId, token, plan);
    multiSessionState.assigned = result.sessions;
    multiSessionState.complete = result.complete;
  } catch (err) {
    console.error('Multi-session slot fetch failed:', err);
    showToast('Could not find session slots', 'error');
  } finally {
    multiSessionState.loading = false;
    paintMultiSessionUI();
  }
  return true;
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

/** Swap Figma 513:1176 vs 513:1167 SVG band — 1 line when it fits, else up to 2 lines. */
function schedTitleInnerWidth(frame) {
  if (!frame) return 0;
  const cs = getComputedStyle(frame);
  return frame.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
}

function schedTitleFitsOneLine(text, innerWidth, titleCs) {
  if (!text || innerWidth < 1) return false;
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = [
    'position:fixed',
    'left:-9999px',
    'top:0',
    'visibility:hidden',
    'pointer-events:none',
    'white-space:nowrap',
    'display:inline-block',
    'font:' + titleCs.font,
    'letter-spacing:' + titleCs.letterSpacing,
    'font-feature-settings:' + titleCs.fontFeatureSettings
  ].join(';');
  probe.textContent = text;
  document.body.appendChild(probe);
  const fits = probe.scrollWidth <= innerWidth + 0.5;
  probe.remove();
  return fits;
}

/** CSS ellipsis paints the “…”; paint only picks 1- vs 2-line band height. */
function schedTitleCanMeasure(frame) {
  if (!frame) return false;
  const rc = document.getElementById('realContent');
  if (rc?.classList.contains('hidden')) return false;
  const skel = document.getElementById('skeletonLayer');
  if (skel && !skel.classList.contains('hidden')) return false;
  return schedTitleInnerWidth(frame) >= 1;
}

function setSchedVideoTitle(text) {
  const title = document.getElementById('videoTitle');
  if (!title) return;
  const full = String(text || '');
  title.dataset.fullTitle = full;
  title.textContent = full;
  const frame = document.getElementById('schedTitleFrame');
  if (schedTitleCanMeasure(frame)) schedulePaintSchedTitleFrame();
}

function paintSchedTitleFrame() {
  const title = document.getElementById('videoTitle');
  const frame = document.getElementById('schedTitleFrame');
  if (!title || !frame) return;

  if (!schedTitleCanMeasure(frame)) return;

  const innerWidth = schedTitleInnerWidth(frame);

  const fullText = title.dataset.fullTitle || title.textContent || '';
  if (fullText && !title.dataset.fullTitle) title.dataset.fullTitle = fullText;
  // Keep the full string — CSS text-overflow / line-clamp draws the ellipsis.
  title.textContent = fullText;

  const titleCs = getComputedStyle(title);
  const bg1 = frame.querySelector('.sched-title-frame-bg-1');
  const bg2 = frame.querySelector('.sched-title-frame-bg-2');
  const oneLine = schedTitleFitsOneLine(fullText, innerWidth, titleCs);

  frame.classList.toggle('is-one-line', oneLine);
  frame.classList.toggle('is-two-line', !oneLine);
  if (bg1) bg1.hidden = !oneLine;
  if (bg2) bg2.hidden = oneLine;
}

function schedulePaintSchedTitleFrame() {
  cancelAnimationFrame(schedulePaintSchedTitleFrame._raf);
  schedulePaintSchedTitleFrame._raf = requestAnimationFrame(() => {
    paintSchedTitleFrame();
    if (document.fonts?.status === 'loading') {
      document.fonts.ready.then(paintSchedTitleFrame);
    }
  });
}

function wireSchedTitleFrameOnce() {
  if (wireSchedTitleFrameOnce._done) return;
  wireSchedTitleFrameOnce._done = true;
  const frame = document.getElementById('schedTitleFrame');
  if (!frame || typeof ResizeObserver === 'undefined') return;
  new ResizeObserver(() => schedulePaintSchedTitleFrame()).observe(frame);
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
      return showToast('Could not remove event', 'error');
    }
  }
  // 2) Delete the row from Supabase
  const { error } = await supabaseClient
    .from('videohistory')
    .delete()
    .eq('id', item.id);
  if (error) {
    console.error('❌ Delete history row failed:', error);
    return showToast('Could not remove video from history', 'error');
  }
  // 3) Persist hidden‐list so it never comes back
  chrome.storage.local.get('hiddenHistory', ({ hiddenHistory }) => {
    const hidden = Array.isArray(hiddenHistory) ? hiddenHistory : [];
    if (!hidden.includes(item.id)) {
      hidden.push(item.id);
      chrome.storage.local.set({ hiddenHistory: hidden });
    }
  });
  // 4) Remove from UI when a DOM row was passed
  if (row && typeof row.remove === 'function' && row.nodeType === 1) row.remove();
  else if (row?.remove) row.remove();
  showToast('Video Removed', 'success');
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

/* ── Free EN localize — see lib/translate.js (WLTranslate) ── */
function textNeedsTranslation(text) {
  return (typeof WLTranslate !== 'undefined' ? WLTranslate : null)?.textNeedsTranslation(text) === true;
}
async function translateToEnglish(text) {
  if (typeof WLTranslate === 'undefined') return String(text || '').trim();
  return WLTranslate.translateToEnglish(text);
}

async function fetchCurrentYouTubeDescription() {
  const tab = await getActiveInjectableTab().catch(() => null);
  if (!tab) return '';
  return new Promise(resolve => {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const meta = document.querySelector('meta[name="description"]')?.content?.trim();
        if (meta) return meta.slice(0, 2000);
        const short =
          document.querySelector('#description-inline-expander #plain-snippet-text')?.textContent ||
          document.querySelector('#description-inline-expander yt-attributed-string')?.textContent ||
          document.querySelector('#description yt-formatted-string')?.textContent ||
          '';
        return String(short || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
      }
    }, results => {
      void chrome.runtime.lastError;
      resolve(results?.[0]?.result || '');
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
   wireSchedTitleFrameOnce();
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
  schedulePaintSchedTitleFrame();
}

function bailInitPopupSkeleton() {
  hideSkeleton();
  document.getElementById('realContent')?.classList.remove('hidden');
}

/** Toast · Figma 380:7845 — hold then slide out. type: 'success' | 'error' | 'info' */
const TOAST_MS = 1500;
const TOAST_SLIDE_MS = 280;

function toastMountParent() {
  if (document.body.classList.contains('onboarding-active')) {
    return document.getElementById('onboarding') || document.body;
  }
  return document.querySelector('.popup-container') || document.body;
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  const msg = document.getElementById('toastMsg');
  if (!toast || !msg) return;
  const host = toastMountParent();
  if (host && toast.parentElement !== host) host.appendChild(toast);
  const kind = type === 'success' || type === 'error' ? type : 'info';
  clearTimeout(toast._holdTimer);
  clearTimeout(toast._hideTimer);
  // Strip legacy emoji prefixes — icons come from the toast kind, not the copy.
  msg.textContent = String(message || '')
    .replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]+\s*/u, '')
    .replace(/^[✅❌⚠️🔒📅🔄✔✖]\s*/u, '')
    .trim();
  toast.hidden = false;
  toast.classList.remove('hidden', 'is-open', 'is-closing', 'is-success', 'is-error', 'is-info');
  void toast.offsetWidth;
  toast.classList.add('is-open', `is-${kind}`);
  toast._holdTimer = setTimeout(() => {
    toast.classList.add('is-closing');
    toast._hideTimer = setTimeout(() => {
      toast.classList.remove('is-open', 'is-closing', 'is-success', 'is-error', 'is-info');
      toast.hidden = true;
    }, TOAST_SLIDE_MS);
  }, TOAST_MS);
}

/** Preview boot: logged-out onboarding; click through like the real extension.
 *  ?auth=connecting|cancelled|denied|interrupted|generic|permissions|analyzing|newwrongurl
 *  ?returning=1 → skip Pain (onboardingComplete) and open Connecting
 *  ?schedule=1 → jump to schedule with a fresh random sample each load
 *  ?schedule=1&success=1 → loop the success sheet over schedule
 *  ?schedule=1&fail=1 → loop the fail sheet over schedule
 *  ?wrongurl=1 → first-time Wrong URL onboarding (Pain→…→wrongURLwrongURL)
 *  ?anim=fall → Wrong URL cards BG + hardcoded overlay/modal
 */
function getPreviewParams() {
  const hash = (location.hash || '').replace(/^#/, '');
  const qs = [location.search || '', hash].filter(Boolean).join('&').replace(/^&/, '');
  return new URLSearchParams(qs.startsWith('?') ? qs.slice(1) : qs);
}

function startPreviewMode() {
  wireSchedTitleFrameOnce();
  document.body.classList.add('wl-preview');
  hideNetworkLostScreen();
  hideSkeleton();
  document.getElementById('realContent')?.classList.remove('hidden');

  const params = getPreviewParams();
  const authScreen = params.get('auth');
  const returning = params.get('returning') === '1';
  const forceWrongUrl = params.get('wrongurl') === '1';

  chrome.storage.local.remove(
    ['supabase_token', 'supabase_refresh', 'google_access_token', 'userId', ONB_FLAG_SCANNED],
    async () => {
      if (forceWrongUrl || authScreen === 'newwrongurl') {
        await storageSet({ [ONB_FLAG_COMPLETE]: false });
        showOnboarding({ wrongUrl: true });
        // Preview: ?wrongurl=1&auth=connecting|cancelled|… → fall BG + shared auth sheet
        const authPanels = {
          connecting: 'authConnecting',
          cancelled: 'authSignInCancelled',
          denied: 'authCalendarDenied',
          interrupted: 'authFlowInterrupted',
          generic: 'authSomethingWrong'
        };
        if (authScreen === 'permissions') {
          setTimeout(async () => {
            if (onboardingGoTo) await onboardingGoTo(1);
            openPromisePermsSheet();
          }, 200);
        } else if (authScreen === 'analyzing') {
          setTimeout(async () => {
            const scanName = document.getElementById('scanName');
            if (scanName) scanName.textContent = 'Girish,';
            if (onboardingGoTo) await onboardingGoTo(3);
          }, 200);
        } else if (authScreen && authPanels[authScreen]) {
          setTimeout(async () => {
            wireAuthPanelsOnce();
            if (onboardingGoTo) await onboardingGoTo(1);
            openPromisePermsSheet();
            await prepareAuthBackdrop();
            showAuthPanel(authPanels[authScreen]);
          }, 200);
        }
        return;
      }
      if (params.get('anim') === 'fall' || authScreen === 'fallanim') {
        showWrongUrlFallAnim();
        return;
      }
      // ?schedule=1 → jump straight to schedule with a fresh random sample each load
      if (params.get('schedule') === '1' || authScreen === 'schedule') {
        await storageSet({
          supabase_token: 'preview-token',
          supabase_refresh: 'preview-refresh',
          google_access_token: 'preview-google',
          userId: 'preview-user',
          [ONB_FLAG_COMPLETE]: true,
          [ONB_FLAG_SCANNED]: true
        });
        hideOnboarding();
        paintPreviewSchedule();
        return;
      }
      if (returning || authScreen === 'connecting' && params.get('kind') === 'returning') {
        await storageSet({ [ONB_FLAG_COMPLETE]: true });
        await showReturningConnecting();
        return;
      }
      if (authScreen) {
        await storageSet({ [ONB_FLAG_COMPLETE]: authScreen !== 'pain' });
        showOnboarding();
        setTimeout(async () => {
          wireAuthPanelsOnce();
          if (authScreen === 'permissions') {
            if (onboardingGoTo) await onboardingGoTo(1);
            openPromisePermsSheet();
          } else if (authScreen === 'promise' && onboardingGoTo) await onboardingGoTo(1);
          else if (authScreen === 'analyzing') {
            const scanName = document.getElementById('scanName');
            if (scanName) scanName.textContent = 'Girish,';
            if (onboardingGoTo) await onboardingGoTo(3);
          } else if (authScreen === 'connecting') {
            if (onboardingGoTo) await onboardingGoTo(1);
            openPromisePermsSheet();
            await prepareAuthBackdrop();
            showAuthPanel('authConnecting');
          } else if (authScreen === 'cancelled') {
            if (onboardingGoTo) await onboardingGoTo(1);
            openPromisePermsSheet();
            await prepareAuthBackdrop();
            showAuthPanel('authSignInCancelled');
          } else if (authScreen === 'denied') {
            if (onboardingGoTo) await onboardingGoTo(1);
            openPromisePermsSheet();
            await prepareAuthBackdrop();
            showAuthPanel('authCalendarDenied');
          } else if (authScreen === 'interrupted') {
            if (onboardingGoTo) await onboardingGoTo(1);
            openPromisePermsSheet();
            await prepareAuthBackdrop();
            showAuthPanel('authFlowInterrupted');
          } else if (authScreen === 'generic') {
            if (onboardingGoTo) await onboardingGoTo(1);
            openPromisePermsSheet();
            await prepareAuthBackdrop();
            showAuthPanel('authSomethingWrong');
          }
        }, 200);
        return;
      }
      await storageSet({ [ONB_FLAG_COMPLETE]: false });
      showOnboarding();
    }
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
  const params = getPreviewParams();
  let pick;
  const sampleIdx = params.get('sample');
  if (sampleIdx != null && samples[Number(sampleIdx)]) {
    pick = samples[Number(sampleIdx)];
  } else {
    pick = samples[Math.floor(Math.random() * samples.length)];
    if (samples.length > 1 && pick.src === paintPreviewSchedule._lastSrc) {
      pick = samples[(samples.findIndex(s => s.src === pick.src) + 1 + Math.floor(Math.random() * (samples.length - 1))) % samples.length];
    }
  }
  paintPreviewSchedule._lastSrc = pick.src;
  const forceMulti = params.get('multi') === '1';
  const jitter = Math.round(pick.durationSec * (0.85 + Math.random() * 0.3));
  const durationSec = forceMulti ? 3 * 3600 : Math.max(30, jitter);

  hideWrongUrlPanel();
  closeSchedPrefs();

  const thumbEl = document.getElementById('videoThumb');
  const bgEl = document.getElementById('schedBgImg');
  if (thumbEl) thumbEl.src = pick.src;
  if (bgEl) bgEl.src = pick.src;

  const titleEl = document.getElementById('videoTitle');
  if (titleEl) setSchedVideoTitle(pick.title);

  const durEl = document.getElementById('videoDuration');
  if (durEl) durEl.textContent = formatDurationLabel(durationSec);

  const durationMin = Math.ceil(durationSec / 60);
  const algo = typeof WLSlotAlgorithm !== 'undefined' ? WLSlotAlgorithm : null;
  const plan = algo?.computeSessionPlan(durationMin, { LONG_VIDEO_THRESHOLD_MINUTES: 165 });

  if (plan) {
    wireMultiSessionUiOnce();
    setScheduleMode('multi');
    const now = Date.now();
    const assigned = plan.sessions.map((sess, i) => {
      const start = new Date(now + (i + 1) * 24 * 60 * 60 * 1000);
      start.setHours(18, 16, 0, 0);
      const end = new Date(start.getTime() + sess.durationMin * 60 * 1000);
      return {
        ...sess,
        slot: { start: start.toISOString(), end: end.toISOString() },
        date: start.toISOString().slice(0, 10),
        start: start.toISOString(),
      };
    });
    multiSessionState = { plan, assigned, complete: true, loading: false };
    paintMultiSessionUI();
  } else {
    setScheduleMode('single');
    const now = Date.now();
    const slots = [0, 1, 2, 3].map(i => {
      const start = new Date(now + (i + 1) * 60 * 60 * 1000);
      start.setMinutes(0, 0, 0);
      const end = new Date(start.getTime() + durationMin * 60 * 1000);
      return { start: start.toISOString(), end: end.toISOString() };
    });
    availableSlots = slots;
    populateDropdown(slots);
  }
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
          showToast('Preview — sample watch page loaded', 'info');
        };
      }
    });
  });

  const scheduleBtn = document.getElementById('scheduleBtn');
  const scheduleMultiBtn = document.getElementById('scheduleMultiBtn');
  if (scheduleBtn) {
    scheduleBtn.style.display = plan ? 'none' : 'flex';
    scheduleBtn.disabled = false;
    if (!plan) {
      scheduleBtn.onclick = () => {
        const slot = availableSlots?.[0];
        showScheduleSuccessModal({
          title: cachedVideoTitle || document.getElementById('videoTitle')?.textContent,
          start: slot?.start || new Date().toISOString(),
          end: slot?.end || new Date(Date.now() + 3600000).toISOString()
        });
      };
    }
  }
  if (scheduleMultiBtn && plan) {
    scheduleMultiBtn.onclick = () => {
      const first = multiSessionState.assigned?.[0]?.slot;
      showScheduleSuccessModal({
        title: cachedVideoTitle,
        start: first?.start || new Date().toISOString(),
        end: first?.end || new Date(Date.now() + 3600000).toISOString()
      });
    };
  }

  if (!paintPreviewSchedule._wired) {
    paintPreviewSchedule._wired = true;
    document.getElementById('menuBtn')?.addEventListener('click', () => {
      openProfileMenu('preview-user');
    });
    document.getElementById('closePopup')?.addEventListener('click', () => {
      showToast('Preview mode — close is a no-op here', 'info');
    });
    wireSchedPrefs('preview-user');
  }

  const outcome =
    params.get('fail') === '1' || params.get('success') === '1';
  if (outcome) setTimeout(() => startOutcomePreviewLoop(), 240);
  else if (params.get('history') === '1') setTimeout(() => startHistoryPreviewLoop(), 240);
  else if (params.get('profile') === '1') setTimeout(() => startProfilePreviewLoop(), 240);
}

async function completeLoginWithGoogleTokens(id_token, access_token) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(
      { action: 'completeLogin', id_token, access_token },
      resp => {
        void chrome.runtime.lastError;
        resolve(resp || { success: false, code: 'generic', error: 'No response' });
      }
    );
  });
}

/** Silent → background; interactive → popup (user gesture) then completeLogin. */
async function runGoogleOAuthFlow({ silent = false } = {}) {
  if (silent) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'login', silent: true }, resp => {
        void chrome.runtime.lastError;
        resolve(resp || { success: false, code: 'cancelled', error: 'No response' });
      });
    });
  }
  const google = await launchGoogleWebAuthFlow({ silent: false });
  if (!google?.id_token || !google?.access_token) {
    return {
      success: false,
      code: google?.error || 'cancelled',
      error: google?.detail || 'Google auth failed or was cancelled'
    };
  }
  return completeLoginWithGoogleTokens(google.id_token, google.access_token);
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
      const silentOk = await runGoogleOAuthFlow({ silent: true });
      if (silentOk?.success) return true;

      showToast('Re-authenticating Google access...', 'info');
      const interactive = await runGoogleOAuthFlow({ silent: false });
      if (interactive?.success) {
        showToast('Reconnected to Google!', 'success');
        return true;
      }
      showToast('Google login failed.', 'error');
      return false;
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

/**
 * Shared bottom-sheet open/close. All sheets slide up/down (--sheet-slide-ms).
 * Closing keeps the node displayed until the slide-out finishes.
 */
const SHEET_SLIDE_MS = 420;
const MODAL_ANIM_MS = SHEET_SLIDE_MS;
function openOverlay(overlay) {
  clearTimeout(overlay._hideTimer);
  overlay.hidden = false;
  overlay.classList.remove('hidden', 'is-closing');
  void overlay.offsetWidth;
  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');
}
function closeOverlay(overlay) {
  overlay.setAttribute('aria-hidden', 'true');
  if (overlay.hidden) return;
  clearTimeout(overlay._hideTimer);
  overlay.classList.add('is-closing');
  overlay._hideTimer = setTimeout(() => {
    overlay.classList.remove('is-open', 'is-closing');
    overlay.classList.add('hidden');
    overlay.hidden = true;
  }, MODAL_ANIM_MS);
}
function closeOnbSheet(overlay) {
  if (!overlay || overlay.hidden || !overlay.classList.contains('is-open')) return Promise.resolve();
  if (overlay.id === 'onbPermsOverlay') resetPermsSheetEnter();
  return new Promise(resolve => {
    closeOverlay(overlay);
    setTimeout(resolve, MODAL_ANIM_MS);
  });
}
function openOnbSheet(overlay) {
  if (!overlay) return;
  openOverlay(overlay);
}

const PERMS_CARD_ENTER_MS = 450;
const PERMS_CARD_STAGGER_MS = 140;

function resetPermsSheetEnter() {
  const sheet = document.getElementById('onbPermsSheet');
  if (!sheet) return;
  clearTimeout(sheet._permsEnterTimer);
  sheet.classList.remove('is-perms-entering');
}

function playPermsSheetEnter() {
  const sheet = document.getElementById('onbPermsSheet');
  if (!sheet) return;
  resetPermsSheetEnter();
  if (typeof prefersReducedMotion === 'function' && prefersReducedMotion()) return;
  void sheet.offsetWidth;
  sheet.classList.add('is-perms-entering');
  const count = sheet.querySelectorAll('.onb-perm').length;
  const holdMs = SHEET_SLIDE_MS + PERMS_CARD_STAGGER_MS * Math.max(0, count - 1) + PERMS_CARD_ENTER_MS + 40;
  sheet._permsEnterTimer = setTimeout(() => sheet.classList.remove('is-perms-entering'), holdMs);
}

function openPromisePermsSheet() {
  const overlay = document.getElementById('onbPermsOverlay');
  if (!overlay || overlay.classList.contains('is-open')) return;
  playPermsSheetEnter();
  openOnbSheet(overlay);
}

/** Profile child sheets: freeze profile while open; only unstack after the child finishes sliding out. */
function setProfileStackedUnder(stacked) {
  const overlay = document.getElementById('profileOverlay');
  if (!overlay) return;
  clearTimeout(overlay._unstackTimer);
  if (stacked) {
    clearTimeout(overlay._contentTimer);
    overlay.classList.remove('is-entering');
    overlay.classList.add('is-stacked-under');
    return;
  }
  overlay.classList.remove('is-stacked-under');
}
function releaseProfileStackAfterSlide() {
  const overlay = document.getElementById('profileOverlay');
  if (!overlay?.classList.contains('is-stacked-under')) return;
  clearTimeout(overlay._unstackTimer);
  overlay._unstackTimer = setTimeout(() => {
    overlay.classList.remove('is-stacked-under');
  }, SHEET_SLIDE_MS);
}

function offlineMountParent() {
  if (document.body.classList.contains('onboarding-active')) {
    return document.getElementById('onboarding');
  }
  return document.getElementById('popupWrapper') || document.getElementById('scheduleScreen') || document.body;
}

function showNetworkLostScreen() {
  const overlay = document.getElementById('networkLostScreen');
  if (!overlay) return;
  const host = offlineMountParent();
  if (host && overlay.parentElement !== host) host.appendChild(overlay);

  hideSkeleton();
  document.getElementById('realContent')?.classList.remove('hidden');

  openOverlay(overlay);
  document.body.classList.add('is-offline');
  startOfflineFacts();
}

function hideNetworkLostScreen() {
  stopOfflineFacts();
  const overlay = document.getElementById('networkLostScreen');
  document.body.classList.remove('is-offline');
  if (!overlay) return;
  closeOverlay(overlay);
}

// ── Onboarding (logged-out only; always restarts at screen 1) ──
/** After one scroll step, top card moves to the end (infinite recycle). */
function recycleOnbCardOrder(ids) {
  if (!ids.length) return ids.slice();
  return ids.slice(1).concat(ids[0]);
}

/** Carousel slot: 3 visible full-width; the card leaving and the card arriving
 *  also scale between 90% and 100% (no width morph). */
function onb1CardSlot(index, phase) {
  const show = { width: '100%', opacity: '1', transform: 'scale(1)' };
  const hide = { width: '100%', opacity: '0', transform: 'scale(0.9)' };
  if (phase === 'rest') {
    if (index <= 2) return show;
    return hide;
  }
  // During scroll: top card shrinks + fades out, the 4th grows + fades in as the
  // new bottom card. Cards 1–2 just ride the stack up untouched.
  if (index === 0) return hide;
  if (index <= 3) return show;
  return hide;
}

/** Ascending day counts (selfcheck / legacy); live cards use randomOnbDay. */
function ascendingOnbDays(count, start = 7, step = 7) {
  return Array.from({ length: count }, (_, i) => start + i * step);
}

function formatOnbUnwatchedLabel(days) {
  return `Unwatched since ${days} days`;
}

function formatOnbWatchedLabel(days) {
  return `Watched since ${days} days`;
}

/** Promise stamp — Figma 143:4481 “Watched 2 hrs ago”. */
function formatOnbWatchedAgo() {
  const roll = Math.random();
  if (roll < 0.4) {
    const mins = 1 + Math.floor(Math.random() * 59);
    return mins === 1 ? 'Watched 1 min ago' : `Watched ${mins} mins ago`;
  }
  if (roll < 0.75) {
    const hrs = 1 + Math.floor(Math.random() * 11);
    return hrs === 1 ? 'Watched 1 hr ago' : `Watched ${hrs} hrs ago`;
  }
  const days = 1 + Math.floor(Math.random() * 14);
  return days === 1 ? 'Watched 1 day ago' : `Watched ${days} days ago`;
}

/** Random day stamp fallback when catalog entry has no unwatchedDays. */
function randomOnbDay() {
  return 7 + Math.floor(Math.random() * 60);
}

/** Pain stamp from catalog entry. */
function formatOnbPainLabel(meta) {
  return formatOnbUnwatchedLabel(meta?.unwatchedDays ?? randomOnbDay());
}

/** Promise stamp from catalog entry. */
function formatOnbPromiseLabel(meta) {
  return meta?.watchedLabel || formatOnbWatchedAgo();
}

/** Curated onboarding videos — titles/durations from YouTube oEmbed + watch page (2026-08-27). */
const ONB_YT_CATALOG = [
  {
    id: 'GatCEHiW7t4',
    title: 'How Swiggy Builds 0-1 Products (ft. Swiggy Designer)',
    thumb: 'Icon/onb/onb-yt-01.jpg',
    durationSec: 4183,
    unwatchedDays: 58,
    watchedLabel: 'Watched few hrs ago',
  },
  {
    id: '2ZCc4k_IV5w',
    title: 'Config 2026 Keynote with Dylan Field (CEO & Co-founder, Figma)',
    thumb: 'Icon/onb/onb-yt-02.jpg',
    durationSec: 4325,
    unwatchedDays: 32,
    watchedLabel: 'Watched 8 hrs ago',
  },
  {
    id: 'JWPrgCbUwC8',
    title: 'Sanjiv Goenka On Billionaires, The Next Big Opportunities & Building Wealth | FO553 Raj Shamani',
    thumb: 'Icon/onb/onb-yt-03.jpg',
    durationSec: 7756,
    unwatchedDays: 21,
    watchedLabel: 'Watched 24 hrs ago',
  },
  {
    id: 'hBMoPUAeLnY',
    title: 'Joe Rogan Experience #2219 - Donald Trump',
    thumb: 'Icon/onb/onb-yt-04.jpg',
    durationSec: 10730,
    unwatchedDays: 47,
    watchedLabel: 'Watched 1 day ago',
  },
  {
    id: 'XXpqejgnaB0',
    title: 'How Money Actually Works',
    thumb: 'Icon/onb/onb-yt-05.jpg',
    durationSec: 10710,
    unwatchedDays: 39,
    watchedLabel: 'Watched 7 days ago',
  },
  {
    id: 'C0gErQtnNFE',
    title: 'The Hardest Problem AI Ever Solved, with Google DeepMind CEO',
    thumb: 'Icon/onb/onb-yt-06.jpg',
    durationSec: 3911,
    unwatchedDays: 15,
    watchedLabel: 'Watched few hrs ago',
  },
];

let onbCardDeck = null; // shuffled ONB_YT_CATALOG entries
let onbCardCursor = 0;

function ensureOnbCardDeck() {
  if (onbCardDeck?.length) return onbCardDeck;
  onbCardDeck = shuffleCopy([...ONB_YT_CATALOG]).map((entry) => ({
    ...entry,
    duration: formatDurationLabel(entry.durationSec),
  }));
  onbCardCursor = 0;
  return onbCardDeck;
}

function pickOnbCardMeta(excludeIds = []) {
  const deck = ensureOnbCardDeck();
  if (!deck.length) return null;
  for (let n = 0; n < deck.length; n++) {
    const i = (onbCardCursor + n) % deck.length;
    const candidate = deck[i];
    if (!excludeIds.includes(candidate.id)) {
      onbCardCursor = (i + 1) % deck.length;
      return candidate;
    }
  }
  return deck[0];
}

function paintOnbCardContent(card, meta, formatLabel) {
  if (!card) return;
  const thumb = card.querySelector('.onb-thumb');
  const title = card.querySelector('.onb-title');
  const label = card.querySelector('.onb-label');
  const dur = card.querySelector('.onb-duration');
  if (meta) {
    card.dataset.ytId = meta.id;
    if (thumb) {
      thumb.src = meta.thumb;
      thumb.alt = '';
    }
    if (title) title.textContent = meta.title;
    if (dur) dur.textContent = meta.duration || formatDurationLabel(meta.durationSec);
  }
  if (label) {
    label.textContent = typeof formatLabel === 'function'
      ? formatLabel(meta)
      : String(formatLabel || '');
  }
}

/** Fill cards from ONB_YT_CATALOG. Pass fresh:true only on first Pain enter. */
function seedOnbCardsFromYoutube(root, formatLabel, { fresh = false } = {}) {
  const cards = [...root.querySelectorAll('.onb-card')];
  if (!cards.length) return;
  if (fresh) onbCardDeck = null;
  const deck = ensureOnbCardDeck();
  cards.forEach((card, i) => {
    paintOnbCardContent(card, deck[i % deck.length], formatLabel);
  });
}

/** Paint labels only (legacy / selfcheck helper). */
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
  ['#onboardingPain', '#onboardingPromise', '#onboardingPermissions', '#onboardingAnalyzing'].forEach(sel => {
    const stack = document.querySelector(`${sel} .onb-cards`);
    if (!stack) return;
    stack.style.transition = '';
    stack.style.transform = '';
    stack.querySelectorAll('.onb-card').forEach(c => {
      c.style.transition = '';
      c.style.opacity = '';
      c.style.width = '';
      c.style.transform = '';
    });
  });
}

function paintOnbCardSlots(stack, phase, durationMs) {
  const cards = [...stack.children];
  if (durationMs > 0) {
    const ease = `opacity ${durationMs}ms ease-in-out, transform ${durationMs}ms ease-in-out`;
    cards.forEach(c => { c.style.transition = ease; });
    void stack.offsetHeight;
  } else {
    cards.forEach(c => { c.style.transition = 'none'; });
  }
  cards.forEach((c, i) => {
    const s = onb1CardSlot(i, phase);
    c.style.width = s.width;
    c.style.opacity = s.opacity;
    c.style.transform = s.transform;
  });
}

/** Slides 1–2: full-width cards; 1.5× faster ease-in-out scroll. */
function startOnbCardScroll(screenSel, formatLabel) {
  stopOnbCardScroll();
  const stack = document.querySelector(`${screenSel} .onb-cards`);
  if (!stack) return;
  const state = { abort: false, stack };
  onbCardAnim = state;
  // ponytail: 1.5× prior pace; upgrade via Figma motion tokens if they land
  const DURATION_MS = Math.round(1600 / 1.5); // ~1067
  const PAUSE_MS = Math.round(900 / 1.5); // 600
  const EASE = 'ease-in-out';
  const wait = ms => new Promise(r => setTimeout(r, ms));

  paintOnbCardSlots(stack, 'rest', 0);

  (async function loop() {
    while (!state.abort) {
      const first = stack.firstElementChild;
      const second = first?.nextElementSibling;
      if (!first) break;
      const step = second
        ? (second.offsetTop - first.offsetTop)
        : first.offsetHeight;
      stack.style.transition = `transform ${DURATION_MS}ms ${EASE}`;
      void stack.offsetHeight;
      paintOnbCardSlots(stack, 'end', DURATION_MS);
      stack.style.transform = `translateY(-${step}px)`;
      await wait(DURATION_MS);
      if (state.abort) break;
      stack.style.transition = 'none';
      stack.appendChild(first);
      const visibleIds = [...stack.querySelectorAll('.onb-card')]
        .slice(0, 3)
        .map(c => c.dataset.ytId)
        .filter(Boolean);
      const meta = pickOnbCardMeta(visibleIds);
      if (meta) first.dataset.ytId = meta.id;
      paintOnbCardContent(first, meta, formatLabel);
      stack.style.transform = 'translateY(0)';
      paintOnbCardSlots(stack, 'rest', 0);
      void stack.offsetHeight;
      await wait(PAUSE_MS);
    }
  })();
}

/** First paint / page change: cards slowly slide in from below, then the carousel runs. */
async function enterOnbCardsThenPlay(screenSel, formatLabel, opts = {}) {
  const stack = document.querySelector(`${screenSel} .onb-cards`);
  // ponytail: slow enter (~1.1s); carousel keeps its own 1.5× bounce pace
  const ENTER_MS = 1100;
  const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const wait = ms => new Promise(r => setTimeout(r, ms));
  if (!stack) {
    startOnbCardScroll(screenSel, formatLabel);
    return;
  }
  if (!opts.prepped) {
    stopOnbCardScroll();
    await seedOnbCardsFromYoutube(stack, formatLabel, { fresh: opts.fresh });
    paintOnbCardSlots(stack, 'rest', 0);
    stack.style.transition = 'none';
    stack.style.transform = 'translateY(56%)';
    stack.style.opacity = '0';
    void stack.offsetHeight;
  }
  stack.style.transition = `transform ${ENTER_MS}ms ${EASE}, opacity ${ENTER_MS}ms ease-out`;
  stack.style.transform = 'translateY(0)';
  stack.style.opacity = '1';
  await wait(ENTER_MS);
  stack.style.transition = '';
  stack.style.transform = '';
  stack.style.opacity = '';
  startOnbCardScroll(screenSel, formatLabel);
}

/** Park cards off-screen below before a Pain↔Promise crossfade. */
async function prepOnbCardsEnter(screenSel, formatLabel, { fresh = false } = {}) {
  const stack = document.querySelector(`${screenSel} .onb-cards`);
  if (!stack) return;
  pauseOnbCardScroll();
  await seedOnbCardsFromYoutube(stack, formatLabel, { fresh });
  paintOnbCardSlots(stack, 'rest', 0);
  stack.style.transition = 'none';
  stack.style.transform = 'translateY(56%)';
  stack.style.opacity = '0';
  void stack.offsetHeight;
}

/** Promise → Permissions: keep the carousel mid-scroll on the new stack. */
function handoffOnbCardStack(fromSel, toSel, formatLabel) {
  pauseOnbCardScroll();
  const fromStack = document.querySelector(`${fromSel} .onb-cards`);
  const toStack = document.querySelector(`${toSel} .onb-cards`);
  if (!toStack) return;
  seedOnbCardsFromYoutube(toStack, formatLabel);
  paintOnbCardSlots(toStack, 'rest', 0);
  if (fromStack) {
    toStack.style.transition = 'none';
    toStack.style.transform = fromStack.style.transform || '';
    toStack.style.opacity = fromStack.style.opacity || '1';
    void toStack.offsetHeight;
  }
}

/** `instant` snaps without animating — each screen owns its own ticker, and the
 *  incoming one is pre-set to its own step in the markup, so it has to be rewound
 *  to the outgoing step before it can animate forward. */
function setOnbTickerActive(screen, activeIndex, { instant = false } = {}) {
  const ticks = screen?.querySelectorAll('.onb-tick');
  if (!ticks?.length) return;
  if (instant) ticks.forEach(t => { t.style.transition = 'none'; });
  ticks.forEach((t, i) => t.classList.toggle('active', i === activeIndex));
  if (!instant) return;
  void screen.offsetHeight;
  ticks.forEach(t => { t.style.transition = ''; });
}

const ONB_COPY_SHIFT = 24; // px the heading travels sideways
const ONB_MODAL_ENTER_MS = 650;
const ONB_MODAL_STAGGER_MS = 200;

function playOnbModalEnter(screen) {
  if (!screen || (typeof prefersReducedMotion === 'function' && prefersReducedMotion())) return;
  clearTimeout(screen._onbEnterTimer);
  screen.classList.remove('is-modal-entering');
  void screen.offsetWidth;
  screen.classList.add('is-modal-entering');
  const lineCount = screen.querySelectorAll('.onb-heading-line').length;
  const holdMs = ONB_MODAL_ENTER_MS + ONB_MODAL_STAGGER_MS * lineCount + 80;
  screen._onbEnterTimer = setTimeout(() => {
    screen.classList.remove('is-modal-entering');
  }, holdMs);
}

/** Pain↔Promise copy morph. Phases: `enter` (parked off to one side), `settle`
 *  (in place), `exit` (pushed the other way), `rest` (inline styles cleared).
 *  `forward` = moving to a later step, so copy leaves left and arrives from right.
 *
 *  Opacity is deliberately left to the section crossfade — fading the heading on
 *  top of that makes it vanish long before it finishes travelling.
 *
 *  Both screens animate their buttons to the *same* geometry, which is why `exit`
 *  and `enter` share one collapsed layout: the two Next buttons then occupy the
 *  identical rect at every frame and composite into one button changing shape.
 *  Morphing only the incoming one leaves the outgoing label visible beside it —
 *  a doubled "Next" for the length of the crossfade.
 */
function paintOnbCopySlots(screen, phase, forward, durationMs = 0) {
  if (!screen) return;
  const head = screen.querySelector('.onb-heading');
  const row = screen.querySelector('.onb-btn-row');
  const back = row?.querySelector('.onb-btn-secondary');
  const cta = screen.querySelector('.onb-modal-cta');
  const ease = durationMs > 0 ? `${durationMs}ms ease-in-out` : null;
  const shift = forward ? ONB_COPY_SHIFT : -ONB_COPY_SHIFT;

  if (head) {
    head.style.transition = ease ? `transform ${ease}` : 'none';
    if (phase === 'enter') head.style.transform = `translateX(${shift}px)`;
    else if (phase === 'exit') head.style.transform = `translateX(${-shift}px)`;
    else if (phase === 'rest') head.style.transform = '';
    else head.style.transform = 'translateX(0)';
  }
  if (cta) {
    cta.style.transition = ease ? `transform ${ease}` : 'none';
    if (phase === 'enter') cta.style.transform = `translateX(${shift}px)`;
    else if (phase === 'exit') cta.style.transform = `translateX(${-shift}px)`;
    else if (phase === 'rest') cta.style.transform = '';
    else cta.style.transform = 'translateX(0)';
  }
  const collapsed = phase === 'enter' || phase === 'exit';
  const halfW = 'calc(50% - var(--space-3) / 2)';
  if (back && row) {
    back.style.transition = ease ? `max-width ${ease}` : 'none';
    row.style.transition = ease ? `column-gap ${ease}` : 'none';
    back.style.maxWidth = phase === 'rest' ? '' : collapsed ? '0px' : halfW;
    row.style.columnGap = phase === 'rest' ? '' : collapsed ? '0px' : 'var(--space-3)';
  }
  if (phase === 'rest') {
    [head, row, back, cta].forEach(el => { if (el) el.style.transition = ''; });
  }
  if (!ease) void screen.offsetHeight;
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

/* ─── Onboarding 5: live calendar scan (Figma 422:1593 / 422:1594 / 418:978) ─── */
const ONB_CAL_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ONB_CAL_MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ONB_CAL_MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const ONB_CAL_ROWS = 3;
const CAL_FADE_MS = 400; /* paired with --cal-fade-ms */
const CAL_CELL_MS = 260; /* paired with --cal-cell-ms */
const CAL_PAUSE_MS = 200;
const CAL_TRACK_OFF = [-3, -2, -1, 0, 1, 2, 3];
let onbCalScan = null; // { abort, timer, resolveDone }

/** Mon–Sun week rows that touch `year`/`month` (0-indexed month).
 *  Out-of-month cells are empty chips — no overflow dates from adjacent months. */
function onbCalWeekdayRows(year, month) {
  const first = new Date(year, month, 1);
  const dow = first.getDay();
  const toMon = dow === 0 ? -6 : 1 - dow;
  let cursor = new Date(year, month, 1 + toMon);
  const rows = [];
  for (let i = 0; i < 6; i++) {
    const row = [];
    let anyIn = false;
    for (let c = 0; c < 7; c++) {
      const cell = new Date(cursor);
      cell.setDate(cursor.getDate() + c);
      const inMonth = cell.getMonth() === month && cell.getFullYear() === year;
      if (inMonth) {
        anyIn = true;
        row.push({
          day: ONB_CAL_DAY[cell.getDay()],
          date: String(cell.getDate()).padStart(2, '0'),
          inMonth: true,
        });
      } else {
        row.push({ day: '', date: '', inMonth: false, empty: true });
      }
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

/** Split week rows into 3-row pages so every in-month day gets scanned. */
function onbCalChunks(rows, size = ONB_CAL_ROWS) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
  return chunks.length ? chunks : [[]];
}

function paintOnbCalChunk(grid, rows) {
  grid.innerHTML = '';
  const slice = rows.slice(0, ONB_CAL_ROWS);
  while (slice.length < ONB_CAL_ROWS) {
    slice.push(Array.from({ length: 7 }, () => ({ day: '', date: '', inMonth: false, empty: true })));
  }
  slice.forEach((row) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'cal-week-row';
    row.forEach((cell) => {
      const el = document.createElement('div');
      el.className = 'cal-day-cell';
      if (cell.empty || !cell.inMonth) {
        el.classList.add('is-empty');
      } else {
        el.innerHTML = `<span class="cal-day">${cell.day}</span><span class="cal-date">${cell.date}</span>`;
      }
      rowEl.appendChild(el);
    });
    grid.appendChild(rowEl);
  });
}

function stopOnbCalScan() {
  if (!onbCalScan) return;
  onbCalScan.abort = true;
  if (onbCalScan.timer) clearTimeout(onbCalScan.timer);
  onbCalScan.resolveDone?.();
  onbCalScan = null;
}

/** Decorative scan: current → previous → next month. One in-month cell highlights at a time
 *  (left-to-right, top-to-bottom). Leftover weeks page in 3-row chunks. After a page (e.g. 1–20)
 *  the outgoing chips scale down + fade while the next page scales in with a spring overshoot —
 *  same tick as the month carousel. Loops until stopOnbCalScan(). */
function startOnbCalScan() {
  stopOnbCalScan();
  const grid = document.getElementById('onbCalGrid');
  const stack = grid?.parentNode;
  const track = document.getElementById('calMonthTrack');
  if (!grid || !stack || !track) return;

  const months = onbCalMonthsAround();
  const monthChunks = months.map(m => onbCalChunks(onbCalWeekdayRows(m.year, m.month)));
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });
  const state = { abort: false, timer: 0, resolveDone };
  onbCalScan = state;

  const monthLabelAt = (year, month) => {
    const d = new Date(year, month, 1);
    return `${ONB_CAL_MON_SHORT[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
  };

  const paintTrack = (year, month) => {
    track.querySelectorAll('[data-cal-off]').forEach(el => {
      const off = Number(el.dataset.calOff);
      const inner = el.querySelector('.cal-month-label-inner');
      if (inner) inner.textContent = monthLabelAt(year, month + off);
    });
  };

  const buildTrack = () => {
    track.innerHTML = '';
    CAL_TRACK_OFF.forEach((off, i) => {
      if (i) {
        const div = document.createElement('span');
        div.className = 'cal-month-divider';
        track.appendChild(div);
      }
      const lab = document.createElement('span');
      lab.className = 'cal-month-label';
      lab.dataset.calOff = String(off);
      const inner = document.createElement('span');
      inner.className = 'cal-month-label-inner';
      lab.appendChild(inner);
      track.appendChild(lab);
    });
  };

  const delay = (ms) => new Promise(r => {
    state.timer = setTimeout(r, ms);
  });

  let sliderYM = { year: months[1].year, month: months[1].month };
  let pendingYM = null;

  const startCarousel = (year, month) => {
    const diff = (year - sliderYM.year) * 12 + (month - sliderYM.month);
    if (!diff) return;
    pendingYM = { year, month };
    track.classList.remove('is-snap');
    void track.offsetWidth;
    track.style.setProperty('--cal-track-shift', String(diff));
  };

  const finishCarousel = () => {
    if (!pendingYM) return;
    sliderYM = pendingYM;
    pendingYM = null;
    paintTrack(sliderYM.year, sliderYM.month);
    track.classList.add('is-snap');
    track.style.setProperty('--cal-track-shift', '0');
    void track.offsetWidth;
    track.classList.remove('is-snap');
  };

  const swapChunk = async (monthIdx, chunk, { withMonth, first }) => {
    if (state.abort) return;
    const m = months[monthIdx];
    if (!first) {
      const outgoing = grid.cloneNode(true);
      outgoing.removeAttribute('id');
      outgoing.classList.add('cal-grid-outgoing', 'is-fading-out');
      stack.appendChild(outgoing);
      if (withMonth) startCarousel(m.year, m.month);
      paintOnbCalChunk(grid, chunk);
      grid.classList.add('is-fading-in');
      await delay(CAL_FADE_MS);
      outgoing.remove();
      if (state.abort) return;
      grid.classList.remove('is-fading-in');
      finishCarousel();
    } else {
      sliderYM = { year: m.year, month: m.month };
      paintTrack(m.year, m.month);
      paintOnbCalChunk(grid, chunk);
      grid.classList.add('is-fading-in');
      await delay(CAL_FADE_MS);
      if (state.abort) return;
      grid.classList.remove('is-fading-in');
    }
  };

  const scanChunk = async () => {
    if (state.abort) return;
    const cells = [...grid.querySelectorAll('.cal-day-cell')];
    const scannable = cells.filter(c => !c.classList.contains('is-empty'));
    for (let i = 0; i < scannable.length; i++) {
      if (state.abort) return;
      if (i > 0) scannable[i - 1].classList.remove('is-scanned');
      scannable[i].classList.add('is-scanned');
      await delay(CAL_CELL_MS);
    }
    if (state.abort) return;
    if (scannable.length) {
      await delay(CAL_CELL_MS);
      scannable[scannable.length - 1].classList.remove('is-scanned');
    }
    await delay(CAL_PAUSE_MS);
  };

  const loop = async () => {
    buildTrack();
    if (typeof prefersReducedMotion === 'function' && prefersReducedMotion()) {
      paintTrack(months[1].year, months[1].month);
      paintOnbCalChunk(grid, monthChunks[1][0] || []);
      return;
    }
    let first = true;
    let prevMi = null;
    const order = [1, 0, 2]; // current, previous, next
    while (!state.abort) {
      for (const mi of order) {
        if (state.abort) return;
        for (const chunk of monthChunks[mi]) {
          if (state.abort) return;
          await swapChunk(mi, chunk, { withMonth: first || mi !== prevMi, first });
          first = false;
          prevMi = mi;
          await scanChunk();
        }
      }
    }
  };

  loop().then(() => { resolveDone?.(); });
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
      if (window.__WL_PREVIEW__) showToast('Preview mode — close is a no-op here', 'info');
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
  hideAuthFlow();
  hideNewUserWrongUrl();
  document.getElementById('onboarding')?.classList.add('hidden');
  document.getElementById('scheduleScreen')?.classList.remove('hidden');
  document.body.classList.remove('onboarding-active', 'is-auth-flow', 'is-auth-connecting', 'is-onb-wrong-url');
}

const ONB_FLAG_COMPLETE = 'onboardingComplete';
const ONB_FLAG_SCANNED = 'calendarScanned';
const ANALYZE_MIN_MS = 2500;
const ANALYZE_MAX_MS = 8000;

let authFlowKind = 'new'; // 'new' | 'new-wrong-url' | 'returning'
let authPopupBlockedCount = 0;
let authLoginInFlight = false;
let onboardingGoTo = null; // set by showOnboarding

function storageGet(keys) {
  return new Promise(res => chrome.storage.local.get(keys, res));
}
function storageSet(obj) {
  return new Promise(res => chrome.storage.local.set(obj, res));
}
function storageRemove(keys) {
  return new Promise(res => chrome.storage.local.remove(keys, res));
}

// Popup + background alarm must not rotate the same refresh token concurrently —
// Supabase reuse-detection revokes the whole family ("Invalid Refresh Token: Already Used").
const AUTH_REFRESH_LOCK_KEY = 'auth_refresh_lock';
const AUTH_REFRESH_LOCK_TTL_MS = 12000;

function isRefreshTokenReuseError(err) {
  const msg = err?.message || String(err || '');
  return /already used|invalid refresh token/i.test(msg);
}

async function acquireAuthRefreshLock() {
  const owner = crypto.randomUUID();
  for (let attempt = 0; attempt < 50; attempt++) {
    const now = Date.now();
    const cur = await storageGet([AUTH_REFRESH_LOCK_KEY]);
    const lock = cur[AUTH_REFRESH_LOCK_KEY];
    if (!lock?.at || now - lock.at > AUTH_REFRESH_LOCK_TTL_MS) {
      await storageSet({ [AUTH_REFRESH_LOCK_KEY]: { owner, at: now } });
      const check = await storageGet([AUTH_REFRESH_LOCK_KEY]);
      if (check[AUTH_REFRESH_LOCK_KEY]?.owner === owner) return owner;
    }
    await new Promise(r => setTimeout(r, 40 + (crypto.getRandomValues(new Uint8Array(1))[0] % 60)));
  }
  return owner;
}

async function releaseAuthRefreshLock(owner) {
  const cur = await storageGet([AUTH_REFRESH_LOCK_KEY]);
  if (cur[AUTH_REFRESH_LOCK_KEY]?.owner === owner) {
    await storageRemove(AUTH_REFRESH_LOCK_KEY);
  }
}

/** setSession under a lock; on reuse error, adopt tokens another party just wrote. */
async function restoreSupabaseSession(accessToken, refreshToken) {
  const owner = await acquireAuthRefreshLock();
  try {
    const fresh = await storageGet(['supabase_token', 'supabase_refresh']);
    let at = fresh.supabase_token || accessToken;
    let rt = fresh.supabase_refresh || refreshToken;
    let { data, error } = await supabaseClient.auth.setSession({
      access_token: at,
      refresh_token: rt
    });
    if (error && isRefreshTokenReuseError(error)) {
      const again = await storageGet(['supabase_token', 'supabase_refresh']);
      if (again.supabase_refresh && again.supabase_refresh !== rt) {
        ({ data, error } = await supabaseClient.auth.setSession({
          access_token: again.supabase_token,
          refresh_token: again.supabase_refresh
        }));
      }
    }
    if (!error && data?.session) await persistSupabaseSession(data.session);
    return { data, error };
  } finally {
    await releaseAuthRefreshLock(owner);
  }
}

/** Infer flags for installs that predate these keys. */
async function migrateOnboardingFlags(userId) {
  const cur = await storageGet([ONB_FLAG_COMPLETE, ONB_FLAG_SCANNED, 'supabase_token', 'supabase_refresh']);
  const patch = {};
  if (cur[ONB_FLAG_COMPLETE] == null && cur.supabase_token && cur.supabase_refresh) {
    patch[ONB_FLAG_COMPLETE] = true;
  }
  if (cur[ONB_FLAG_SCANNED] == null && userId && typeof supabaseClient !== 'undefined') {
    try {
      const { data: pref } = await supabaseClient
        .from('user_slot_preferences')
        .select('selected_days')
        .eq('user_id', userId)
        .maybeSingle();
      const days = pref?.selected_days;
      if (Array.isArray(days) && days.length) {
        patch[ONB_FLAG_SCANNED] = true;
      }
    } catch (_) { /* ignore */ }
  }
  if (Object.keys(patch).length) await storageSet(patch);
  return { ...cur, ...patch };
}

function classifyOAuthError(resp, meta = {}) {
  const err = String(resp?.error || meta.error || '').toLowerCase();
  const code = resp?.code || meta.code || '';
  if (code === 'flow_busy' || /only one web auth flow/i.test(err)) return 'flow_busy';
  if (code === 'popup_blocked' || meta.popupBlocked) return 'popup_blocked';
  if (code === 'denied' || /access.?denied|scope|permission/.test(err)) return 'denied';
  if (code === 'interrupted' || /interrupt/.test(err)) return 'interrupted';
  if (code === 'config' || /redirect_uri|invalid_client|unauthorized_client/.test(err)) return 'config';
  if (code === 'cancelled' || /cancel|closed|dismiss/.test(err)) return 'cancelled';
  if (!resp?.success && !err) return 'cancelled';
  if (/network|timeout|fetch|failed to fetch/.test(err)) return 'generic';
  return 'generic';
}

// ponytail: only gates play() inside showAuthPanel — doesn't strip the HTML
// `autoplay` attribute itself, so a panel's video could still autoplay muted
// off-screen before its first showAuthPanel() call. Fine since the concern is
// what the user perceives, not background decode; strip the attribute too if
// that ever matters.
function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function hideAuthFlow() {
  const host = document.getElementById('authFlowHost');
  if (!host) return;
  clearTimeout(host._authHideTimer);
  host.classList.remove('is-open', 'is-closing');
  host.classList.add('hidden');
  host.hidden = true;
  host.setAttribute('aria-hidden', 'true');
  host.querySelectorAll('.auth-panel').forEach(p => {
    p.classList.add('hidden');
    p.hidden = true;
  });
  host.querySelectorAll('.auth-video').forEach(v => {
    try { v.pause(); } catch (_) {}
  });
  const banner = document.getElementById('authPopupBlockedBanner');
  if (banner) { banner.classList.add('hidden'); banner.hidden = true; }
  document.body.classList.remove('is-auth-flow', 'is-auth-connecting', 'is-auth-wrong-url');
  document.getElementById('onboardingPermissions')?.classList.remove('is-auth-covered');
  document.getElementById('authFlowLiveThumb')?.classList.add('hidden');
  const fallBg = document.getElementById('authFlowFallBg');
  if (fallBg) { fallBg.classList.add('hidden'); fallBg.setAttribute('aria-hidden', 'true'); }
}

function closeAuthFlowAnimated() {
  const host = document.getElementById('authFlowHost');
  if (!host || host.hidden || !host.classList.contains('is-open')) {
    hideAuthFlow();
    return Promise.resolve();
  }
  return new Promise(resolve => {
    host.classList.add('is-closing');
    clearTimeout(host._authHideTimer);
    host._authHideTimer = setTimeout(() => {
      hideAuthFlow();
      resolve();
    }, SHEET_SLIDE_MS);
  });
}

function showAuthPanel(panelId) {
  const host = document.getElementById('authFlowHost');
  if (!host) return;
  // Prefer visible host: Promise (perms modal) when open, else onboarding root
  const promise = document.getElementById('onboardingPromise');
  const perms = document.getElementById('onboardingPermissions');
  const onb = document.getElementById('onboarding');
  const mount =
    (promise && !promise.classList.contains('hidden') && promise) ||
    (perms && !perms.classList.contains('hidden') && perms) ||
    (onb && !onb.classList.contains('hidden') && onb) ||
    document.getElementById('popupWrapper') ||
    document.body;
  if (host.parentElement !== mount) mount.appendChild(host);

  host.hidden = false;
  host.classList.remove('hidden', 'is-closing');
  host.setAttribute('aria-hidden', 'false');
  void host.offsetWidth;
  host.classList.add('is-open');
  document.body.classList.add('is-auth-flow');
  if (panelId === 'authConnecting') document.body.classList.add('is-auth-connecting');
  else document.body.classList.remove('is-auth-connecting');
  // Permissions sheet closes before auth opens — cards stay visible under auth dim.

  host.querySelectorAll('.auth-panel').forEach(p => {
    const on = p.id === panelId;
    p.classList.toggle('hidden', !on);
    p.hidden = !on;
    const vid = p.querySelector('.auth-video');
    if (!vid) return;
    if (on) {
      // Decorative loop only — vestibular-motion users get the static first/poster
      // frame instead, per prefers-reduced-motion.
      try { vid.currentTime = 0; } catch (_) {}
      if (!prefersReducedMotion()) { try { vid.play().catch(() => {}); } catch (_) {} }
    } else {
      try { vid.pause(); } catch (_) {}
    }
  });

  // Figma 171:682 — warn banner always visible on Connecting (click = Try again)
  if (panelId === 'authConnecting') showPopupBlockedBanner();
  else {
    const banner = document.getElementById('authPopupBlockedBanner');
    if (banner) { banner.classList.add('hidden'); banner.hidden = true; }
  }
}

async function prepareAuthBackdrop() {
  const thumbWrap = document.getElementById('authFlowLiveThumb');
  const img = document.getElementById('authFlowThumbImg');
  const fallBg = document.getElementById('authFlowFallBg');

  // Wrong URL first-time: cards + fall BG (wrongURLfallanimation), not schedule chrome
  if (authFlowKind === 'new-wrong-url') {
    document.body.classList.add('is-auth-wrong-url');
    thumbWrap?.classList.add('hidden');
    if (fallBg) {
      fallBg.classList.remove('hidden');
      fallBg.setAttribute('aria-hidden', 'false');
    }
    return;
  }

  document.body.classList.remove('is-auth-wrong-url');
  if (fallBg) {
    fallBg.classList.add('hidden');
    fallBg.setAttribute('aria-hidden', 'true');
  }

  const tab = await getActiveInjectableTab().catch(() => null);
  const onWatch = isYouTubeWatchUrl(tab?.url);
  if (onWatch && thumbWrap && img) {
    try {
      const id = new URL(tab.url).searchParams.get('v');
      img.src = id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '';
      thumbWrap.classList.remove('hidden');
    } catch (_) {
      thumbWrap.classList.add('hidden');
    }
  } else {
    thumbWrap?.classList.add('hidden');
  }
}

function wireAuthPanelsOnce() {
  const host = document.getElementById('authFlowHost');
  if (!host || host.dataset.wired) return;
  host.dataset.wired = '1';

  host.querySelectorAll('[data-auth-retry]').forEach(btn => {
    btn.addEventListener('click', () => startConnectingAndLogin());
  });
  host.querySelectorAll('[data-auth-not-now]').forEach(btn => {
    btn.addEventListener('click', () => {
      hideAuthFlow();
      if (authFlowKind === 'new' || authFlowKind === 'new-wrong-url') {
        if (typeof onboardingGoTo === 'function') {
          void onboardingGoTo(1).then(() => openPromisePermsSheet());
        } else openPromisePermsSheet();
      } else {
        window.close();
      }
    });
  });
  document.getElementById('authPopupBlockedBanner')?.addEventListener('click', () => {
    startConnectingAndLogin({ fromBanner: true });
  });
  document.getElementById('authWhyCalendar')?.addEventListener('click', () => {
    hideAuthFlow();
    if (typeof onboardingGoTo === 'function') {
      void onboardingGoTo(1).then(() => openPromisePermsSheet());
    } else openPromisePermsSheet();
  });
}

function showPopupBlockedBanner() {
  const banner = document.getElementById('authPopupBlockedBanner');
  if (!banner) return;
  banner.hidden = false;
  banner.classList.remove('hidden');
}

async function finishPostAuthScan(name) {
  const first = (name || '').trim().split(' ')[0];
  const scanName = document.getElementById('scanName');
  if (scanName) scanName.textContent = (first || 'there') + ',';

  await storageSet({ [ONB_FLAG_COMPLETE]: true });
  hideNewUserWrongUrl();

  // Returning reconnect: skip Analyzing UI → Schedule (silent prefs refresh if needed)
  if (authFlowKind === 'returning') {
    const flags = await storageGet([ONB_FLAG_SCANNED]);
    if (!flags[ONB_FLAG_SCANNED]) {
      try {
        const stored = await storageGet(['userId', 'google_access_token']);
        await analyzeAndSavePrefs(stored.userId, stored.google_access_token, {
          force: true,
          triggeredBy: 'reconnect',
        });
      } catch (_) { /* schedule still opens; prefs may be empty */ }
      await storageSet({ [ONB_FLAG_SCANNED]: true });
    }
    hideAuthFlow();
    hideOnboarding();
    await initPopup();
    return;
  }

  const flags = await storageGet([ONB_FLAG_SCANNED]);
  if (flags[ONB_FLAG_SCANNED]) {
    hideAuthFlow();
    hideOnboarding();
    await initPopup();
    return;
  }

  await closeOnbSheet(document.getElementById('onbPermsOverlay'));
  await closeAuthFlowAnimated();
  if (typeof onboardingGoTo === 'function') {
    await onboardingGoTo(3, { openAnalyzeSheet: true });
  } else {
    document.getElementById('onboarding')?.classList.remove('hidden');
    document.body.classList.add('onboarding-active');
    ['onboardingPain', 'onboardingPromise', 'onboardingPermissions', 'newUserWrongUrl'].forEach(id => {
      document.getElementById(id)?.classList.add('hidden');
    });
    const analyzing = document.getElementById('onboardingAnalyzing');
    analyzing?.classList.remove('hidden');
    startOnbCalScan();
    openOnbSheet(document.getElementById('onbAnalyzeOverlay'));
  }

  const statusEl = document.getElementById('onbAnalyzeStatus');
  const statusText = document.getElementById('onbAnalyzeStatusText');
  const retryBtn = document.getElementById('onbAnalyzeRetry');
  const ANALYZE_BANNER_DEFAULT = 'We never check your events or their details.';
  const setAnalyzeBanner = (mode, msg) => {
    if (!statusEl || !statusText) return;
    if (mode === 'default') {
      statusEl.classList.remove('is-live');
      statusText.textContent = ANALYZE_BANNER_DEFAULT;
    } else {
      statusEl.classList.add('is-live');
      statusText.textContent = msg || ANALYZE_BANNER_DEFAULT;
    }
  };
  setAnalyzeBanner('default');
  if (retryBtn) { retryBtn.classList.add('hidden'); retryBtn.hidden = true; }

  const runAnalyze = async () => {
    const stored = await storageGet(['userId', 'google_access_token']);
    let analyzeOk = false;
    const analyzeP = (async () => {
      try {
        await analyzeAndSavePrefs(stored.userId, stored.google_access_token, {
          force: true,
          triggeredBy: 'onboarding',
        });
        analyzeOk = true;
      } catch (_) {
        analyzeOk = false;
      }
    })();
    const minP = new Promise(r => setTimeout(r, ANALYZE_MIN_MS));
    const maxP = new Promise(r => setTimeout(r, ANALYZE_MAX_MS));
    const outcome = await Promise.race([
      Promise.all([analyzeP, minP]).then(() => 'ok'),
      maxP.then(() => 'timeout')
    ]);

    if (outcome === 'timeout' && !analyzeOk) {
      await Promise.race([analyzeP, new Promise(r => setTimeout(r, 100))]);
    }

    if (!analyzeOk) {
      setAnalyzeBanner('live', "Couldn't read your calendar. Retry without signing in again.");
      if (retryBtn) {
        retryBtn.hidden = false;
        retryBtn.classList.remove('hidden');
        retryBtn.onclick = () => {
          retryBtn.disabled = true;
          setAnalyzeBanner('default');
          void runAnalyze().finally(() => { retryBtn.disabled = false; });
        };
      }
      return;
    }

    await storageSet({ [ONB_FLAG_SCANNED]: true });
    if (authFlowKind === 'new-wrong-url') {
      await closeOnbSheet(document.getElementById('onbAnalyzeOverlay'));
      stopOnbCalScan();
      document.getElementById('onboardingAnalyzing')?.classList.add('hidden');
      showWrongUrlFallAnim();
      return;
    }
    await closeOnbSheet(document.getElementById('onbAnalyzeOverlay'));
    await initPopup();
    hideOnboarding();
    // Field-level resume: if scan failed and prefs empty → day prefs; else schedule
    try {
      const stored = await storageGet(['userId']);
      const prefs = await loadUserPrefs(stored.userId);
      const dest = (typeof WLSlotAlgorithm !== 'undefined')
        ? WLSlotAlgorithm.resumeDestination({
            calendarScanned: true,
            selectedDays: prefs.days,
            selectedTimes: prefs.slots,
          })
        : 'schedule';
      if (dest === 'pref_days') await openSchedPrefs('day');
      else if (dest === 'pref_times') await openSchedPrefs('time');
    } catch (_) { /* schedule already shown */ }
  };

  await runAnalyze();
}

async function startConnectingAndLogin(opts = {}) {
  if (authLoginInFlight) return;
  authLoginInFlight = true;
  wireAuthPanelsOnce();
  await prepareAuthBackdrop();
  showAuthPanel('authConnecting');

  const allowBtn = document.getElementById('onbPermsAllow');
  if (allowBtn) allowBtn.disabled = true;

  try {
    let resp;
    if (authFlowKind === 'returning') {
      resp = await runGoogleOAuthFlow({ silent: true });
      if (!resp?.success) resp = await runGoogleOAuthFlow({ silent: false });
    } else {
      resp = await runGoogleOAuthFlow({ silent: false });
    }

    if (resp?.success) {
      authPopupBlockedCount = 0;
      await finishPostAuthScan(resp.name);
      return;
    }

    const kind = classifyOAuthError(resp);
    if (kind === 'flow_busy' && !opts._flowBusyRetry) {
      await new Promise(r => setTimeout(r, 300));
      return startConnectingAndLogin({ ...opts, _flowBusyRetry: true });
    }
    if (kind === 'popup_blocked') {
      authPopupBlockedCount += 1;
      showAuthPanel('authConnecting');
      showPopupBlockedBanner();
      if (authPopupBlockedCount > 2) {
        const body = document.getElementById('authGenericBody');
        const chip = document.getElementById('authGenericChip');
        if (chip) chip.textContent = 'connecting';
        if (body) {
          body.textContent = "The sign-in window couldn't open. Allow popups for this extension, then retry.";
        }
        showAuthPanel('authSomethingWrong');
        console.warn('[auth] popup_blocked escalated', resp);
      }
      return;
    }

    if (kind === 'denied') showAuthPanel('authCalendarDenied');
    else if (kind === 'interrupted') showAuthPanel('authFlowInterrupted');
    else if (kind === 'cancelled') showAuthPanel('authSignInCancelled');
    else {
      const body = document.getElementById('authGenericBody');
      const chip = document.getElementById('authGenericChip');
      const retry = document.getElementById('authGenericRetry');
      if (chip) chip.textContent = 'connecting';
      if (kind === 'config') {
        if (body) body.textContent = "This looks like an extension setup issue — retrying won't fix it. Contact support if it continues.";
        if (retry) retry.classList.add('hidden');
        console.error('[auth] config/redirect_uri_mismatch', resp);
      } else {
        if (body) body.textContent = 'Please try again this usually resolves itself.';
        if (retry) retry.classList.remove('hidden');
      }
      showAuthPanel('authSomethingWrong');
    }
  } finally {
    authLoginInFlight = false;
    if (allowBtn) allowBtn.disabled = false;
  }
}

/** Lightweight reconnect for returning users (skips Pain/Promise/Permissions). */
async function showReturningConnecting() {
  const tab = await getActiveInjectableTab().catch(() => null);
  if (!isYouTubeWatchUrl(tab?.url)) {
    showNewUserWrongUrl();
    return;
  }
  authFlowKind = 'returning';
  authPopupBlockedCount = 0;
  hideNewUserWrongUrl();
  document.getElementById('onboarding')?.classList.add('hidden');
  document.body.classList.remove('onboarding-active');
  document.getElementById('scheduleScreen')?.classList.remove('hidden');
  hideSkeleton();
  document.getElementById('realContent')?.classList.remove('hidden');
  const host = document.getElementById('authFlowHost');
  const wrap = document.getElementById('popupWrapper') || document.body;
  if (host && host.parentElement !== wrap) wrap.appendChild(host);
  await startConnectingAndLogin();
}

function showOnboarding(opts = {}) {
  const screens = ['onboardingPain', 'onboardingPromise', 'onboardingPermissions', 'onboardingAnalyzing']
    .map(id => document.getElementById(id))
    .filter(Boolean);
  let current = 0;
  let transitioning = false;
  const TRANS_MS = 450;
  const wait = ms => new Promise(r => setTimeout(r, ms));

  authFlowKind = opts.wrongUrl ? 'new-wrong-url' : 'new';
  authPopupBlockedCount = 0;
  document.body.classList.toggle('is-onb-wrong-url', !!opts.wrongUrl);

  const syncCardAnim = (i, { prepped = false, handoff = false } = {}) => {
    stopOnb3Video();
    if (i === 0) return enterOnbCardsThenPlay('#onboardingPain', formatOnbPainLabel, { prepped, fresh: !prepped });
    if (i === 1) return enterOnbCardsThenPlay('#onboardingPromise', formatOnbPromiseLabel, { prepped });
    if (i === 2) {
      if (handoff) {
        startOnbCardScroll('#onboardingPermissions', formatOnbPromiseLabel);
        return Promise.resolve();
      }
      return enterOnbCardsThenPlay('#onboardingPermissions', formatOnbPromiseLabel, { prepped });
    }
    stopOnbCardScroll(); // Analyzing only
    if (i === 3) startOnbCalScan();
    else stopOnbCalScan();
    return Promise.resolve();
  };

  const clearEl = (el) => {
    if (!el) return;
    el.style.transition = '';
    el.style.opacity = '';
    el.style.transform = '';
    el.style.height = '';
    el.querySelectorAll('.onb-heading, .onb-modal-cta, .onb-btn-row, .onb-btn-secondary').forEach(node => {
      node.style.transition = '';
      node.style.transform = '';
      node.style.maxWidth = '';
      node.style.width = '';
      node.style.alignSelf = '';
      node.style.columnGap = '';
    });
  };

  const goTo = async (i, opts = {}) => {
    if (transitioning || i === current || i < 0 || i >= screens.length) return;
    transitioning = true;
    await closeAuthFlowAnimated();
    if (current === 1) await closeOnbSheet(document.getElementById('onbPermsOverlay'));
    if (current === 3) await closeOnbSheet(document.getElementById('onbAnalyzeOverlay'));
    const from = screens[current];
    const to = screens[i];
    const fadeEase = `opacity ${TRANS_MS}ms ease-in-out`;
    const toCardScreen = i === 0 || i === 1 || i === 2;
    const formatLabel = i === 0 ? formatOnbPainLabel : formatOnbPromiseLabel;
    const cardScreenSel = i === 0 ? '#onboardingPain' : i === 1 ? '#onboardingPromise' : '#onboardingPermissions';
    let permsHandoff = false;

    if (toCardScreen) {
      if (i === 2 && current === 1) {
        handoffOnbCardStack('#onboardingPromise', '#onboardingPermissions', formatOnbPromiseLabel);
        permsHandoff = true;
      } else {
        await prepOnbCardsEnter(cardScreenSel, formatLabel, { fresh: i === 0 && current !== 1 });
      }
    } else {
      stopOnbCardScroll();
    }

    to.classList.remove('hidden');
    // Copy/button morph only exists between Pain and Promise — the other screens
    // are a different sheet entirely and just crossfade.
    const morphCopy = (i === 0 || i === 1) && (current === 0 || current === 1);
    const forward = i > current;
    const promiseShellOnly = morphCopy && forward && i === 1;
    if (i <= 1 && !morphCopy) playOnbModalEnter(to);
    // Rewind the incoming ticker so both tickers animate the same step change
    // together underneath the crossfade.
    const tickIndex = Math.min(i, 1);
    setOnbTickerActive(to, Math.min(current, 1), { instant: true });
    if (promiseShellOnly) to.classList.add('is-modal-shell-only');
    else if (morphCopy) paintOnbCopySlots(to, 'enter', forward);
    from.style.zIndex = '1';
    to.style.zIndex = '2';
    to.style.transition = 'none';
    to.style.opacity = '0';
    void to.offsetHeight;
    to.style.transition = fadeEase;
    from.style.transition = fadeEase;
    to.style.opacity = '1';
    from.style.opacity = '0';
    if (morphCopy) {
      paintOnbCopySlots(from, 'exit', forward, TRANS_MS);
      if (!promiseShellOnly) paintOnbCopySlots(to, 'settle', forward, TRANS_MS);
    }
    setOnbTickerActive(to, tickIndex);
    setOnbTickerActive(from, tickIndex);
    await wait(TRANS_MS);
    from.classList.add('hidden');
    from.style.zIndex = '';
    to.style.zIndex = '';
    clearEl(from);
    clearEl(to);
    paintOnbCopySlots(from, 'rest');
    paintOnbCopySlots(to, 'rest');
    if (promiseShellOnly) {
      to.classList.remove('is-modal-shell-only');
      void to.offsetWidth;
    }
    if (morphCopy && forward && i === 1) playOnbModalEnter(to);
    await syncCardAnim(i, { prepped: toCardScreen && !permsHandoff, handoff: permsHandoff });
    current = i;
    if (i === 3 && opts.openAnalyzeSheet !== false) {
      openOnbSheet(document.getElementById('onbAnalyzeOverlay'));
    }
    transitioning = false;
  };

  onboardingGoTo = goTo;

  document.body.classList.add('onboarding-active');
  document.getElementById('onboarding')?.classList.remove('hidden');
  hideAuthFlow();
  hideNewUserWrongUrl();
  stopWrongUrlFallAnim();
  screens.forEach((s, j) => {
    s.classList.toggle('hidden', j !== 0);
    s.style.zIndex = '';
    clearEl(s);
    paintOnbCopySlots(s, 'rest');
  });
  setOnbTickerActive(screens[0], 0);
  syncCardAnim(0);
  current = 0;
  playOnbModalEnter(screens[0]);

  const painNext = document.getElementById('onbPainNext');
  const promiseNext = document.getElementById('onbPromiseNext');
  const permsAllow = document.getElementById('onbPermsAllow');

  if (painNext) painNext.onclick = () => goTo(1);
  if (promiseNext) promiseNext.onclick = () => openPromisePermsSheet();
  if (permsAllow) {
    permsAllow.onclick = async () => {
      // Preview can't OAuth — jump to Analyzing → wrongURLwrongURL (or Schedule).
      if (window.__WL_PREVIEW__) {
        void (async () => {
          await closeOnbSheet(document.getElementById('onbPermsOverlay'));
          await storageSet({
            supabase_token: 'preview-token',
            supabase_refresh: 'preview-refresh',
            google_access_token: 'preview-google',
            userId: 'preview-user',
            [ONB_FLAG_COMPLETE]: true
          });
          await finishPostAuthScan('Preview');
        })();
        return;
      }
      if (transitioning) return;
      await startConnectingAndLogin();
    };
  }

  document.querySelectorAll('[data-onb-goto]').forEach(tick => {
    if (tick.dataset.bound) return;
    tick.dataset.bound = '1';
    const jump = () => {
      const target = Number(tick.getAttribute('data-onb-goto'));
      if (!Number.isFinite(target)) return;
      if (target === 2) openPromisePermsSheet();
      else if (target <= 1) goTo(target);
    };
    tick.addEventListener('click', jump);
    tick.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(); }
    });
  });
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

    async function tryScheduleEventOnce(google_access_token, slot, title, authUser, videoUrl, partInfo = null) {
    const channelInfo = await fetchCurrentYouTubeChannelInfo();
    const rawChannel = channelInfo?.name || 'Unknown Channel';
    const rawDesc = await fetchCurrentYouTubeDescription();
    const [enTitle, channelName, about] = await Promise.all([
      translateToEnglish(title),
      translateToEnglish(rawChannel),
      translateToEnglish(rawDesc),
    ]);
    const summary = partInfo
      ? `Part ${partInfo.sessionIndex} of ${partInfo.sessionCount} — ${enTitle}`
      : enTitle;
    let videoLink = videoUrl;
    try {
      const u = new URL(videoUrl);
      if (partInfo?.videoOffsetStartSec > 0) {
        u.searchParams.set('t', String(partInfo.videoOffsetStartSec));
      }
      videoLink = u.href;
    } catch { /* keep original */ }
    const offsetLine = partInfo && typeof WLSlotAlgorithm !== 'undefined'
      ? `Watch ${WLSlotAlgorithm.formatVideoOffsetRange(partInfo.videoOffsetStartSec, partInfo.videoOffsetEndSec)} of "${enTitle}" · Session ${partInfo.sessionIndex} of ${partInfo.sessionCount}`
      : null;
    let n = 1;
    const lines = [`${n++}) Video Link : ${videoLink}`];
    if (offsetLine) lines.push(`${n++}) ${offsetLine}`);
    lines.push(`${n++}) YT Channel : ${channelName}`);
    if (about) lines.push(`${n++}) About : ${about.slice(0, 800)}`);
    lines.push(`<b> Scheduled with Watch Later Extension </b>`);
    const event = {
    summary,
    description: lines.join('\n'),
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
  closeMultiSessionWhySheet();

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
        showToast('Still offline… please check your connection', 'info');
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

    const flags = await migrateOnboardingFlags();
    const tab = await getActiveInjectableTab().catch(() => null);
    const onWatch = isYouTubeWatchUrl(tab?.url);

    if (!flags[ONB_FLAG_COMPLETE]) {
      // New user first time: watch → Pain→…→Schedule; wrong URL → same then wrongURLwrongURL
      showOnboarding({ wrongUrl: !onWatch });
    } else if (!onWatch) {
      // Returning logged-out on non-watch: same gate UI (no schedule cache yet)
      showNewUserWrongUrl();
    } else {
      // Returning logged-out + watch URL → Connecting → OAuth → Schedule
      await showReturningConnecting();
    }

    // **hide logged-in only controls** in logged-out state
    document.getElementById('scheduleBtn').style.display = 'none';
    document.getElementById('streakProgress')?.classList.add('hidden');

    // 👍👎 in logged-out state prompt login
    document.getElementById('thumbUpBtn')?.addEventListener('click', () => {
      showToast('Login first', 'info');
    });
    document.getElementById('thumbDownBtn')?.addEventListener('click', () => {
      showToast('Login first', 'info');
    });
    document.querySelector('.theme-toggle')?.addEventListener('click', () => {
     showToast('Login first', 'info');
    });

    return;
  }

  // Preview: mock tokens → paint schedule with dummy data (no Supabase/Calendar).
  if (window.__WL_PREVIEW__) {
    paintPreviewSchedule();
    return;
  }

  // Tokens present but calendar never finished scanning (mid-scan close / post-logout) → Connecting
  {
    const { userId } = await storageGet(['userId']);
    const flags = await migrateOnboardingFlags(userId);
    if (!flags[ONB_FLAG_SCANNED]) {
      hideSkeleton();
      document.getElementById('realContent')?.classList.remove('hidden');
      await showReturningConnecting();
      return;
    }
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
    overlay: document.getElementById('overlay'),
    footer: document.getElementById('footer'),
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
    openProfileMenu(window.currentUserId);
  });

document.querySelector('.coffee-btn')?.addEventListener('click', () => {
  window.open('https://watchlaterextension.in/howitworks', '_blank');
});


  el.greeting?.classList.add('hidden');
  if (el.greeting) el.greeting.textContent = '';
  if (el.videoTitle) {
    el.videoTitle.textContent = '';
    delete el.videoTitle.dataset.fullTitle;
  }
  el.feedback?.classList.add('hidden');
  el.footer?.classList.add('hidden');
  if (el.scheduleBtn) el.scheduleBtn.style.display = 'none';
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


  if (!supabase_token || !supabase_refresh) {
    bailInitPopupSkeleton();
    return;
  }

  // setSession auto-refreshes when the access token is expired; if it does,
  // the refresh token rotates, so ALWAYS persist what comes back (inside lock).
  const { error: sessErr } = await restoreSupabaseSession(
    supabase_token,
    supabase_refresh
  );
  if (sessErr) {
    console.error('Session restore failed, trying silent Google re-login', sessErr);
    // Refresh-token chain is broken (rotation race / revocation). Before making the
    // user click login, try a silent OAuth round-trip — no UI if they're still
    // signed in to Google.
    const recovered = await runGoogleOAuthFlow({ silent: true });
    if (recovered?.success) return initPopup();

    // Session expired / revoked — clear tokens and reconnect (not full onboarding).
    // Logout is the path that clears onboardingComplete and starts Pain/Promise.
    await storageRemove([
      'supabase_token',
      'supabase_refresh',
      'google_access_token',
      'userId',
      ONB_FLAG_SCANNED
    ]);
    hideSkeleton();
    document.getElementById('realContent')?.classList.remove('hidden');
    bindThemeToggle();
    document.getElementById('scheduleBtn').style.display = 'none';
    document.getElementById('streakProgress')?.classList.add('hidden');
    await showReturningConnecting();
    return;
  }

  const { data: { user: authUser }, error: userErr } = await supabaseClient.auth.getUser();

  // ── 1) Only proceed if login actually succeeded ──
  if (userErr || !authUser) {
    bailInitPopupSkeleton();
    return;
  }

  currentAuthUser = authUser;
  window.currentUserId = authUser.id;

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

  el.greeting?.classList.add('hidden');
  // footer / streak aren't part of the v2 schedule screen
  el.footer?.classList.add('hidden');
  el.feedback?.classList.remove('hidden');

  initStreak(authUser.id);
  if (el.scheduleBtn) el.scheduleBtn.style.display = 'flex'; // onb-btn uses flex
  // streak + old slot row stay hidden — not in the v2 schedule screen
  el.streakProgress?.classList.add('hidden');
  el.slotSelectorRow?.classList.add('hidden');
  el.themeToggle = document.querySelector('.theme-toggle');

  // Google photo comes straight off the ID token — no extra fetch, no DB read.
  setUserAvatar(authUser.user_metadata?.avatar_url || authUser.user_metadata?.picture);
  profileState.name = userRow?.name || authUser.user_metadata?.name || '';

  wireSchedPrefs(authUser.id);

  // 0) Make sure our token is still valid (and re-auth if needed)
  const valid = await ensureValidGoogleToken();
  if (!valid) {
    await showReturningConnecting();
    return;
  }
  const { google_access_token } = await new Promise(res =>
    chrome.storage.local.get("google_access_token", res)
  );

if (el.videoTitle) {
  el.videoTitle.textContent = 'Loading video…';
  delete el.videoTitle.dataset.fullTitle;
}

  const activeTab = await getActiveInjectableTab().catch(() => null);
  cachedVideoUrl = activeTab?.url || '';
  const onWatch = isYouTubeWatchUrl(cachedVideoUrl);
  if (!onWatch) {
    // Logged-in + wrong URL → Figma 444:7885 (grid + browser mock + modal), not schedule snapshot
    hideSkeleton();
    document.getElementById('realContent')?.classList.remove('hidden');
    showWrongUrlFallAnim();
    return;
  }
  if (!(await ensureWatchUrlGate({ intent: 'schedule' }))) {
    hideSkeleton();
    document.getElementById('realContent')?.classList.remove('hidden');
    return;
  }

  const videoDuration = await getVideoDurationInMinutes() || 10;
  const config = await loadSlotAlgoConfig();
  const isMulti = typeof WLSlotAlgorithm !== 'undefined' &&
    WLSlotAlgorithm.computeSessionPlan(videoDuration, config);

  if (isMulti) {
    paintScheduleMultiSkeleton(isMulti.sessionCount);
    showSkeleton('schedule-multi');
    setScheduleMode('multi');
    await loadMultiSessionSchedule(authUser.id, google_access_token, videoDuration);
    availableSlots = [];
    selectedSlotData = null;
  } else {
    setScheduleMode('single');
    multiSessionState = { plan: null, assigned: [], complete: false, loading: false };
    const originalSlots = await fetchAvailableCalendarSlots(
      authUser.id,
      google_access_token,
      videoDuration
    );
    availableSlots = originalSlots;
    populateDropdown(availableSlots);
  }

  const thumbEl = document.getElementById('videoThumb');
  const bgEl = document.getElementById('schedBgImg');
  const durEl = document.getElementById('videoDuration');

  if (getYouTubeThumbnail(cachedVideoUrl)) {
    setYouTubeThumbnail([thumbEl, bgEl], cachedVideoUrl);
  }

  const durationSec = await getVideoDurationSeconds();
  if (durEl) durEl.textContent = formatDurationLabel(durationSec);

  const title = await getVideoTitle();
  cachedVideoTitle = await translateToEnglish(title?.replace(/^\(\d+\)\s*/, '') || 'Untitled');

  const duration = Math.ceil((durationSec || 0) / 60);
  setSchedVideoTitle(cachedVideoTitle);
  if (!isMulti) el.scheduleBtn.disabled = false;
  hideWrongUrlPanel();
  saveLastScheduleSnapshot();

el.scheduleBtn.onclick = async () => {
  recordButtonClick('Schedule to Google Calendar');
  if (!selectedSlotData) return;

  el.scheduleBtn.disabled   = true;
  setScheduleBtnLabel('Checking for ads…');

  // 2) Get the active tab ID once — skip chrome:// / edge://
  const activeTab = await getActiveInjectableTab();
  if (!activeTab) {
    showToast('Open a YouTube video to schedule.', 'info');
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
    showToast('Please wait until the ad finishes before scheduling.', 'info');
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
    showToast('This video is already scheduled', 'info');
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
      showFeedback('Failed to re-authenticate with Google.', 'error');
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
    showScheduleFailModal({
      title: cachedVideoTitle,
      start: selectedSlotData.start,
      end: selectedSlotData.end
    });
  }

  // Re-enable button
  el.scheduleBtn.disabled = false;
  setScheduleBtnLabel('Schedule to Google Calendar');
};

 el.thumbUp?.addEventListener("click", async () => {
   if (!cachedVideoUrl) {
     return showToast('Could not record feedback (no video URL)', 'error');
   }
   // 1) disable the footer UI
   el.footer.style.pointerEvents = 'none';
   el.footer.style.opacity      = '0.6';

   try {
     // 2) submit feedback
     await supabaseClient.from("feedback")
       .insert([{ user_id: authUser.id, type: "like", video_url: cachedVideoUrl }]);
     showToast('Thanks for your feedback!', 'success');
   } catch (err) {
     console.error("Feedback error:", err);
     showToast('Could not send feedback', 'error');
   } finally {
     // 3) re-enable the footer UI
     el.footer.style.pointerEvents = '';
     el.footer.style.opacity      = '';
   }
 });

 el.thumbDown?.addEventListener("click", async () => {
   if (!cachedVideoUrl) {
     return showToast('Could not record feedback (no video URL)', 'error');
   }
   el.footer.style.pointerEvents = 'none';
   el.footer.style.opacity      = '0.6';

   try {
     await supabaseClient.from("feedback")
       .insert([{ user_id: authUser.id, type: "hate", video_url: cachedVideoUrl }]);
     showToast('Thanks for your feedback!', 'success');
   } catch (err) {
     console.error("Feedback error:", err);
     showToast('Could not send feedback', 'error');
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

/** Figma 541:15067 — `06:16 PM - 07:17 PM • Friday • 22/07` */
function formatSuccessSlotLabel(startIso, endIso) {
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return '';
  const tf = { hour: '2-digit', minute: '2-digit', hour12: true };
  const startT = s.toLocaleTimeString('en-US', tf);
  const endT = e.toLocaleTimeString('en-US', tf);
  const weekday = s.toLocaleDateString('en-US', { weekday: 'long' });
  const dd = String(s.getDate()).padStart(2, '0');
  const mm = String(s.getMonth() + 1).padStart(2, '0');
  return `${startT} - ${endT} • ${weekday} • ${dd}/${mm}`;
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
  return document.getElementById('popupWrapper') || document.getElementById('scheduleScreen');
}

function mountSuccessOverlay() {
  const overlay = document.getElementById('successOverlay');
  const host = successMountParent();
  if (!overlay || !host) return overlay;
  if (overlay.parentElement !== host) host.appendChild(overlay);
  return overlay;
}

/** Must match --success-enter-ms (outcome sheet slide; slower than shared --sheet-slide-ms). */
const SUCCESS_ENTER_MS = 550;
const SUCCESS_SLIDE_MS = SUCCESS_ENTER_MS;
/** Must match --success-copy-ms / --success-copy-stagger / --success-card-ms / --success-star-ms. */
const SUCCESS_COPY_MS = 550;
const SUCCESS_COPY_STAGGER_MS = 200;
const SUCCESS_CARD_MS = 650;
const SUCCESS_CARD_TEXT_MS = 450;
const SUCCESS_STAR_MS = 650;

function closeScheduleSuccessModal() {
  const overlay = document.getElementById('successOverlay');
  if (!overlay || overlay.hidden) return;
  overlay.setAttribute('aria-hidden', 'true');
  clearTimeout(overlay._hideTimer);
  overlay.classList.add('is-closing');
  overlay._hideTimer = setTimeout(() => {
    overlay.classList.remove('is-open', 'is-closing');
    overlay.classList.add('hidden');
    overlay.hidden = true;
  }, SUCCESS_SLIDE_MS);
}

function wireSuccessOverlayOnce() {
  if (wireSuccessOverlayOnce._wired) return;
  wireSuccessOverlayOnce._wired = true;
  document.getElementById('successGoBackBtn')?.addEventListener('click', () => {
    closeScheduleSuccessModal();
  });
  document.getElementById('successViewPlaylistBtn')?.addEventListener('click', () => {
    closeScheduleSuccessModal();
    setTimeout(
      () => openHistoryModal(window.currentUserId || historyState.userId || 'preview-user'),
      SUCCESS_SLIDE_MS
    );
  });
  document.getElementById('successBackdrop')?.addEventListener('click', () => {
    closeScheduleSuccessModal();
  });
}

function openOutcomeOverlay(overlay) {
  clearTimeout(overlay._hideTimer);
  overlay.hidden = false;
  overlay.classList.remove('hidden', 'is-closing', 'is-open');
  void overlay.offsetWidth;
  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');
}

/**
 * Figma 541:15067 — after a successful Calendar schedule.
 * Sheet slides up; cards rotate 0→±2° while copy/stars cascade in.
 */
function showScheduleSuccessModal({ title, start, end } = {}) {
  wireSuccessOverlayOnce();
  const overlay = mountSuccessOverlay();
  const panel = document.getElementById('successPanel');
  if (!overlay || !panel) return;

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

  openOutcomeOverlay(overlay);
}

function mountFailOverlay() {
  const overlay = document.getElementById('failOverlay');
  const host = successMountParent();
  if (!overlay || !host) return overlay;
  if (overlay.parentElement !== host) host.appendChild(overlay);
  return overlay;
}

function closeScheduleFailModal() {
  const overlay = document.getElementById('failOverlay');
  if (!overlay || overlay.hidden) return;
  overlay.setAttribute('aria-hidden', 'true');
  clearTimeout(overlay._hideTimer);
  overlay.classList.add('is-closing');
  overlay._hideTimer = setTimeout(() => {
    overlay.classList.remove('is-open', 'is-closing');
    overlay.classList.add('hidden');
    overlay.hidden = true;
  }, SUCCESS_SLIDE_MS);
}

function wireFailOverlayOnce() {
  if (wireFailOverlayOnce._wired) return;
  wireFailOverlayOnce._wired = true;
  document.getElementById('failBackBtn')?.addEventListener('click', () => {
    closeScheduleFailModal();
  });
  document.getElementById('failRetryBtn')?.addEventListener('click', () => {
    closeScheduleFailModal();
    // re-run the same click handler that got us here (ads check, token, dup guard, etc.)
    setTimeout(() => document.getElementById('scheduleBtn')?.click(), SUCCESS_SLIDE_MS);
  });
  document.getElementById('failBackdrop')?.addEventListener('click', () => {
    closeScheduleFailModal();
  });
}

/**
 * Figma 541:15659 — same enter sequence as success (slide + card rotate + copy cascade).
 */
function showScheduleFailModal({ title, start, end } = {}) {
  wireFailOverlayOnce();
  const overlay = mountFailOverlay();
  const panel = document.getElementById('failPanel');
  if (!overlay || !panel) return;

  const t = String(title || cachedVideoTitle || 'Video').trim() || 'Video';
  const ghostTime = formatSuccessGhostTime(start, end);
  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  setText('failCardTitle', t);
  setText('failGhostTitle', t);
  setText('failGhostTime', ghostTime);

  openOutcomeOverlay(overlay);
}

function stopOutcomePreviewLoop() {
  clearTimeout(stopOutcomePreviewLoop._close);
  clearTimeout(stopOutcomePreviewLoop._open);
  stopOutcomePreviewLoop._close = null;
  stopOutcomePreviewLoop._open = null;
}

/** Preview `#preview=1&schedule=1&success=1` (or `&fail=1`) — success then fail on a loop. */
function startOutcomePreviewLoop() {
  stopOutcomePreviewLoop();
  const slot = availableSlots?.[0];
  const payload = {
    title: cachedVideoTitle,
    start: slot?.start || new Date().toISOString(),
    end: slot?.end || new Date(Date.now() + 3600000).toISOString()
  };
  const holdMs =
    SUCCESS_ENTER_MS + SUCCESS_CARD_MS + SUCCESS_CARD_TEXT_MS + SUCCESS_COPY_STAGGER_MS * 2 + SUCCESS_COPY_MS + 1200;
  let next = 'success';
  const play = () => {
    const kind = next;
    next = kind === 'success' ? 'fail' : 'success';
    if (kind === 'fail') showScheduleFailModal(payload);
    else showScheduleSuccessModal(payload);
    stopOutcomePreviewLoop._close = setTimeout(() => {
      if (kind === 'fail') closeScheduleFailModal();
      else closeScheduleSuccessModal();
      stopOutcomePreviewLoop._open = setTimeout(play, SUCCESS_ENTER_MS + 320);
    }, holdMs);
  };
  play();
}

/**
 * Opens the View history playlist overlay (Figma 533:7243).
 */
const HISTORY_PAGE_SIZE = 5;
const historyState = {
  userId: null,
  filter: 'scheduled',
  page: 1,
  items: null,
  counts: { scheduled: 0, watched: 0, forced: 0 },
  wired: false
};

function historyMountParent() {
  // popupWrapper is the fixed 340×486 frame. scheduleScreen can grow with
  // content; mounting there put bottom:8px below the visible overflow clip.
  return document.getElementById('popupWrapper') || document.getElementById('scheduleScreen');
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
  if (!overlay) return;
  closeOverlay(overlay);
  releaseProfileStackAfterSlide();
}

function wireHistoryOverlayOnce() {
  if (historyState.wired) return;
  historyState.wired = true;

  document.getElementById('historyBackBtn')?.addEventListener('click', () => closeHistoryModal());
  document.getElementById('historyCloseBtn')?.addEventListener('click', () => closeHistoryModal());
  document.getElementById('historyBackdrop')?.addEventListener('click', () => closeHistoryModal());

  document.getElementById('historyTabs')?.addEventListener('click', e => {
    const tab = e.target.closest('[data-filter]');
    if (!tab) return;
    const next = tab.dataset.filter;
    if (!next || next === historyState.filter) return;
    historyState.filter = next;
    historyState.page = 1;
    repaintHistoryPageFaded();
  });

  document.getElementById('historyPrevBtn')?.addEventListener('click', () => {
    if (historyState.page <= 1) return;
    historyState.page -= 1;
    repaintHistoryPageFaded();
  });
  document.getElementById('historyNextBtn')?.addEventListener('click', () => {
    historyState.page += 1;
    repaintHistoryPageFaded();
  });
}

function paintHistorySkeleton() {
  const container = document.getElementById('historyList');
  if (!container) return;
  const widths = [86, 72, 90, 64, 78];
  container.classList.remove('is-empty');
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
  if (typeof closeSchedPrefs === 'function') closeSchedPrefs();

  historyState.userId = userId;
  historyState.filter = 'scheduled';
  historyState.page = 1;
  historyState.items = null;

  wireHistoryOverlayOnce();
  const overlay = mountHistoryOverlay();
  if (!overlay) return;

  document.getElementById('scheduleScreen')?.classList.add('is-history-open');
  document.body.classList.add('is-history-open');
  setProfileStackedUnder(true);
  openOverlay(overlay);

  const isPreview = !userId || userId === 'preview-user';
  if (!isPreview) paintHistorySkeleton();

  loadHistoryItems(userId).then(() => {
    document.getElementById('historyList')?.removeAttribute('aria-busy');
    paintHistoryPage();
  });
}

function aggregateHistoryGroup(sessions) {
  const sorted = [...sessions].sort((a, b) => (a.session_index || 0) - (b.session_index || 0));
  const primary = sorted[0];
  const sessionCount = primary.session_count || sorted.length;
  const watchedCount = sorted.filter(s => s.watched).length;
  const allWatched = watchedCount >= sessionCount && sessionCount > 0;
  const anyForced = sorted.some(s => s.forced);
  const anyRemoved = sorted.some(s => s.removed);
  const nextUnwatched = sorted.find(s => !s.watched);
  return {
    ...primary,
    id: primary.session_group_id || primary.id,
    _sessions: sorted,
    _groupId: primary.session_group_id || primary.id,
    session_count: sessionCount,
    watched_count: watchedCount,
    watched: allWatched,
    forced: anyForced,
    removed: anyRemoved,
    start_time: nextUnwatched?.start_time || sorted[sorted.length - 1].start_time,
    end_time: nextUnwatched?.end_time || sorted[sorted.length - 1].end_time,
  };
}

function groupHistoryForDisplay(items) {
  const singles = [];
  const groups = new Map();
  for (const item of items || []) {
    if (!item.session_group_id) {
      singles.push({
        ...item,
        _sessions: [item],
        _groupId: item.id,
        session_count: 1,
        watched_count: item.watched ? 1 : 0,
      });
      continue;
    }
    if (!groups.has(item.session_group_id)) groups.set(item.session_group_id, []);
    groups.get(item.session_group_id).push(item);
  }
  const out = [...singles];
  for (const sessions of groups.values()) out.push(aggregateHistoryGroup(sessions));
  return out;
}

async function markGroupForced(sessionGroupId) {
  if (!sessionGroupId || historyState.userId === 'preview-user') return;
  await supabaseClient.from('videohistory').update({ forced: true }).eq('session_group_id', sessionGroupId);
}

async function recomputeAllSessionsWatched(sessionGroupId) {
  if (!sessionGroupId || historyState.userId === 'preview-user') return;
  const { data } = await supabaseClient
    .from('videohistory')
    .select('watched_at')
    .eq('session_group_id', sessionGroupId);
  const allDone = data?.length && data.every(r => r.watched_at);
  await supabaseClient
    .from('videohistory')
    .update({ all_sessions_watched: !!allDone, watched: !!allDone })
    .eq('session_group_id', sessionGroupId);
}

function formatHistorySessionProgress(item) {
  const total = item.session_count || 1;
  const watched = item.watched_count ?? 0;
  if (total <= 1) return null;
  return `${watched} of ${total} sessions watched`;
}

function splitHistoryLists(items) {
  const grouped = groupHistoryForDisplay(items);
  const scheduled = grouped.filter(i => !i.watched && !i.forced);
  const watched = grouped.filter(i => i.watched && !i.forced);
  const forced = grouped.filter(i => i.forced);
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
    .select('id,title,video_url,start_time,end_time,watched,watched_at,created_at,google_event_id,forced,removed,session_group_id,session_index,session_count,video_offset_start_sec,video_offset_end_sec,all_sessions_watched')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Failed to load history:', error.message, error.details);
    showToast(`Could not load history: ${error.message}`, 'error');
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
          if (item.session_group_id) await markGroupForced(item.session_group_id);
        }
      } catch {
        await supabaseClient.from('videohistory').update({ forced: true }).eq('id', item.id);
        item.forced = true;
        if (item.session_group_id) await markGroupForced(item.session_group_id);
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
        // Video is still up but the channel renamed it — surface as forced (drift bucket),
        // same as a calendar time change, rather than a separate "renamed" state. A JSON
        // parse hiccup here must not fall through to the removed/forced catch below.
        if (!item.forced) {
          try {
            const meta = await r.json();
            if (meta && typeof meta.title === 'string') {
              // Compare English forms so HI/MR titles stored as EN don't false-flag as renamed.
              const liveEn = await translateToEnglish(meta.title);
              const storedEn = await translateToEnglish(item.title);
              if (liveEn !== storedEn) {
                await supabaseClient.from('videohistory').update({ forced: true }).eq('id', item.id);
                item.forced = true;
                if (item.session_group_id) await markGroupForced(item.session_group_id);
              }
            }
          } catch {}
        }
      } catch {
        await supabaseClient
          .from('videohistory')
          .update({ removed: true, forced: true })
          .eq('id', item.id);
        item.removed = true;
        item.forced = true;
        if (item.session_group_id) await markGroupForced(item.session_group_id);
      }
    })
  );

  historyState.items = visibleItems;
  const forcedGroups = new Set(
    visibleItems.filter(i => i.forced && i.session_group_id).map(i => i.session_group_id)
  );
  for (const item of visibleItems) {
    if (item.session_group_id && forcedGroups.has(item.session_group_id)) item.forced = true;
  }
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
    // p5/p6 sit in the previous 30-day window so the profile menu trend banner
    // has something to compare against in preview.
    { id: 'p5', title: 'Wildlife Wonders: Secrets of the Jungle | 6K Nature', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', start_time: h(-12 * 86400000), end_time: h(-12 * 86400000 + 3600000), created_at: h(-45 * 86400000), watched: false, forced: false, removed: false },
    { id: 'p6', title: 'Mountain Light: Alpine Sunrise Timelapse', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', start_time: h(-40 * 86400000), end_time: h(-40 * 86400000 + 3600000), created_at: h(-50 * 86400000), watched: true, watched_at: h(-45 * 86400000), forced: false, removed: false },
    { id: 'p7', title: 'City Rain: Night Streets Ambience', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', start_time: h(-3 * 86400000), end_time: h(-3 * 86400000 + 3600000), created_at: h(-7000), watched: true, watched_at: h(-120000), forced: false, removed: false },
    { id: 'p8', title: 'Calendar Drift Demo Video', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', start_time: h(86400000), end_time: h(86400000 + 3600000), created_at: h(-8000), watched: false, forced: true, removed: false, google_event_id: 'preview' },
    { id: 'p9', title: 'Forest Canopy: Soft Wind Ambience 4K', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', start_time: h(7 * 86400000), end_time: h(7 * 86400000 + 3600000), created_at: h(-9000), watched: false, forced: false, removed: false },
    { id: 'p10', title: 'Desert Night: Stars Over Dunes', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', start_time: h(10 * 86400000), end_time: h(10 * 86400000 + 3600000), created_at: h(-10000), watched: false, forced: false, removed: false }
  ];
}

function updateHistoryTabLabels() {
  const { scheduled, watched, forced } = historyState.counts;
  const labels = {
    scheduled: `Scheduled (${scheduled})`,
    watched: `Watched (${watched})`,
    forced: `Forced (${forced})`
  };
  document.querySelectorAll('#historyTabs [data-filter]').forEach(btn => {
    const key = btn.dataset.filter;
    btn.textContent = labels[key] || btn.textContent;
    const active = key === historyState.filter;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

/**
 * Repaint the list behind a cross-fade, for swaps the user asked for (page
 * turn, tab change) rather than ones they type. Must match the
 * `.history-list` opacity transition in style.css.
 */
const HISTORY_SWAP_MS = 160;
function repaintHistoryPageFaded() {
  const container = document.getElementById('historyList');
  if (!container) return paintHistoryPage();
  container.classList.add('is-swapping');
  setTimeout(() => {
    paintHistoryPage();
    container.classList.remove('is-swapping');
  }, HISTORY_SWAP_MS);
}

async function paintHistoryPage() {
  const container = document.getElementById('historyList');
  if (!container) return;

  updateHistoryTabLabels();

  const filtered = activeHistoryList();
  const page = paginateList(filtered, historyState.page, HISTORY_PAGE_SIZE);
  historyState.page = page.page;

  const pagerRow = document.querySelector('.history-pager');
  if (pagerRow) pagerRow.hidden = !page.total; // nothing to page through on an empty tab
  const pager = document.getElementById('historyPagerLabel');
  if (pager) {
    pager.textContent =
      `${page.start}-${page.end} of ${page.total} rows | Page ${page.page} of ${page.pages}`;
  }
  const prev = document.getElementById('historyPrevBtn');
  const next = document.getElementById('historyNextBtn');
  if (prev) prev.disabled = page.page <= 1;
  if (next) next.disabled = page.page >= page.pages;

  if (!page.total) {
    container.classList.add('is-empty');
    const copy = {
      scheduled: { heading: 'No scheduled videos here', sub: 'Schedule your first video to view it here' },
      watched: { heading: 'No videos marked as watched', sub: 'Videos marked as watched are moved here' },
      forced: {
        heading: 'No forced videos here',
        sub: 'Videos whose calendar time changed, were renamed, or were removed, land here'
      }
    }[historyState.filter] || { heading: 'No videos', sub: '' };
    container.innerHTML = `
      <div class="history-empty">
        <div class="history-empty-art" aria-hidden="true">
          <div class="history-empty-thumb"></div>
          <div class="history-empty-lines">
            <div class="history-empty-line"></div>
            <div class="history-empty-line"></div>
            <div class="history-empty-line history-empty-line--short"></div>
          </div>
        </div>
        <div class="history-empty-copy">
          <p class="history-empty-heading">${escapeHistoryHtml(copy.heading)}</p>
          <p class="history-empty-sub">${escapeHistoryHtml(copy.sub)}</p>
        </div>
      </div>`;
    return;
  }

  container.classList.remove('is-empty');
  container.innerHTML = '';
  const now = new Date();
  const displayTitles = await Promise.all(
    page.items.map(item => translateToEnglish(item.title || ''))
  );
  page.items.forEach((item, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'history-row-wrap';
    const localized = { ...item, title: displayTitles[idx] || item.title };
    wrap.appendChild(buildHistoryRow(localized, historyState.filter, now));
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

// Escaping stops an href breaking out of its attribute but not a javascript:
// or data: payload firing on click, and the popup is a privileged page.
function safeExternalUrl(url) {
  try {
    const u = new URL(String(url ?? ''));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '#';
  } catch {
    return '#';
  }
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
    const progress = formatHistorySessionProgress(item);
    const base = formatHistoryScheduledFor(item.start_time, now);
    subtitleHtml = `<div class="history-row-sub">${escapeHistoryHtml(progress ? `${progress} · ${base}` : base)}</div>`;
  } else {
    const progress = formatHistorySessionProgress(item);
    const missed = formatHistoryMissedLabel(item.end_time, now);
    const upcoming = !missed && formatHistoryUpcomingLabel(item.start_time, now);
    const scheduled = formatHistoryScheduledFor(item.start_time, now);
    if (missed) {
      subtitleHtml = `<div class="history-row-sub">${escapeHistoryHtml(progress ? `${progress} · ${missed}` : missed)}</div>`;
    } else if (upcoming) {
      const line1 = progress ? `${progress} · ${scheduled}` : scheduled;
      subtitleHtml = `
        <div class="history-row-sub history-row-sub--swap" aria-label="${escapeHistoryHtml(upcoming)}">
          <div class="history-sub-track">
            <div class="history-sub-line">${escapeHistoryHtml(line1)}</div>
            <div class="history-sub-line">${escapeHistoryHtml(upcoming)}</div>
          </div>
        </div>`;
    } else {
      subtitleHtml = `<div class="history-row-sub">${escapeHistoryHtml(progress ? `${progress} · ${scheduled}` : scheduled)}</div>`;
    }
  }

  const showWatch = filter === 'scheduled' && !item.removed;
  const showReschedule = filter === 'forced' && !item.removed;
  const href = item.removed ? '#' : escapeHistoryHtml(safeExternalUrl(item.video_url));
  const actions = `
    <div class="history-row-actions">
      ${showReschedule ? `
        <button type="button" class="onb-btn onb-btn-secondary icon-only history-row-action" data-action="reschedule" title="Reschedule" aria-label="Reschedule">
          <span class="onb-btn-inner">
            <img src="Icon/menu-icon-clock.svg" width="18" height="18" alt="" />
          </span>
        </button>` : ''}
      ${showWatch ? `
        <button type="button" class="onb-btn icon-only history-row-action" data-action="watch" title="Mark as Watched" aria-label="Mark as Watched">
          <span class="onb-btn-inner">
            <img src="Icon/history-icon-check.svg" width="18" height="18" alt="" />
          </span>
        </button>` : ''}
      <button type="button" class="onb-btn onb-btn-secondary icon-only history-row-action" data-action="delete" title="Delete" aria-label="Delete">
        <span class="onb-btn-inner">
          <img src="Icon/history-icon-trash.svg" width="18" height="18" alt="" />
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
  row.querySelector('[data-action="reschedule"]')?.addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    await rescheduleHistoryGroup(item);
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

function syncGroupItemFromSessions(item, sessions) {
  const sessionCount = item.session_count || sessions.length;
  const watchedCount = sessions.filter(s => s.watched).length;
  item.watched_count = watchedCount;
  item.watched = watchedCount >= sessionCount && sessionCount > 0;
  item._sessions = sessions;
}

async function markOneSessionWatched(sessionRow, groupItem) {
  const watched_at = new Date().toISOString();
  if (historyState.userId === 'preview-user') {
    sessionRow.watched = true;
    sessionRow.watched_at = watched_at;
  } else {
    const { error } = await supabaseClient
      .from('videohistory')
      .update({ watched: true, watched_at })
      .eq('id', sessionRow.id);
    if (error) throw error;
    sessionRow.watched = true;
    sessionRow.watched_at = watched_at;
    if (groupItem.session_group_id) await recomputeAllSessionsWatched(groupItem.session_group_id);
  }
}

const markWatchedState = { pending: null, wired: false };

function closeMarkWatchedConfirm() {
  markWatchedState.pending = null;
  const overlay = document.getElementById('markWatchedConfirmOverlay');
  if (overlay) closeOverlay(overlay);
}

function wireMarkWatchedConfirmOnce() {
  if (markWatchedState.wired) return;
  markWatchedState.wired = true;
  document.getElementById('markWatchedCancelBtn')?.addEventListener('click', closeMarkWatchedConfirm);
  document.getElementById('markWatchedBackdrop')?.addEventListener('click', closeMarkWatchedConfirm);
  document.getElementById('markWatchedConfirmBtn')?.addEventListener('click', async () => {
    const pending = markWatchedState.pending;
    closeMarkWatchedConfirm();
    if (pending) await confirmMarkAllSessionsWatched(pending.item, pending.row);
  });
}

function openMarkWatchedConfirm(item, row) {
  const overlay = mountOverlay('markWatchedConfirmOverlay');
  if (!overlay) return confirmMarkAllSessionsWatched(item, row);
  markWatchedState.pending = { item, row };
  const title = document.getElementById('markWatchedVideoTitle');
  const chip = document.getElementById('markWatchedPartChip');
  if (title) title.textContent = item.title || 'This video';
  if (chip) chip.textContent = `${item.session_count || 1} parts`;
  wireMarkWatchedConfirmOnce();
  openOverlay(overlay);
}

async function confirmMarkAllSessionsWatched(item, row) {
  const sessions = item._sessions || [item];
  const unwatched = sessions.filter(s => !s.watched);
  try {
    for (const s of unwatched) await markOneSessionWatched(s, item);
  } catch (e) {
    console.error(e);
    return showToast('Could not mark as watched', 'error');
  }
  syncGroupItemFromSessions(item, sessions);
  if (row) await animateHistoryRowOut(row);
  refreshHistoryCounts();
  showToast('Moved to Watched', 'success');
  paintHistoryPage();
}

async function markHistoryWatched(item, row) {
  const sessions = item._sessions || [item];
  const unwatched = sessions.filter(s => !s.watched);
  if (!unwatched.length) return;

  const sessionCount = item.session_count || 1;
  if (sessionCount > 1) {
    return openMarkWatchedConfirm(item, row);
  }

  try {
    await markOneSessionWatched(unwatched[0], item);
  } catch (e) {
    console.error(e);
    return showToast('Could not mark as watched', 'error');
  }

  syncGroupItemFromSessions(item, sessions);
  refreshHistoryCounts();
  if (item.watched) {
    if (row) await animateHistoryRowOut(row);
    showToast('Moved to Watched', 'success');
  } else {
    showToast(`Session ${unwatched[0].session_index || 1} marked as watched`, 'success');
  }
  paintHistoryPage();
}

async function rescheduleHistoryGroup(item) {
  const sessions = item._sessions || [item];
  const unwatched = sessions.filter(s => !s.watched);
  if (!unwatched.length) return;

  if (historyState.userId === 'preview-user') {
    showToast('Rescheduled sessions (preview)', 'success');
    return paintHistoryPage();
  }

  const valid = await ensureValidGoogleToken();
  if (!valid) return;

  const totalVideoMin = Math.ceil(
    Math.max(...sessions.map(s => Number(s.video_offset_end_sec) || 0)) / 60
  );
  const config = await loadSlotAlgoConfig();
  const algo = typeof WLSlotAlgorithm !== 'undefined' ? WLSlotAlgorithm : null;
  if (!algo) return;

  const fullPlan = algo.computeSessionPlan(totalVideoMin, config);
  if (!fullPlan) return showToast('Could not build session plan', 'error');

  const watchedIndexes = new Set(sessions.filter(s => s.watched).map(s => s.session_index));
  const partialPlan = {
    ...fullPlan,
    sessions: fullPlan.sessions.filter(s => !watchedIndexes.has(s.sessionIndex)),
  };

  const { google_access_token } = await new Promise(r =>
    chrome.storage.local.get('google_access_token', r)
  );

  let result;
  try {
    result = await fetchMultiSessionSlots(
      historyState.userId,
      google_access_token,
      partialPlan
    );
  } catch (err) {
    console.error('Reschedule slot fetch failed:', err);
    return showToast('Could not find new session slots', 'error');
  }

  if (!result.complete) {
    return showToast(
      `We found ${result.sessions.length} of ${partialPlan.sessions.length} sessions. Widen preferences or try again.`,
      'info'
    );
  }

  for (const entry of result.sessions) {
    const dbRow = unwatched.find(u => u.session_index === entry.sessionIndex);
    if (!dbRow) continue;

    if (dbRow.google_event_id) {
      const token = (await chrome.storage.local.get('google_access_token')).google_access_token;
      await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(dbRow.google_event_id)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
      );
    }

    const partInfo = {
      sessionIndex: entry.sessionIndex,
      sessionCount: entry.sessionCount,
      videoOffsetStartSec: entry.videoOffsetStartSec,
      videoOffsetEndSec: entry.videoOffsetEndSec,
    };
    let scheduleResult = await tryScheduleEventOnce(
      google_access_token,
      entry.slot,
      dbRow.title,
      { id: historyState.userId },
      dbRow.video_url,
      partInfo
    );
    if (!scheduleResult.success) {
      return showToast('Could not reschedule calendar events', 'error');
    }

    await supabaseClient.from('videohistory').update({
      start_time: entry.slot.start,
      end_time: entry.slot.end,
      google_event_id: scheduleResult.eventId,
      forced: false,
    }).eq('id', dbRow.id);

    dbRow.start_time = entry.slot.start;
    dbRow.end_time = entry.slot.end;
    dbRow.google_event_id = scheduleResult.eventId;
    dbRow.forced = false;
  }

  if (item.session_group_id) {
    await supabaseClient
      .from('videohistory')
      .update({ forced: false })
      .eq('session_group_id', item.session_group_id);
    sessions.forEach(s => { s.forced = false; });
  }

  item.forced = false;
  refreshHistoryCounts();
  showToast('Sessions rescheduled', 'success');
  paintHistoryPage();
}

/* ─── Delete confirm · 116:5060 ───────────────────────────────────────────── */

const deleteState = { pending: null, wired: false };

function closeDeleteConfirm() {
  deleteState.pending = null;
  const overlay = document.getElementById('deleteConfirmOverlay');
  if (overlay) closeOverlay(overlay);
}

function wireDeleteConfirmOnce() {
  if (deleteState.wired) return;
  deleteState.wired = true;
  document.getElementById('deleteCancelBtn')?.addEventListener('click', closeDeleteConfirm);
  document.getElementById('deleteBackdrop')?.addEventListener('click', closeDeleteConfirm);
  document.getElementById('deleteConfirmBtn')?.addEventListener('click', () => {
    const pending = deleteState.pending;
    closeDeleteConfirm();
    if (pending) performHistoryDelete(pending.item, pending.row);
  });
}

/** Every trash button in the playlist routes through here first. */
function deleteHistoryItem(item, row) {
  const overlay = mountOverlay('deleteConfirmOverlay');
  if (!overlay) return performHistoryDelete(item, row);
  deleteState.pending = { item, row };
  const n = item.session_count || (item._sessions?.length) || 1;
  const isMulti = n > 1;
  const title = document.getElementById('deleteVideoTitle');
  if (title) title.textContent = item.title || 'This video';
  const singleHeading = document.getElementById('deleteSingleHeading');
  const multiHeading = document.getElementById('deleteMultiHeading');
  const chip = document.getElementById('deletePartChip');
  const body = document.getElementById('deleteBody');
  if (singleHeading) {
    singleHeading.hidden = isMulti;
    singleHeading.setAttribute('aria-hidden', isMulti ? 'true' : 'false');
  }
  if (multiHeading) {
    multiHeading.hidden = !isMulti;
    multiHeading.setAttribute('aria-hidden', isMulti ? 'false' : 'true');
  }
  if (chip) chip.textContent = `${n} parts`;
  if (body) {
    body.hidden = isMulti;
    if (!isMulti) {
      body.textContent = "This can't be undone — it'll be removed from your calendar and playlist.";
    }
  }
  const panel = overlay.querySelector('.delete-panel');
  if (panel) panel.setAttribute('aria-labelledby', isMulti ? 'deleteMultiHeading' : 'deleteDialogLabel');
  if (panel) panel.setAttribute('aria-describedby', isMulti ? '' : 'deleteBody');
  wireDeleteConfirmOnce();
  openOverlay(overlay);
}

async function performHistoryDelete(item, row) {
  const sessions = item._sessions || [item];
  const removeIds = new Set(sessions.map(s => s.id));

  if (historyState.userId === 'preview-user') {
    if (row) await animateHistoryRowOut(row);
    historyState.items = (historyState.items || []).filter(i => !removeIds.has(i.id));
    showToast('Video Removed', 'success');
  } else {
    for (const s of sessions) {
      let removed = false;
      await handleRemove(s, { remove() { removed = true; } });
      if (!removed) return;
    }
    if (row) await animateHistoryRowOut(row);
    historyState.items = (historyState.items || []).filter(i => !removeIds.has(i.id));
    showToast('Video Removed', 'success');
  }
  refreshHistoryCounts();
  paintHistoryPage();
}


/* ─── Profile menu · 218:1834 (new user) / 116:4508 (returning) ───────────── */

/**
 * Badge copy keyed by each SLOT_RANGES bucket's START HOUR, not its label —
 * the labels carry en dashes, so a hand-typed copy of them silently misses.
 */
const SLOT_PERSONAS = {
  6: 'Early Bird',
  9: 'Day Starter',
  12: 'Lunch Breaker',
  15: 'Tea Timer',
  18: 'Sundowner',
  21: 'Prime Timer',
  0: 'Night Owl',
};
const TREND_WINDOW_DAYS = 7; // rolling week vs the week before, not a month
const profileState = { name: '', wired: false };

function slotBucketStart(hour) {
  const key = Object.keys(SLOT_RANGES).find(name => {
    const [start, end] = SLOT_RANGES[name];
    return hour >= start && hour < end;
  });
  return key ? SLOT_RANGES[key][0] : null;
}

/** Bucket most of their videos land in; saved time prefs cover a fresh account. */
function personaFor(rows, selectedTimes) {
  const tally = {};
  (rows || []).forEach(row => {
    const start = row.start_time && slotBucketStart(new Date(row.start_time).getHours());
    if (start !== null && start !== undefined && start !== false) {
      tally[start] = (tally[start] || 0) + 1;
    }
  });
  const best = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0]
    ?? (selectedTimes || []).map(time => SLOT_RANGES[time]?.[0]).find(h => h != null);
  return best == null ? '' : SLOT_PERSONAS[best] || '';
}

/**
 * Completion rate (watched ÷ scheduled) over the last 7 days vs the 7 before.
 * Null unless BOTH windows have videos — a first week otherwise reads as a
 * 100% swing off one video. Zero delta is hidden (no "0% increase").
 */
function completionTrend(rows, now = Date.now()) {
  const day = 86400000;
  const rateBetween = (from, to) => {
    const window = (rows || []).filter(row => {
      const at = new Date(row.created_at).getTime();
      return at >= from && at < to;
    });
    return window.length ? window.filter(row => row.watched).length / window.length : null;
  };
  const recent = rateBetween(now - TREND_WINDOW_DAYS * day, now);
  const prior = rateBetween(now - 2 * TREND_WINDOW_DAYS * day, now - TREND_WINDOW_DAYS * day);
  if (recent === null || prior === null) return null;
  const delta = Math.round((recent - prior) * 100);
  return delta === 0 ? null : { delta: Math.abs(delta), up: delta > 0 };
}

function mountOverlay(id) {
  const overlay = document.getElementById(id);
  const host = historyMountParent();
  if (overlay && host && overlay.parentElement !== host) host.appendChild(overlay);
  return overlay;
}

function setUserAvatar(url) {
  if (!url) return;
  ['navAvatar', 'profileAvatar'].forEach(id => {
    const img = document.getElementById(id);
    if (!img) return;
    // A dead Google photo URL would otherwise leave a broken-image button.
    img.onerror = () => { img.onerror = null; img.src = 'Icon/avatar-fallback-koala.png'; };
    img.src = url;
  });
}

async function fetchProfileRows(userId) {
  if (!userId || userId === 'preview-user') {
    return (getPreviewHistoryItems() || []).map(item => ({
      start_time: item.start_time,
      created_at: item.created_at,
      watched: !!item.watched
    }));
  }
  const { data, error } = await supabaseClient
    .from('videohistory')
    .select('start_time,created_at,watched')
    .eq('user_id', userId);
  if (error) {
    console.error('Profile stats load failed:', error.message);
    return [];
  }
  return data || [];
}

async function paintProfileMenu(userId) {
  const panel = document.getElementById('profilePanel');
  if (!panel) return;

  const version = chrome.runtime?.getManifest?.()?.version;
  const versionEl = document.getElementById('profileVersion');
  if (versionEl) {
    versionEl.textContent = version ? `V ${version}` : '';
    versionEl.hidden = !version;
  }

  const firstName = (profileState.name || '').trim().split(/\s+/)[0];
  const nameEl = document.getElementById('profileName');
  if (nameEl) nameEl.textContent = firstName ? `Hey ${firstName},` : 'Hey there,';

  const rows = await fetchProfileRows(userId);
  const watched = rows.filter(row => row.watched).length;
  const isNewUser = rows.length === 0;
  panel.classList.toggle('is-new-user', isNewUser);

  const plural = n => `${n} Video${n === 1 ? '' : 's'}`;
  const scheduledEl = document.getElementById('profileScheduled');
  const watchedEl = document.getElementById('profileWatched');
  animateProfileStatCount(scheduledEl, rows.length);
  animateProfileStatCount(watchedEl, watched);

  const subEl = document.getElementById('profileSub');
  if (subEl) {
    subEl.textContent = isNewUser
      ? 'Schedule your first video and track your journey here'
      : 'This is your journey with us so far!';
  }

  const persona = personaFor(rows, await loadSelectedTimes(userId));
  const personaEl = document.getElementById('profilePersona');
  if (personaEl) {
    personaEl.textContent = persona;
    personaEl.hidden = !persona;
  }

  const trend = isNewUser ? null : completionTrend(rows);
  const trendShell = document.getElementById('profileTrendShell');
  const trendEl = document.getElementById('profileTrend');
  const trendText = document.getElementById('profileTrendText');
  if (trendShell && trendEl && trendText) {
    trendShell.hidden = !trend;
    trendEl.classList.toggle('is-down', !!trend && !trend.up);
    if (trend) {
      trendText.textContent =
        `${trend.delta}% ${trend.up ? 'increase' : 'decrease'} in the completion rate since last week`;
    }
  }
}

async function loadSelectedTimes(userId) {
  if (!userId || userId === 'preview-user') return [];
  const { data } = await supabaseClient
    .from('user_slot_preferences')
    .select('selected_times')
    .eq('user_id', userId)
    .maybeSingle();
  return data?.selected_times || [];
}

function wireProfileMenuOnce() {
  if (profileState.wired) return;
  profileState.wired = true;
  document.getElementById('profileCloseBtn')?.addEventListener('click', event => {
    event.stopPropagation();
    closeProfileMenu();
  });
  document.getElementById('profileGiftBtn')?.addEventListener('click', event => {
    event.stopPropagation();
    showToast('Referrals coming soon!', 'info');
  });
  document.getElementById('profileBackdrop')?.addEventListener('click', closeProfileMenu);
  document.getElementById('viewHistory')?.addEventListener('click', event => {
    event.stopPropagation();
    openHistoryModal(window.currentUserId || 'preview-user');
  });
  document.getElementById('slotPreferences')?.addEventListener('click', event => {
    event.stopPropagation();
    openSchedPrefs('day');
  });
  document.getElementById('logoutBtn')?.addEventListener('click', event => {
    event.stopPropagation();
    openLogoutModal();
  });
  document.getElementById('feedbackBtn')?.addEventListener('click', event => {
    event.stopPropagation();
    openFeedbackModal(window.currentUserId || 'preview-user');
  });
}

/** Must match --profile-enter-ms (same medium timing as success sheets). */
const PROFILE_ENTER_MS = SUCCESS_ENTER_MS;
const PROFILE_SLIDE_MS = PROFILE_ENTER_MS;
/** Must match --profile-count-ms / --profile-star-ms — 0→N ease-in-out after sheet lands. */
const PROFILE_COUNT_MS = SUCCESS_STAR_MS;
/* Sheet land + numbers/stars. */
const PROFILE_CASCADE_MS = PROFILE_ENTER_MS + PROFILE_COUNT_MS + 80;

function formatProfileVideoCount(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  return `${v} Video${v === 1 ? '' : 's'}`;
}

/** Ease-in-out count from 0 → target (starts after sheet lands). */
function animateProfileStatCount(el, target) {
  if (!el) return;
  cancelAnimationFrame(el._countRaf);
  clearTimeout(el._countDelay);
  el._countRaf = 0;
  el._countDelay = 0;
  const end = Math.max(0, Math.round(Number(target) || 0));
  if (prefersReducedMotion() || end === 0) {
    el.textContent = formatProfileVideoCount(end);
    return;
  }
  el.textContent = formatProfileVideoCount(0);
  const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  el._countDelay = setTimeout(() => {
    const t0 = performance.now();
    const tick = now => {
      const t = Math.min(1, (now - t0) / PROFILE_COUNT_MS);
      el.textContent = formatProfileVideoCount(easeInOut(t) * end);
      if (t < 1) el._countRaf = requestAnimationFrame(tick);
    };
    el._countRaf = requestAnimationFrame(tick);
  }, PROFILE_ENTER_MS);
}

function stopProfileStatCounts() {
  ['profileScheduled', 'profileWatched'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    cancelAnimationFrame(el._countRaf);
    clearTimeout(el._countDelay);
    el._countRaf = 0;
    el._countDelay = 0;
  });
}

function openProfileMenu(userId, opts = {}) {
  const overlay = mountOverlay('profileOverlay');
  if (!overlay) return;
  wireProfileMenuOnce();
  clearTimeout(overlay._hideTimer);
  clearTimeout(overlay._contentTimer);
  stopProfileStatCounts();
  overlay.hidden = false;
  overlay.classList.remove('hidden', 'is-closing', 'is-stacked-under', 'is-open', 'is-entering');
  void overlay.offsetWidth;
  overlay.classList.add('is-entering', 'is-open');
  overlay.setAttribute('aria-hidden', 'false');
  overlay._contentTimer = setTimeout(
    () => overlay.classList.remove('is-entering'),
    PROFILE_CASCADE_MS
  );
  if (opts.previewState) paintProfilePreviewState(opts.previewState);
  else paintProfileMenu(userId);
}

function closeProfileMenu() {
  const overlay = document.getElementById('profileOverlay');
  if (!overlay || overlay.hidden) return;
  stopProfileStatCounts();
  overlay.setAttribute('aria-hidden', 'true');
  clearTimeout(overlay._hideTimer);
  clearTimeout(overlay._contentTimer);
  clearTimeout(overlay._unstackTimer);
  overlay.classList.remove('is-entering', 'is-stacked-under');
  overlay.classList.add('is-closing');
  overlay._hideTimer = setTimeout(() => {
    overlay.classList.remove('is-open', 'is-closing');
    overlay.classList.add('hidden');
    overlay.hidden = true;
  }, PROFILE_SLIDE_MS);
}

/** Preview `#preview=1&schedule=1&profile=1` — cycle first / trend-up / trend-down. */
function paintProfilePreviewState(kind) {
  const panel = document.getElementById('profilePanel');
  if (!panel) return;
  profileState.name = 'Girish';
  const nameEl = document.getElementById('profileName');
  if (nameEl) nameEl.textContent = 'Hey Girish,';
  const personaEl = document.getElementById('profilePersona');
  if (personaEl) {
    personaEl.textContent = 'Night Owl';
    personaEl.hidden = false;
  }
  const versionEl = document.getElementById('profileVersion');
  if (versionEl) {
    versionEl.textContent = 'V 1.1.6';
    versionEl.hidden = false;
  }
  const isFirst = kind === 'first';
  panel.classList.toggle('is-new-user', isFirst);
  const scheduledEl = document.getElementById('profileScheduled');
  const watchedEl = document.getElementById('profileWatched');
  animateProfileStatCount(scheduledEl, isFirst ? 0 : 12);
  animateProfileStatCount(watchedEl, isFirst ? 0 : 9);
  const subEl = document.getElementById('profileSub');
  if (subEl) {
    subEl.textContent = isFirst
      ? 'Schedule your first video and track your journey here'
      : 'This is your journey with us so far!';
  }
  const trendShell = document.getElementById('profileTrendShell');
  const trendEl = document.getElementById('profileTrend');
  const trendText = document.getElementById('profileTrendText');
  if (trendShell && trendEl && trendText) {
    const show = kind === 'up' || kind === 'down';
    trendShell.hidden = !show;
    trendEl.classList.toggle('is-down', kind === 'down');
    if (show) {
      trendText.textContent =
        kind === 'up'
          ? '12% increase in the completion rate since last week'
          : '8% decrease in the completion rate since last week';
    }
  }
}

function stopProfilePreviewLoop() {
  clearTimeout(stopProfilePreviewLoop._close);
  clearTimeout(stopProfilePreviewLoop._open);
  stopProfilePreviewLoop._close = null;
  stopProfilePreviewLoop._open = null;
}

function stopHistoryPreviewLoop() {
  ['_t1', '_t2', '_t3', '_t4', '_t5', '_t6'].forEach(k => {
    clearTimeout(stopHistoryPreviewLoop[k]);
    stopHistoryPreviewLoop[k] = null;
  });
  closeHistoryConfirmPreview();
}

/** Preview helper — open delete / mark-watched confirms over the playlist. */
function openHistoryConfirmPreview(kind) {
  const base = {
    title: 'Celestial Skies: A Journey Through the Stars',
    video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  };
  if (kind === 'single-delete') {
    deleteHistoryItem({ ...base, id: 'preview-del-1', session_count: 1 }, null);
  } else if (kind === 'multi-delete') {
    deleteHistoryItem({
      ...base,
      id: 'preview-del-m',
      session_count: 4,
      _sessions: [{ id: 'ps1' }, { id: 'ps2' }, { id: 'ps3' }, { id: 'ps4' }]
    }, null);
  } else if (kind === 'mark-watched') {
    openMarkWatchedConfirm({
      ...base,
      id: 'preview-mark',
      session_count: 3,
      _sessions: [{ id: 'pm1' }, { id: 'pm2' }, { id: 'pm3' }]
    }, null);
  }
}

function closeHistoryConfirmPreview() {
  closeDeleteConfirm();
  closeMarkWatchedConfirm();
}

/** Preview `#preview=1&schedule=1&history=1` — profile → playlist → confirm sheets → back. */
function startHistoryPreviewLoop() {
  stopHistoryPreviewLoop();
  stopProfilePreviewLoop();
  stopOutcomePreviewLoop();
  const emptyFilters = ['scheduled', 'watched', 'forced'];
  const confirmKinds = ['single-delete', 'multi-delete', 'mark-watched'];
  let i = 0;
  const play = () => {
    const mode = i % 4;
    const empty = mode === 1;
    const confirm = mode >= 2;
    const filter = emptyFilters[Math.floor(i / 4) % emptyFilters.length];
    const confirmKind = confirmKinds[(Math.floor(i / 4)) % confirmKinds.length];
    i += 1;
    openProfileMenu('preview-user', { previewState: 'up' });
    stopHistoryPreviewLoop._t1 = setTimeout(() => {
      openHistoryModal('preview-user');
      if (empty) {
        stopHistoryPreviewLoop._t2 = setTimeout(() => {
          historyState.counts = { scheduled: 0, watched: 0, forced: 0 };
          historyState.items = [];
          historyState.filter = filter;
          historyState.page = 1;
          paintHistoryPage();
        }, 80);
      }
      const holdMs = empty ? 2200 : (confirm ? PROFILE_CASCADE_MS + 900 : PROFILE_CASCADE_MS + 1800);
      stopHistoryPreviewLoop._t3 = setTimeout(() => {
        if (confirm) {
          openHistoryConfirmPreview(confirmKind);
          stopHistoryPreviewLoop._t5 = setTimeout(() => {
            closeHistoryConfirmPreview();
            stopHistoryPreviewLoop._t6 = setTimeout(() => {
              closeHistoryModal();
              stopHistoryPreviewLoop._t4 = setTimeout(() => {
                closeProfileMenu();
                setTimeout(play, PROFILE_SLIDE_MS + 400);
              }, SHEET_SLIDE_MS + 320);
            }, SHEET_SLIDE_MS + 1400);
          }, 400);
        } else {
          closeHistoryModal();
          stopHistoryPreviewLoop._t4 = setTimeout(() => {
            closeProfileMenu();
            setTimeout(play, PROFILE_SLIDE_MS + 400);
          }, SHEET_SLIDE_MS + 320);
        }
      }, holdMs);
    }, PROFILE_CASCADE_MS + 600);
  };
  play();
}

function startProfilePreviewLoop() {
  stopProfilePreviewLoop();
  stopHistoryPreviewLoop();
  stopOutcomePreviewLoop();
  const states = ['first', 'up', 'down'];
  let i = 0;
  const holdMs = PROFILE_CASCADE_MS + 1400;
  const play = () => {
    const kind = states[i % states.length];
    i += 1;
    openProfileMenu('preview-user', { previewState: kind });
    stopProfilePreviewLoop._close = setTimeout(() => {
      closeProfileMenu();
      stopProfilePreviewLoop._open = setTimeout(play, PROFILE_SLIDE_MS + 320);
    }, holdMs);
  };
  play();
}

/* ─── Feedback · Help us improve (118:1358) ─────────────────────────────────
   Own open/close path (not shared openOverlay). Profile is frozen under a
   second blur layer for the whole transition; only feedback animates. */
const feedbackState = { userId: null, wired: false, overLimitToasted: false };
const logoutState = { wired: false };
const FEEDBACK_MAX = 250;
const FEEDBACK_TOAST_MAX = `Max ${FEEDBACK_MAX} characters`;

function paintFeedbackCount() {
  const input = document.getElementById('feedbackInput');
  const count = document.getElementById('feedbackCount');
  const send = document.getElementById('feedbackSendBtn');
  const length = input ? input.value.length : 0;
  const over = length > FEEDBACK_MAX;
  if (count) {
    count.textContent = `${length}/${FEEDBACK_MAX} characters`;
    count.classList.toggle('is-over', over);
  }
  if (send) send.disabled = !(input && input.value.trim() && !over);
}

function wireFeedbackOnce() {
  if (feedbackState.wired) return;
  feedbackState.wired = true;

  const input = document.getElementById('feedbackInput');
  input?.addEventListener('input', () => {
    if (!input) return;
    const len = input.value.length;
    if (len > FEEDBACK_MAX) {
      if (!feedbackState.overLimitToasted) {
        feedbackState.overLimitToasted = true;
        showToast(FEEDBACK_TOAST_MAX, 'info');
      }
    } else {
      feedbackState.overLimitToasted = false;
    }
    paintFeedbackCount();
  });

  document.getElementById('feedbackCloseBtn')?.addEventListener('click', event => {
    event.stopPropagation();
    closeFeedbackModal();
  });
  document.getElementById('feedbackBackdrop')?.addEventListener('click', closeFeedbackModal);
  document.getElementById('feedbackSendBtn')?.addEventListener('click', async () => {
    const message = (input?.value || '').trim();
    if (!message || message.length > FEEDBACK_MAX) return;
    recordButtonClick('Send');

    if (document.body.classList.contains('wl-preview') || feedbackState.userId === 'preview-user') {
      finishFeedbackSend('Feedback sent', 'success');
      return;
    }

    const { data: { user }, error: authErr } = await supabaseClient.auth.getUser();
    if (authErr || !user) {
      console.error('Feedback auth failed:', authErr?.message || 'no user');
      return showToast('Failed to send feedback.', 'error');
    }
    const { error } = await supabaseClient.from('feedback').insert([{
      user_id: user.id,
      type: 'text',
      message,
      video_url: cachedVideoUrl || null
    }]);
    if (error) {
      console.error('Feedback insert failed:', error.message);
      return showToast('Failed to send feedback.', 'error');
    }
    finishFeedbackSend('Feedback sent', 'success');
  });
}

function openFeedbackModal(userId) {
  const overlay = mountOverlay('feedbackOverlay');
  if (!overlay) return;

  feedbackState.userId = userId;
  feedbackState.overLimitToasted = false;
  wireFeedbackOnce();

  const input = document.getElementById('feedbackInput');
  if (input) input.value = '';
  paintFeedbackCount();

  // Freeze profile first so none of its entry/cascade rules can restart.
  setProfileStackedUnder(true);

  clearTimeout(overlay._hideTimer);
  clearTimeout(overlay._focusTimer);
  overlay.hidden = false;
  overlay.classList.remove('hidden', 'is-closing');
  void overlay.offsetWidth;
  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');

  // Focus after the sheet lands — focusing mid-slide shifts the profile behind.
  overlay._focusTimer = setTimeout(() => input?.focus(), SHEET_SLIDE_MS);
}

function closeFeedbackModal(onClosed) {
  const overlay = document.getElementById('feedbackOverlay');
  if (!overlay || overlay.hidden) {
    onClosed?.();
    return;
  }

  clearTimeout(overlay._focusTimer);
  document.getElementById('feedbackInput')?.blur();

  overlay.setAttribute('aria-hidden', 'true');
  clearTimeout(overlay._hideTimer);
  overlay.classList.add('is-closing');
  overlay._hideTimer = setTimeout(() => {
    overlay.classList.remove('is-open', 'is-closing');
    overlay.classList.add('hidden');
    overlay.hidden = true;
    onClosed?.();
  }, SHEET_SLIDE_MS);

  // Keep profile frozen until feedback has fully slid out.
  releaseProfileStackAfterSlide();
}

function finishFeedbackSend(toastMsg, toastType = 'success') {
  closeFeedbackModal(() => showToast(toastMsg, toastType));
}


function wireLogoutOnce() {
  if (logoutState.wired) return;
  logoutState.wired = true;
  document.getElementById('logoutBackdrop')?.addEventListener('click', closeLogoutModal);
  document.getElementById('logoutBackBtn')?.addEventListener('click', closeLogoutModal);
  document.getElementById('logoutConfirmBtn')?.addEventListener('click', () => performLogout());
}

function openLogoutModal() {
  const overlay = mountOverlay('logoutOverlay');
  if (!overlay) return;
  wireLogoutOnce();
  setProfileStackedUnder(true);
  openOverlay(overlay);
}

function closeLogoutModal() {
  const overlay = document.getElementById('logoutOverlay');
  if (overlay) closeOverlay(overlay);
  releaseProfileStackAfterSlide();
}

async function performLogout() {
  recordButtonClick('Log Out');

  if (document.body.classList.contains('wl-preview')) {
    await new Promise(r => chrome.storage.local.remove(
      ['supabase_token', 'supabase_refresh', 'google_access_token', 'userId'],
      r
    ));
    await storageSet({ [ONB_FLAG_COMPLETE]: false });
    closeLogoutModal();
    closeProfileMenu();
    document.getElementById('scheduleScreen')?.classList.add('hidden');
    showOnboarding({ wrongUrl: true });
    return;
  }

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return;

  // Soft logout: keep remote prefs/history, but restart the onboarding UI flow.
  await supabaseClient.from('users').upsert({
    id: user.id,
    email: user.email,
    name: user.user_metadata?.name,
    avatar_url: user.user_metadata?.picture
  });

  await storageRemove([
    'supabase_token',
    'supabase_refresh',
    'google_access_token',
    'userId',
    ONB_FLAG_SCANNED
  ]);
  await storageSet({ [ONB_FLAG_COMPLETE]: false });

  await supabaseClient.auth.signOut();
  currentAuthUser = null;
  window.currentUserId = null;
  closeLogoutModal();
  closeProfileMenu();

  const tab = await getActiveInjectableTab().catch(() => null);
  document.getElementById('scheduleScreen')?.classList.add('hidden');
  document.getElementById('scheduleBtn').style.display = 'none';
  document.getElementById('streakProgress')?.classList.add('hidden');
  showOnboarding({ wrongUrl: !isYouTubeWatchUrl(tab?.url) });
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



/**
 * Full account wipe from the popup (uncheck "remember me"). Auth user stays;
 * only extension-owned rows are removed.
 */
async function wipeUserRemoteData(userId) {
  if (!userId || window.__WL_PREVIEW__) return;
  const del = (table, col = 'user_id') =>
    supabaseClient.from(table).delete().eq(col, userId);
  // Redemptions as redeemer first; owned codes next (CASCADE drops code redemptions).
  await del('referral_redemptions', 'redeemed_user_id');
  await del('referral_codes');
  await Promise.all([
    del('videohistory'),
    del('user_slot_preferences'),
    del('calendar_slot_scores'),
    del('calendar_scan_runs'),
    del('feedback'),
  ]);
  await del('users', 'id');
}

/**
 * freeBusy for one range. Throws on every failure mode instead of returning [],
 * because "no busy blocks" and "the request failed" score identically — an empty
 * array from a 403 would tell the algorithm the user's calendar is wide open.
 */
async function fetchFreeBusyRange(accessToken, timeMin, timeMax, { retried = false } = {}) {
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
  if (res.status === 401 && !retried) {
    const ok = await ensureValidGoogleToken();
    if (!ok) throw new Error('freeBusy 401: silent re-auth failed');
    const { google_access_token } = await new Promise(r =>
      chrome.storage.local.get('google_access_token', r)
    );
    return fetchFreeBusyRange(google_access_token, timeMin, timeMax, { retried: true });
  }
  if (!res.ok) throw new Error(`freeBusy HTTP ${res.status}`);
  const json = await res.json();
  const cal = json?.calendars?.primary;
  // Per-calendar problems come back inside a 200 response with no busy array.
  const calError = cal?.errors?.[0]?.reason;
  if (calError) throw new Error(`freeBusy calendar error: ${calError}`);
  if (!Array.isArray(cal?.busy)) throw new Error('freeBusy: malformed response');
  return cal.busy;
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

  const { data: pref, error: prefErr } = await supabaseClient
    .from('user_slot_preferences')
    .select('selected_days, selected_times')
    .eq('user_id', userId)
    .maybeSingle();
  if (prefErr || !pref) {
    return { days: [], slots: [] };
  }
  return {
    days: Array.isArray(pref.selected_days) ? pref.selected_days : [],
    slots: Array.isArray(pref.selected_times) ? pref.selected_times : [],
  };
}

async function saveUserPrefs(userId, { days, slots }, opts = {}) {
  if (!userId) return false;
  const dayList = days?.length ? days : [];
  const slotList = slots?.length ? slots : [];
  const payload = {
    user_id: userId,
    days: dayList.length ? dayList : DEFAULT_PREF_DAYS.slice(),
    slots: slotList.length ? slotList : DEFAULT_PREF_SLOTS.slice(),
  };
  if (window.__WL_PREVIEW__) {
    await new Promise(r => chrome.storage.local.set({ preview_user_slots: payload }, r));
    return true;
  }

  const prefRow = {
    user_id: userId,
    selected_days: dayList,
    selected_times: slotList,
    last_edited_at: new Date().toISOString(),
  };
  if (opts.suggestedDays) {
    prefRow.suggested_days_at_setup = opts.suggestedDays;
    prefRow.suggested_times_at_setup = opts.suggestedTimes || [];
    prefRow.suggested_algorithm_version = opts.algorithmVersion || 1;
  }
  if (opts.daysEditedManually) prefRow.days_edited_manually = true;
  if (opts.timesEditedManually) prefRow.times_edited_manually = true;

  const { error: prefError } = await supabaseClient
    .from('user_slot_preferences')
    .upsert(prefRow);
  if (prefError) {
    console.error('Failed to save user_slot_preferences:', prefError);
    return false;
  }
  return true;
}

async function loadSlotAlgoConfig() {
  const defaults = (typeof WLSlotAlgorithm !== 'undefined' && WLSlotAlgorithm.DEFAULT_CONFIG)
    ? { ...WLSlotAlgorithm.DEFAULT_CONFIG }
    : { FREE_RATIO_THRESHOLD: 0.8, SELECTION_THRESHOLD: 0.7, MIN_SAMPLE_SIZE: 3, MAX_SELECTIONS: 3, ALGORITHM_VERSION: 1, STALENESS_DAYS: 30 };
  if (window.__WL_PREVIEW__ || typeof supabaseClient === 'undefined') return defaults;
  try {
    const { data } = await supabaseClient.from('slot_algorithm_config').select('key, value');
    if (!data?.length) return defaults;
    for (const row of data) {
      if (row.key && row.value != null) defaults[row.key] = Number(row.value);
    }
  } catch (_) { /* use defaults */ }
  return defaults;
}

const SCAN_LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * True when a scan must not start: another one is genuinely in flight, or a
 * recent failure asked us to back off.
 * ponytail: the in-flight lock is a TTL, not a lease — a popup closed mid-scan
 * never writes completed_at, so a plain `status = running` check would block
 * every future scan forever. Upgrade to a heartbeat if scans ever exceed the TTL.
 */
async function scanIsBlocked(userId, { respectBackoff = true } = {}) {
  if (!userId || window.__WL_PREVIEW__) return false;
  const { data } = await supabaseClient
    .from('calendar_scan_runs')
    .select('status, started_at, completed_at, not_before')
    .eq('user_id', userId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return false;
  const now = Date.now();
  if (
    data.status === 'running' &&
    !data.completed_at &&
    now - new Date(data.started_at).getTime() < SCAN_LOCK_TTL_MS
  ) return true;
  // Backoff only gates background rescans; a user who asked for this waits on Google, not on us.
  if (respectBackoff && data.not_before && now < new Date(data.not_before).getTime()) return true;
  return false;
}

async function scoresAreStale(userId, stalenessDays = 30) {
  if (!userId || window.__WL_PREVIEW__) return false;
  const { data } = await supabaseClient
    .from('calendar_slot_scores')
    .select('scanned_at')
    .eq('user_id', userId)
    .order('scanned_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.scanned_at) return true;
  const ageMs = Date.now() - new Date(data.scanned_at).getTime();
  return ageMs > stalenessDays * 86400000;
}

/**
 * Scan freeBusy → write calendar_slot_scores.
 * First-time (empty prefs): also suggest + save selected + suggested snapshot.
 * Rescan: scores/hints only — never overwrite selected_days/times.
 */
async function analyzeAndSavePrefs(userId, accessToken, { force = false, triggeredBy = 'onboarding' } = {}) {
  const existing = await loadUserPrefs(userId);
  const hasSelection = !!(existing.days?.length && existing.slots?.length);
  const algo = typeof WLSlotAlgorithm !== 'undefined' ? WLSlotAlgorithm : null;

  if (window.__WL_PREVIEW__ || !accessToken || accessToken === 'preview-google' || !algo) {
    if (!hasSelection) {
      await saveUserPrefs(userId, {
        days: DEFAULT_PREF_DAYS.slice(),
        slots: DEFAULT_PREF_SLOTS.slice(),
      }, {
        suggestedDays: DEFAULT_PREF_DAYS.slice(),
        suggestedTimes: DEFAULT_PREF_SLOTS.slice(),
      });
    }
    return {
      days: hasSelection ? existing.days : DEFAULT_PREF_DAYS.slice(),
      slots: hasSelection ? existing.slots : DEFAULT_PREF_SLOTS.slice(),
      dayHints: Object.fromEntries(PREFS_DOW.map(k => [k, 'Free days'])),
      slotHints: Object.fromEntries(Object.keys(SLOT_RANGES).map(k => [k, 'Free days'])),
    };
  }

  if (await scanIsBlocked(userId, { respectBackoff: triggeredBy === 'opportunistic' })) {
    return {
      days: existing.days,
      slots: existing.slots,
      dayHints: {},
      slotHints: {},
      skipped: true,
    };
  }

  const config = await loadSlotAlgoConfig();
  const { timeMin, timeMax } = algo.prefsAnalysisWindow();
  const windowStart = timeMin.toISOString().slice(0, 10);
  const windowEnd = timeMax.toISOString().slice(0, 10);

  let runId = null;
  try {
    const { data: run } = await supabaseClient
      .from('calendar_scan_runs')
      .insert({
        user_id: userId,
        window_start: windowStart,
        window_end: windowEnd,
        status: 'running',
        triggered_by: triggeredBy,
      })
      .select('id')
      .single();
    runId = run?.id;
  } catch (_) { /* non-fatal */ }

  let busy = [];
  let coveredRanges = [{ start: timeMin, end: timeMax }];
  let status = 'success';
  let errorReason = null;
  try {
    busy = await fetchFreeBusyRange(accessToken, timeMin, timeMax);
  } catch (err) {
    errorReason = String(err?.message || err);
    // Degraded: fetch month by month and score only the months that answered.
    // A month we never fetched has no busy blocks, so scoring it would read as
    // "completely free" and invent slots the user does not actually have.
    const months = algo.monthRanges();
    const parts = [];
    const covered = [];
    for (const m of months) {
      try {
        const chunk = await fetchFreeBusyRange(accessToken, m.start, m.end);
        parts.push(...chunk);
        covered.push(m);
      } catch (e) {
        errorReason = String(e?.message || e);
      }
    }
    busy = parts;
    coveredRanges = covered;
    if (!covered.length) status = 'failed';
    else if (covered.length < months.length) status = 'partial';
    else status = 'success';
  }

  if (status === 'failed') {
    if (runId) {
      await supabaseClient.from('calendar_scan_runs').update({
        status: 'failed',
        error_reason: errorReason || 'freeBusy failed',
        completed_at: new Date().toISOString(),
        not_before: new Date(Date.now() + 3600000).toISOString(),
      }).eq('id', runId);
    }
    // Serve last prefs; do not invent suggestions from a failed scan
    return {
      days: existing.days,
      slots: existing.slots,
      dayHints: {},
      slotHints: {},
      scanFailed: true,
    };
  }

  const { scores, rows } = algo.computeScores(busy, coveredRanges, config);
  const scannedAt = new Date().toISOString();
  const upsertRows = rows.map(r => ({
    user_id: userId,
    weekday: r.weekday,
    time_bucket: r.time_bucket,
    score: r.score,
    sample_size: r.sample_size,
    confidence: r.confidence,
    algorithm_version: r.algorithm_version,
    scanned_at: scannedAt,
  }));

  if (upsertRows.length) {
    const { error: scoreErr } = await supabaseClient
      .from('calendar_slot_scores')
      .upsert(upsertRows, { onConflict: 'user_id,weekday,time_bucket' });
    if (scoreErr) console.error('calendar_slot_scores upsert failed:', scoreErr);
  }

  if (runId) {
    await supabaseClient.from('calendar_scan_runs').update({
      status,
      error_reason: errorReason,
      completed_at: scannedAt,
      not_before: status === 'partial'
        ? new Date(Date.now() + 86400000).toISOString()
        : null,
    }).eq('id', runId);
  }

  const { dayHints, slotHints } = algo.hintsFromScores(scores);
  await new Promise(r =>
    chrome.storage.local.set({ prefs_hints: { days: dayHints, slots: slotHints } }, r)
  );

  // First-time only: write suggestions into selected + snapshot
  if (!hasSelection) {
    const { suggestedDays, suggestedTimes } = algo.suggestPreferences(scores, config);
    await saveUserPrefs(userId, { days: suggestedDays, slots: suggestedTimes }, {
      suggestedDays,
      suggestedTimes,
      algorithmVersion: config.ALGORITHM_VERSION,
    });
    return { days: suggestedDays, slots: suggestedTimes, dayHints, slotHints };
  }

  // Rescan / reconnect: selection untouched (force no longer overwrites picks)
  void force;
  return { days: existing.days, slots: existing.slots, dayHints, slotHints };
}

async function fetchAvailableCalendarSlots(userId, accessToken, videoDurationMin = 10, options = {}) {
  const {
    windowDays = 7,
    excludeDates = null,
    notBefore = null,
    limit = 4,
    excludeSlotKeys = null,
  } = options;
  const exclude = excludeDates instanceof Set ? excludeDates : new Set();
  const excludeKeys = excludeSlotKeys instanceof Set ? excludeSlotKeys : new Set();
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
    const minStart = notBefore ? new Date(notBefore) : now;
    const slotTimes = [];

    for (let day = 0; day < windowDays; day++) {
      const date = new Date(now);
      date.setDate(now.getDate() + day);
      const dayKey = PREFS_DOW[date.getDay()];
      if (!preferredDays.includes(dayKey)) continue;

      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      const dateStr = `${y}-${m}-${d}`;
      if (exclude.has(dateStr)) continue;

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
          if (start < minStart) continue;
          const end = new Date(start.getTime() + videoDurationMin * 60 * 1000);
          slotTimes.push({
            start: start.toISOString(),
            end: end.toISOString(),
            date: dateStr,
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
        timeMax: new Date(Date.now() + windowDays * 24 * 60 * 60 * 1000).toISOString(),
        items: [{ id: 'primary' }],
      }),
    });

    const json = await res.json();
    const busy = json?.calendars?.primary?.busy || [];

    const free = slotTimes.filter(slot => {
      const key = `${slot.date}|${slot.start}`;
      if (excludeKeys.has(key)) return false;
      return !busy.some(b =>
        new Date(b.start) < new Date(slot.end) &&
        new Date(b.end) > new Date(slot.start)
      );
    });

    return free.slice(0, limit);
  } catch (err) {
    console.error('❌ Slot fetch failed:', err);
    return [];
  }
}

async function fetchMultiSessionSlots(userId, accessToken, sessionPlan, { skipSessions = [], excludeSlotKeys = null } = {}) {
  const algo = typeof WLSlotAlgorithm !== 'undefined' ? WLSlotAlgorithm : null;
  if (!algo || !sessionPlan?.sessions?.length) {
    return { sessions: [], complete: false };
  }

  const assignedSlots = [];
  const usedDates = new Set();
  let searchWindowDays = 7;
  const skipSet = new Set(skipSessions);
  const excludeKeys = excludeSlotKeys instanceof Set ? excludeSlotKeys : new Set();
  const candidateLimit = excludeKeys.size ? 12 : 1;

  for (const session of sessionPlan.sessions) {
    if (skipSet.has(session.sessionIndex)) continue;

    let candidates = [];
    let windowDays = searchWindowDays;
    const notBefore = assignedSlots.length
      ? new Date(assignedSlots[assignedSlots.length - 1].slot.end)
      : new Date();

    while (!candidates.length && windowDays <= algo.MULTI_SESSION_MAX_WINDOW_DAYS) {
      candidates = await fetchAvailableCalendarSlots(
        userId,
        accessToken,
        session.durationMin,
        {
          windowDays,
          excludeDates: usedDates,
          notBefore,
          limit: candidateLimit,
          excludeSlotKeys: excludeKeys,
        }
      );
      if (!candidates.length) {
        if (windowDays >= algo.MULTI_SESSION_MAX_WINDOW_DAYS) break;
        windowDays *= 2;
        searchWindowDays = windowDays;
      }
    }

    if (!candidates.length) continue;

    const chosen = candidates[0];
    const dateKey = chosen.date || String(chosen.start).slice(0, 10);
    assignedSlots.push({ ...session, slot: chosen, date: dateKey, start: chosen.start });
    usedDates.add(dateKey);
  }

  algo.validateSessionPlan(assignedSlots);
  const expected = sessionPlan.sessions.filter(s => !skipSet.has(s.sessionIndex)).length;
  return {
    sessions: assignedSlots,
    complete: assignedSlots.length === expected,
  };
}

async function scheduleMultiSessionVideo() {
  const authUser = currentAuthUser;
  const plan = multiSessionState.plan;
  const assigned = multiSessionState.assigned || [];
  if (!authUser || !plan || !multiSessionState.complete || !assigned.length) return;

  const schedBtn = document.getElementById('scheduleMultiBtn');
  if (schedBtn) schedBtn.disabled = true;

  const activeTab = await getActiveInjectableTab();
  if (!activeTab) {
    showToast('Open a YouTube video to schedule.', 'info');
    if (schedBtn) schedBtn.disabled = false;
    return;
  }

  const [adCheck] = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    func: () => {
      const player = document.querySelector('.html5-video-player');
      return player?.classList.contains('ad-showing') ?? false;
    }
  }).catch(() => [null]);

  if (adCheck?.result) {
    showToast('Please wait until the ad finishes before scheduling.', 'info');
    if (schedBtn) schedBtn.disabled = false;
    return;
  }

  if (!navigator.onLine) {
    showNetworkLostScreen();
    if (schedBtn) schedBtn.disabled = false;
    return;
  }

  const valid = await ensureValidGoogleToken();
  if (!valid) {
    if (schedBtn) schedBtn.disabled = false;
    return;
  }

  const videoUrl = activeTab.url;

  const { data: dup } = await supabaseClient
    .from('videohistory')
    .select('id')
    .eq('user_id', authUser.id)
    .eq('video_url', videoUrl)
    .eq('watched', false)
    .limit(1)
    .maybeSingle();
  if (dup) {
    showToast('This video is already scheduled', 'info');
    if (schedBtn) schedBtn.disabled = false;
    return;
  }

  let { google_access_token } = await new Promise(res =>
    chrome.storage.local.get('google_access_token', res)
  );

  const groupId = crypto.randomUUID();
  const thumbnailUrl = getYouTubeThumbnail(videoUrl);
  const rows = [];
  let firstSlot = null;

  for (const entry of assigned) {
    const partInfo = {
      sessionIndex: entry.sessionIndex,
      sessionCount: entry.sessionCount,
      videoOffsetStartSec: entry.videoOffsetStartSec,
      videoOffsetEndSec: entry.videoOffsetEndSec,
    };
    let result = await tryScheduleEventOnce(
      google_access_token,
      entry.slot,
      cachedVideoTitle,
      authUser,
      videoUrl,
      partInfo
    );
    if (!result.success && result.error?.error?.code === 401) {
      const reauth = await ensureValidGoogleToken();
      if (reauth) {
        google_access_token = (await new Promise(res =>
          chrome.storage.local.get('google_access_token', res)
        )).google_access_token;
        result = await tryScheduleEventOnce(
          google_access_token,
          entry.slot,
          cachedVideoTitle,
          authUser,
          videoUrl,
          partInfo
        );
      }
    }
    if (!result.success) {
      console.error('Multi-session schedule failed:', result.error);
      showScheduleFailModal({
        title: cachedVideoTitle,
        start: entry.slot.start,
        end: entry.slot.end,
      });
      if (schedBtn) schedBtn.disabled = false;
      return;
    }
    if (!firstSlot) firstSlot = entry.slot;
    rows.push({
      user_id: authUser.id,
      title: cachedVideoTitle,
      video_url: videoUrl,
      start_time: entry.slot.start,
      end_time: entry.slot.end,
      google_event_id: result.eventId,
      thumbnail: thumbnailUrl,
      session_group_id: groupId,
      session_index: entry.sessionIndex,
      session_count: entry.sessionCount,
      video_offset_start_sec: entry.videoOffsetStartSec,
      video_offset_end_sec: entry.videoOffsetEndSec,
      all_sessions_watched: false,
    });
  }

  const { error } = await supabaseClient.from('videohistory').insert(rows);
  if (error) {
    console.error('videohistory insert failed:', error);
    showToast('Could not save scheduled sessions', 'error');
    if (schedBtn) schedBtn.disabled = false;
    return;
  }

  const audio = new Audio(chrome.runtime.getURL('ding.mp3'));
  audio.play().catch(() => {});
  showScheduleSuccessModal({
    title: cachedVideoTitle,
    start: firstSlot.start,
    end: firstSlot.end,
  });
  await initStreak(authUser.id);
  if (schedBtn) schedBtn.disabled = false;
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

function hideNewUserWrongUrl() {
  const screen = document.getElementById('newUserWrongUrl');
  if (!screen) return;
  screen.classList.add('hidden');
  screen.setAttribute('aria-hidden', 'true');
}

/* ── Figma 533:9884 Wrong URL — fall cards + browser mock + Oops sheet ── */
function stopWrongUrlFallAnim() {
  const screen = document.getElementById('wrongUrlFallAnim');
  if (!screen) return;
  screen.classList.add('hidden');
  screen.setAttribute('aria-hidden', 'true');
}

function showWrongUrlFallAnim() {
  hideWrongUrlPanel();
  hideNewUserWrongUrl();
  hideAuthFlow();
  document.getElementById('scheduleScreen')?.classList.add('hidden');
  ['onboardingPain', 'onboardingPromise', 'onboardingPermissions', 'onboardingAnalyzing', 'newUserWrongUrl']
    .forEach(id => document.getElementById(id)?.classList.add('hidden'));

  const onb = document.getElementById('onboarding');
  onb?.classList.remove('hidden');
  document.body.classList.add('onboarding-active');

  const screen = document.getElementById('wrongUrlFallAnim');
  if (!screen) return;
  screen.classList.remove('hidden');
  screen.setAttribute('aria-hidden', 'false');

  const fixBtn = document.getElementById('wuaWrongUrlFixBtn');
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

function showNewUserWrongUrl() {
  // All wrong-URL paths share Figma 533:9884 (#wrongUrlFallAnim).
  showWrongUrlFallAnim();
}

function wrongUrlMountParent() {
  if (document.body.classList.contains('onboarding-active')) {
    return document.getElementById('onboarding');
  }
  return document.getElementById('popupWrapper') || document.getElementById('scheduleScreen');
}

function mountWrongUrlOverlay() {
  const overlay = document.getElementById('wrongUrlOverlay');
  const host = wrongUrlMountParent();
  if (!overlay || !host) return overlay;
  if (overlay.parentElement !== host) host.appendChild(overlay);
  return overlay;
}

/** true = on a watch page (modal closed); false = Wrong URL shown */
async function ensureWatchUrlGate({ intent = 'schedule' } = {}) {
  const tab = await getActiveInjectableTab().catch(() => null);
  if (isYouTubeWatchUrl(tab?.url)) {
    hideWrongUrlPanel();
    stopWrongUrlFallAnim();
    return true;
  }
  if (intent === 'idle' || intent === 'general') {
    hideWrongUrlPanel();
    return false;
  }
  // Logged-out / pre-onboarding: NewUserWrongURL (Pain chrome). Logged-in: 444:7885 fall modal.
  if (intent === 'onboarding' || intent === 'new-user') {
    showNewUserWrongUrl();
    return false;
  }
  showWrongUrlFallAnim();
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
  if (titleEl && snap.title) setSchedVideoTitle(snap.title);
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
    closeOverlay(overlay);
  }
  const scheduleBtn = document.getElementById('scheduleBtn');
  if (scheduleBtn && isYouTubeWatchUrl(cachedVideoUrl)) scheduleBtn.disabled = false;
}

async function showWrongUrlPanel({ restore = true } = {}) {
  // Legacy overlay path → shared Figma 533:9884 sheet.
  if (typeof closeSchedPrefs === 'function') closeSchedPrefs();
  if (restore) await restoreLastScheduleSnapshot();
  showWrongUrlFallAnim();
  const scheduleBtn = document.getElementById('scheduleBtn');
  if (scheduleBtn) scheduleBtn.disabled = true;
  document.getElementById('slotGrid')?.querySelectorAll('.sched-slot').forEach(b => { b.disabled = true; });
}

/* ── 36:2189 / 58:7076 Change Preferences: slide-up sheet (same as profile) ── */
const PREFS_CHECK_SVG =
  '<svg class="prefs-day-check" viewBox="0 0 20 20" width="20" height="20" fill="none" aria-hidden="true">' +
  '<path d="m4.5 10.5 3.5 3.5 7.5-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

function prefsChipLabel(name) {
  return (
    `<span class="prefs-day-label">` +
    `<span class="prefs-day-label-inner">${PREFS_CHECK_SVG}<span class="prefs-day-name">${name}</span></span>` +
    `</span>`
  );
}

function prefsChipHtml(name) {
  return `<span class="prefs-day-hint">Moderately busy</span>${prefsChipLabel(name)}`;
}

/** Scan-derived busy hint — independent of whether the chip is selected. */
function updatePrefsChipHint(btn) {
  const hint = btn.querySelector('.prefs-day-hint');
  if (!hint) return;
  const key = btn.dataset.day || btn.dataset.slot;
  const cache = btn.dataset.day ? prefsHintsCache.days : prefsHintsCache.slots;
  hint.textContent = cache[key] || 'Moderately busy';
}

function paintAllPrefsHints() {
  document.querySelectorAll('#prefsDays .prefs-day, #prefsTimes .prefs-day').forEach(updatePrefsChipHint);
}

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
      btn.innerHTML = prefsChipHtml(PREFS_DAY_LABELS[key]);
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
      btn.innerHTML = prefsChipHtml(def.label);
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
    updatePrefsChipHint(btn);
  });
  setBannerPressed(document.getElementById('prefsSundayBtn'), days.has('sun'));

  document.querySelectorAll('#prefsTimes .prefs-day').forEach(btn => {
    const key = btn.dataset.slot;
    const on = slots.has(key);
    btn.classList.toggle('is-selected', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    updatePrefsChipHint(btn);
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

async function openSchedPrefs(step = 'day', { fromSchedule = false } = {}) {
  const overlay = mountOverlay('schedPrefsOverlay');
  if (!overlay) return;
  setProfileStackedUnder(true);
  overlay.classList.toggle('is-from-schedule', fromSchedule);

  ensurePrefsDays();
  ensurePrefsTimes();

  // Trigger A: opportunistic rescan when scores go stale (scores only; selection
  // untouched). Deliberately not awaited — the sheet must open now, not after a
  // freeBusy round trip; refreshed hints land on the next open.
  const userId = wireSchedPrefs._userId;
  if (userId && !window.__WL_PREVIEW__) {
    (async () => {
      try {
        const cfg = await loadSlotAlgoConfig();
        if (!(await scoresAreStale(userId, cfg.STALENESS_DAYS || 30))) return;
        const { google_access_token } = await storageGet(['google_access_token']);
        if (!google_access_token) return;
        await analyzeAndSavePrefs(userId, google_access_token, { triggeredBy: 'opportunistic' });
      } catch (_) { /* prefs UI is already open */ }
    })();
  }

  await loadPrefsHints();
  paintAllPrefsHints();
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
  openOverlay(overlay);
}

function closeSchedPrefs() {
  const overlay = document.getElementById('schedPrefsOverlay');
  if (!overlay || overlay.hidden) return;
  // Keep day/time panels mounted through the slide-out — hiding them first
  // collapses the sheet height and looks like a snap-close.
  closeOverlay(overlay);
  releaseProfileStackAfterSlide();
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
  if (multiSessionState.plan) {
    const result = await fetchMultiSessionSlots(userId, token, multiSessionState.plan);
    multiSessionState.assigned = result.sessions;
    multiSessionState.complete = result.complete;
    paintMultiSessionUI();
    return;
  }
  const updatedSlots = await fetchAvailableCalendarSlots(userId, token, duration);
  availableSlots = updatedSlots;
  populateDropdown(updatedSlots);
}

function wireSchedPrefs(userId) {
  wireSchedPrefs._userId = userId || wireSchedPrefs._userId || null;
  if (wireSchedPrefs._done) return;
  wireSchedPrefs._done = true;

  document.getElementById('changePrefsBtn')?.addEventListener('click', () => openSchedPrefs('day', { fromSchedule: true }));
  document.getElementById('prefsCloseBtn')?.addEventListener('click', () => closeSchedPrefs());
  document.getElementById('prefsTimeCloseBtn')?.addEventListener('click', () => closeSchedPrefs());
  document.getElementById('schedPrefsBackdrop')?.addEventListener('click', () => closeSchedPrefs());
  document.getElementById('prefsNextBtn')?.addEventListener('click', () => showPrefsStep('time'));
  document.getElementById('prefsTimeHeaderBackBtn')?.addEventListener('click', () => showPrefsStep('day'));
  document.getElementById('prefsSaveBtn')?.addEventListener('click', async () => {
    const id = wireSchedPrefs._userId;
    const selected = readPrefsFromUi();
    if (!selected.days.length || !selected.slots.length) {
      showToast('Pick at least one day and one time slot', 'info');
      return;
    }
    const btn = document.getElementById('prefsSaveBtn');
    if (btn) btn.disabled = true;
    const ok = await saveUserPrefs(id, selected, {
      daysEditedManually: true,
      timesEditedManually: true,
    });
    if (btn) btn.disabled = false;
    if (!ok && !window.__WL_PREVIEW__) {
      showToast('Failed to save preferences', 'error');
      return;
    }
    closeSchedPrefs();
    await refreshSlotsAfterPrefsSave(id);
    showToast('Preferences saved', 'success');
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

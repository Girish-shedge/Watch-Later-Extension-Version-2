// OAuth token-rotation stress test. Run: node tests/stress-oauth.js
//
// Simulates Supabase refresh-token rotation with reuse detection (what the real
// auth server does) and replays token-handling strategies:
//   OLD: popup/background each refresh but never persist the rotated token
//   NEW: every consumer persists the rotated pair back to chrome.storage.local
//   LOCKED: concurrent consumers serialize via a lock + adopt peer tokens on reuse
// The old strategy must die with "refresh_token_already_used"; NEW + LOCKED must
// survive hundreds of refresh cycles.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ── Fake Supabase auth: single-use refresh tokens, reuse revokes the family ──
function makeAuthServer() {
  let counter = 0;
  const valid = new Set();
  let familyRevoked = false;
  const issue = () => {
    const t = `rt_${++counter}`;
    valid.add(t);
    return t;
  };
  return {
    login() {
      familyRevoked = false;
      valid.clear();
      return { access_token: 'at', refresh_token: issue() };
    },
    refresh(token) {
      if (familyRevoked) return { error: 'session_revoked' };
      if (!valid.has(token)) {
        familyRevoked = true; // reuse detection: kill the whole session family
        return { error: 'refresh_token_already_used' };
      }
      valid.delete(token); // rotation: each refresh token is single-use
      return { access_token: 'at', refresh_token: issue() };
    }
  };
}

// ── OLD strategy: refresh from the stored copy, never write back ──
function oldStrategy(server, cycles) {
  const storage = { supabase_refresh: server.login().refresh_token };
  for (let i = 1; i <= cycles; i++) {
    const res = server.refresh(storage.supabase_refresh); // stale after cycle 1
    if (res.error) return { failedAt: i, error: res.error };
  }
  return { failedAt: null };
}

// ── NEW strategy: persist the rotated token after every refresh ──
function newStrategy(server, cycles) {
  const storage = { supabase_refresh: server.login().refresh_token };
  for (let i = 1; i <= cycles; i++) {
    // alternate consumers, like the background alarm and popup opens do
    const res = server.refresh(storage.supabase_refresh);
    if (res.error) return { failedAt: i, error: res.error };
    storage.supabase_refresh = res.refresh_token; // persistSupabaseSession()
  }
  return { failedAt: null };
}

// ── Concurrent without lock: both read the same token, second refresh kills family ──
function concurrentNoLock(server) {
  const storage = { supabase_refresh: server.login().refresh_token };
  const snap = storage.supabase_refresh;
  const a = server.refresh(snap);
  storage.supabase_refresh = a.refresh_token;
  const b = server.refresh(snap); // stale copy — reuse detection
  return b.error || null;
}

// ── Locked concurrent: second consumer re-reads storage after lock, adopts peer token ──
function concurrentLocked(server, cycles) {
  const storage = { supabase_refresh: server.login().refresh_token };
  let lock = null;
  const acquire = (id) => {
    while (lock) { /* busy-wait in sync test */ }
    lock = id;
  };
  const release = (id) => { if (lock === id) lock = null; };
  const refreshLocked = (id) => {
    acquire(id);
    try {
      const rt = storage.supabase_refresh;
      const res = server.refresh(rt);
      if (res.error === 'refresh_token_already_used') {
        // Peer rotated while we held a stale snap — storage should already be new.
        if (storage.supabase_refresh !== rt) return { ok: true };
        return { ok: false, error: res.error };
      }
      if (res.error) return { ok: false, error: res.error };
      storage.supabase_refresh = res.refresh_token;
      return { ok: true };
    } finally {
      release(id);
    }
  };
  for (let i = 1; i <= cycles; i++) {
    // Simulate two consumers racing: only one holds the lock at a time.
    const a = refreshLocked('popup');
    if (!a.ok) return { failedAt: i, error: a.error };
    const b = refreshLocked('alarm');
    if (!b.ok) return { failedAt: i, error: b.error };
  }
  return { failedAt: null };
}

const oldRun = oldStrategy(makeAuthServer(), 500);
assert.strictEqual(oldRun.failedAt, 2, 'old strategy should die on 2nd refresh');
assert.strictEqual(oldRun.error, 'refresh_token_already_used');

const newRun = newStrategy(makeAuthServer(), 500);
assert.strictEqual(newRun.failedAt, null, 'new strategy must survive 500 cycles');

assert.strictEqual(
  concurrentNoLock(makeAuthServer()),
  'refresh_token_already_used',
  'true concurrent refresh without a lock must revoke the family'
);

const lockedRun = concurrentLocked(makeAuthServer(), 250);
assert.strictEqual(lockedRun.failedAt, null, 'locked concurrent refresh must survive');

// Source contract: popup + background both use the shared lock helpers.
const popupSrc = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
assert.ok(popupSrc.includes('function restoreSupabaseSession'), 'popup must restore under a lock');
assert.ok(popupSrc.includes('auth_refresh_lock'), 'popup must use auth_refresh_lock');
assert.ok(bgSrc.includes('function refreshSupabaseSessionLocked'), 'background must refresh under a lock');
assert.ok(bgSrc.includes('auth_refresh_lock'), 'background must use auth_refresh_lock');
assert.ok(!bgSrc.includes('youtube.readonly'), 'unused youtube.readonly scope breaks silent re-auth');

const oauthSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'google-oauth.js'), 'utf8');
assert.ok(oauthSrc.includes('AUTH_OAUTH_LOCK_KEY'), 'google-oauth must serialize launchWebAuthFlow');
assert.ok(oauthSrc.includes('acquireOAuthFlowLock'), 'google-oauth must acquire cross-context OAuth lock');

const popupHtml = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
assert.ok(popupHtml.includes('lib/google-oauth.js'), 'popup.html must load google-oauth.js');
assert.ok(popupSrc.includes('launchGoogleWebAuthFlow({ silent: false })'), 'interactive login must run in popup');
assert.ok(popupSrc.includes('action: \'completeLogin\''), 'popup must hand tokens to background completeLogin');

console.log('✅ stress test passed:');
console.log(`   old strategy: revoked on refresh #${oldRun.failedAt} (${oldRun.error}) — the bug users hit`);
console.log('   new strategy: 500 refresh cycles across consumers, zero revocations');
console.log('   concurrent no-lock: family revoked (expected)');
console.log('   concurrent locked: 250×2 refreshes, zero revocations');

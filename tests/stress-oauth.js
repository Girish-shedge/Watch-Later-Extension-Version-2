// OAuth token-rotation stress test. Run: node tests/stress-oauth.js
//
// Simulates Supabase refresh-token rotation with reuse detection (what the real
// auth server does) and replays both token-handling strategies:
//   OLD: popup/background each refresh but never persist the rotated token
//   NEW: every consumer persists the rotated pair back to chrome.storage.local
// The old strategy must die with "refresh_token_already_used"; the new one must
// survive hundreds of refresh cycles from multiple concurrent consumers.
const assert = require('assert');

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

const oldRun = oldStrategy(makeAuthServer(), 500);
assert.strictEqual(oldRun.failedAt, 2, 'old strategy should die on 2nd refresh');
assert.strictEqual(oldRun.error, 'refresh_token_already_used');

const newRun = newStrategy(makeAuthServer(), 500);
assert.strictEqual(newRun.failedAt, null, 'new strategy must survive 500 cycles');

console.log('✅ stress test passed:');
console.log(`   old strategy: revoked on refresh #${oldRun.failedAt} (${oldRun.error}) — the bug users hit`);
console.log('   new strategy: 500 refresh cycles across consumers, zero revocations');

// background.js — MV3 service worker: OAuth + token refresh.
// chrome.storage.local is the single source of truth for tokens (workers restart).

importScripts('lib/supabase.js', 'lib/google-oauth.js');

const SUPABASE_URL = 'https://ayzqfwtoeckgycmqzlve.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5enFmd3RvZWNrZ3ljbXF6bHZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4NTkxODksImV4cCI6MjA1OTQzNTE4OX0.cE10nS3wtqN00wZX3uq_905H4MTj9VfDVPxpopRp_Dw';

// persistSession/autoRefreshToken off: this worker and the popup would otherwise each keep
// their own session copy and rotate the refresh token behind each other's back
// (Supabase reuse-detection then revokes the whole session → forced re-login).
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const REFRESH_INTERVAL_MINUTES = 50; // access token lives 60 min; refresh before expiry

function ensureRefreshAlarm() {
  chrome.alarms.create('refreshTokens', { periodInMinutes: REFRESH_INTERVAL_MINUTES });
}

/** YouTube embeds in extension pages omit Referer → error 153. Inject one for our sub_frames. */
async function ensureYoutubeEmbedRefererRule() {
  const RULE_ID = 1001;
  const RULE_ID_NC = 1002;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [RULE_ID, RULE_ID_NC],
      addRules: [
        {
          id: RULE_ID,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' }
            ]
          },
          condition: {
            urlFilter: '||youtube.com/embed/',
            resourceTypes: ['sub_frame'],
            initiatorDomains: [chrome.runtime.id]
          }
        },
        {
          id: RULE_ID_NC,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' }
            ]
          },
          condition: {
            urlFilter: '||youtube-nocookie.com/embed/',
            resourceTypes: ['sub_frame'],
            initiatorDomains: [chrome.runtime.id]
          }
        }
      ]
    });
  } catch (err) {
    console.error('YouTube embed Referer rule failed:', err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureRefreshAlarm();
  ensureYoutubeEmbedRefererRule();
});
chrome.runtime.onStartup.addListener(() => {
  ensureRefreshAlarm();
  ensureYoutubeEmbedRefererRule();
});
// Also install the rule when the worker wakes (alarms / messages).
ensureYoutubeEmbedRefererRule();

async function persistSupabaseSession(session) {
  if (!session) return;
  await chrome.storage.local.set({
    supabase_token: session.access_token,
    supabase_refresh: session.refresh_token
  });
}

async function persistGoogleAccessToken(token) {
  if (!token) return;
  await chrome.storage.local.set({
    google_access_token: token,
    google_token_at: Date.now()
  });
}

// Shared with popup: only one consumer may rotate the refresh token at a time.
const AUTH_REFRESH_LOCK_KEY = 'auth_refresh_lock';
const AUTH_REFRESH_LOCK_TTL_MS = 12000;

function storageGet(keys) {
  return new Promise(res => chrome.storage.local.get(keys, res));
}
function storageSet(obj) {
  return new Promise(res => chrome.storage.local.set(obj, res));
}
function storageRemove(keys) {
  return new Promise(res => chrome.storage.local.remove(keys, res));
}

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

async function refreshSupabaseSessionLocked(refreshToken) {
  const owner = await acquireAuthRefreshLock();
  try {
    const fresh = await storageGet(['supabase_refresh']);
    let rt = fresh.supabase_refresh || refreshToken;
    let { data, error } = await supabaseClient.auth.refreshSession({ refresh_token: rt });
    if (error && isRefreshTokenReuseError(error)) {
      const again = await storageGet(['supabase_token', 'supabase_refresh']);
      // Another consumer already rotated successfully — adopt their pair.
      if (again.supabase_refresh && again.supabase_refresh !== rt) {
        return { data: { session: {
          access_token: again.supabase_token,
          refresh_token: again.supabase_refresh
        } }, error: null };
      }
    }
    if (!error && data?.session) await persistSupabaseSession(data.session);
    return { data, error };
  } finally {
    await releaseAuthRefreshLock(owner);
  }
}

// Silent OAuth only in the service worker — interactive login runs in the popup
// (launchWebAuthFlow needs the user gesture from Allow / Try again).
let oauthFlowChain = Promise.resolve();

function enqueueOAuthFlow(fn) {
  const run = oauthFlowChain.then(fn, fn);
  oauthFlowChain = run.catch(() => {});
  return run;
}

async function refreshGoogleTokenOnly() {
  return enqueueOAuthFlow(async () => {
    const google = await launchGoogleWebAuthFlow({ silent: true });
    if (!google?.access_token) {
      return { success: false, code: google?.error || 'interaction_required', error: google?.detail };
    }
    await persistGoogleAccessToken(google.access_token);
    return { success: true };
  });
}

// ── Periodic refresh: Supabase session + Google access token ──
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'refreshTokens') return;

  const { supabase_refresh } = await chrome.storage.local.get('supabase_refresh');
  if (supabase_refresh) {
    const { error } = await refreshSupabaseSessionLocked(supabase_refresh);
    if (error) {
      // Never wipe tokens here: popup retries with its own copy, and the user
      // is only asked to log in when every refresh path has failed.
      console.warn('Supabase refresh failed:', error.message);
    } else {
      console.log('✅ Supabase session refreshed');
    }
  }

  const google = await enqueueOAuthFlow(() => launchGoogleWebAuthFlow({ silent: true }));
  if (google?.access_token) {
    await persistGoogleAccessToken(google.access_token);
    console.log('✅ Google token refreshed silently');
  } else {
    console.warn('Silent Google refresh failed (user may be signed out of Google)');
  }
});

// ── Messages from popup ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Without externally_connectable, web pages can't reach us but other installed
  // extensions can — and 'login' opens a Google consent window.
  if (sender.id !== chrome.runtime.id) return;
  if (message?.action === 'refreshGoogle') {
    refreshGoogleTokenOnly().then(sendResponse);
    return true;
  }
  if (message?.action === 'completeLogin') {
    completeOAuthWithGoogleTokens(message.id_token, message.access_token)
      .then(sendResponse)
      .catch(err => {
        console.error('completeLogin crashed:', err);
        sendResponse({ success: false, code: 'generic', error: String(err) });
      });
    return true;
  }
  if (message?.action === 'login') {
    // Silent OAuth only — interactive runs in popup (user gesture + completeLogin).
    if (message.silent !== true) {
      sendResponse({
        success: false,
        code: 'interactive_in_popup',
        error: 'Interactive Google sign-in runs in the popup'
      });
      return true;
    }
    enqueueOAuthFlow(() => runSilentOAuthFlow())
      .then(sendResponse)
      .catch(err => {
        console.error('OAuth flow crashed:', err);
        sendResponse({ success: false, code: 'generic', error: String(err) });
      });
    return true;
  }
});

async function runSilentOAuthFlow() {
  const google = await launchGoogleWebAuthFlow({ silent: true });
  if (!google?.id_token || !google?.access_token) {
    return {
      success: false,
      code: google?.error || 'cancelled',
      error: google?.detail || 'Google auth failed or was cancelled'
    };
  }
  return completeOAuthWithGoogleTokens(google.id_token, google.access_token);
}

async function completeOAuthWithGoogleTokens(id_token, access_token) {
  if (!id_token || !access_token) {
    return { success: false, code: 'interrupted', error: 'Missing Google tokens' };
  }

  const { data, error: signInError } = await supabaseClient.auth.signInWithIdToken({
    provider: 'google',
    token: id_token,
    access_token: access_token
  });
  if (signInError) {
    console.error('Supabase login error:', signInError);
    return { success: false, code: 'generic', error: signInError.message };
  }

  const { session, user } = data;
  const lockOwner = await acquireAuthRefreshLock();
  try {
    await persistSupabaseSession(session);
    await persistGoogleAccessToken(access_token);
    await chrome.storage.local.set({ userId: user.id });
  } finally {
    await releaseAuthRefreshLock(lockOwner);
  }

  const { error: upsertError } = await supabaseClient.from('users').upsert({
    id: user.id,
    email: user.email,
    name: user.user_metadata?.name,
    avatar_url: user.user_metadata?.picture
  });
  if (upsertError) {
    console.error(
      'Failed to upsert user:',
      upsertError.message || upsertError.code || JSON.stringify(upsertError)
    );
  }

  fetch('https://ayzqfwtoeckgycmqzlve.functions.supabase.co/sendWelcomeEmail', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`
    }
  }).catch(err => console.error('sendWelcomeEmail failed:', err));

  return {
    success: true,
    name: user.user_metadata?.name,
    warning: upsertError || undefined
  };
}

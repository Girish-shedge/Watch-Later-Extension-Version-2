// background.js — MV3 service worker: OAuth + token refresh.
// chrome.storage.local is the single source of truth for tokens (workers restart).

importScripts('lib/supabase.js');

const SUPABASE_URL = 'https://ayzqfwtoeckgycmqzlve.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5enFmd3RvZWNrZ3ljbXF6bHZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4NTkxODksImV4cCI6MjA1OTQzNTE4OX0.cE10nS3wtqN00wZX3uq_905H4MTj9VfDVPxpopRp_Dw';

const GOOGLE_CLIENT_ID = '392838470948-g3utd3qn171c9tdgjevg27pceasan4gm.apps.googleusercontent.com';
const GOOGLE_SCOPES =
  'openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/youtube.readonly';

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

function encodeToken(token) {
  return btoa(unescape(encodeURIComponent(token)));
}

async function persistSupabaseSession(session) {
  if (!session) return;
  await chrome.storage.local.set({
    supabase_token: session.access_token,
    supabase_refresh: session.refresh_token
  });
}

// ── Google auth URL (implicit flow; used for login and silent refresh) ──
function buildGoogleAuthUrl({ silent }) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: chrome.identity.getRedirectURL(),
    response_type: 'token id_token',
    scope: GOOGLE_SCOPES,
    nonce: Math.random().toString(36).substring(2),
    prompt: silent ? 'none' : 'consent'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// Runs the web auth flow and returns { id_token, access_token } or null.
// silent:true uses prompt=none + interactive:false → no UI, works on Chrome AND Edge
// (chrome.identity.getAuthToken is Chrome-only, so we avoid it).
function googleAuthFlow({ silent }) {
  return new Promise(resolve => {
    chrome.identity.launchWebAuthFlow(
      { url: buildGoogleAuthUrl({ silent }), interactive: !silent },
      redirectUrl => {
        if (chrome.runtime.lastError || !redirectUrl) return resolve(null);
        const frag = new URLSearchParams(new URL(redirectUrl).hash.substring(1));
        const id_token = frag.get('id_token');
        const access_token = frag.get('access_token');
        resolve(id_token && access_token ? { id_token, access_token } : null);
      }
    );
  });
}

// ── Periodic refresh: Supabase session + Google access token ──
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'refreshTokens') return;

  const { supabase_refresh } = await chrome.storage.local.get('supabase_refresh');
  if (supabase_refresh) {
    const { data, error } = await supabaseClient.auth.refreshSession({
      refresh_token: supabase_refresh
    });
    if (error) {
      // Never wipe tokens here: popup retries with its own copy, and the user
      // is only asked to log in when every refresh path has failed.
      console.warn('Supabase refresh failed:', error.message);
    } else {
      await persistSupabaseSession(data.session);
      console.log('✅ Supabase session refreshed');
    }
  }

  const google = await googleAuthFlow({ silent: true });
  if (google) {
    await chrome.storage.local.set({ google_access_token: google.access_token });
    console.log('✅ Google token refreshed silently');
  } else {
    console.warn('Silent Google refresh failed (user may be signed out of Google)');
  }
});

// ── Messages from popup ──
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'login') {
    startOAuthFlow(sendResponse, { silent: !!message.silent });
    return true; // async response
  }
});

async function startOAuthFlow(sendResponse, { silent }) {
  try {
    const google = await googleAuthFlow({ silent });
    if (!google) {
      sendResponse({ success: false, error: 'Google auth failed or was cancelled' });
      return;
    }

    // Exchange the Google ID token for a Supabase session
    const { data, error: signInError } = await supabaseClient.auth.signInWithIdToken({
      provider: 'google',
      token: google.id_token,
      access_token: google.access_token
    });
    if (signInError) {
      console.error('Supabase login error:', signInError);
      sendResponse({ success: false, error: signInError.message });
      return;
    }

    const { session, user } = data;
    await persistSupabaseSession(session);
    await chrome.storage.local.set({
      google_access_token: google.access_token,
      userId: user.id
    });

    // Upsert profile (table is lowercase `users`; the old 'Users' upsert failed
    // silently for every new user and caused permanent re-login loops)
    const { error: upsertError } = await supabaseClient.from('users').upsert({
      id: user.id,
      email: user.email,
      name: user.user_metadata.name,
      avatar_url: user.user_metadata.picture
    });
    if (upsertError) console.error('Failed to upsert user:', upsertError);

    // Server-side token backup (base64-encoded, not encrypted — anon key + RLS scoped)
    const { error: tokenErr } = await supabaseClient.from('UserTokens').upsert({
      user_id: user.id,
      access_token: encodeToken(session.access_token),
      refresh_token: encodeToken(session.refresh_token)
    });
    if (tokenErr) console.warn('Could not store token backup:', tokenErr);

    sendResponse({
      success: true,
      name: user.user_metadata?.name, // onboarding scan screen greets by first name
      warning: upsertError || undefined
    });

    // One-time welcome email (Edge Function checks the welcome flag itself)
    fetch('https://ayzqfwtoeckgycmqzlve.functions.supabase.co/sendWelcomeEmail', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`
      }
    }).catch(err => console.error('sendWelcomeEmail failed:', err));
  } catch (err) {
    console.error('OAuth flow crashed:', err);
    sendResponse({ success: false, error: String(err) });
  }
}

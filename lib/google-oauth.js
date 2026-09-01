// Shared Google OAuth helpers — loaded by popup.html and background.js (importScripts).
var GOOGLE_CLIENT_ID = '392838470948-g3utd3qn171c9tdgjevg27pceasan4gm.apps.googleusercontent.com';
var GOOGLE_SCOPES =
  'openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly';

// Chrome allows only one launchWebAuthFlow at a time — serialize across popup + background.
var AUTH_OAUTH_LOCK_KEY = 'auth_oauth_lock';
var AUTH_OAUTH_LOCK_TTL_MS = 120000;

function oauthStorageGet(keys) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(keys, resolve);
  });
}
function oauthStorageSet(obj) {
  return new Promise(function (resolve) {
    chrome.storage.local.set(obj, resolve);
  });
}
function oauthStorageRemove(keys) {
  return new Promise(function (resolve) {
    chrome.storage.local.remove(keys, resolve);
  });
}

function acquireOAuthFlowLock() {
  var owner = crypto.randomUUID();
  function attempt(n) {
    if (n >= 100) return Promise.resolve(null);
    var now = Date.now();
    return oauthStorageGet([AUTH_OAUTH_LOCK_KEY]).then(function (cur) {
      var lock = cur[AUTH_OAUTH_LOCK_KEY];
      if (!lock || !lock.at || now - lock.at > AUTH_OAUTH_LOCK_TTL_MS) {
        var patch = {};
        patch[AUTH_OAUTH_LOCK_KEY] = { owner: owner, at: now };
        return oauthStorageSet(patch).then(function () {
          return oauthStorageGet([AUTH_OAUTH_LOCK_KEY]).then(function (check) {
            if (check[AUTH_OAUTH_LOCK_KEY] && check[AUTH_OAUTH_LOCK_KEY].owner === owner) return owner;
            return new Promise(function (r) {
              setTimeout(function () { r(attempt(n + 1)); }, 80);
            });
          });
        });
      }
      return new Promise(function (r) {
        setTimeout(function () { r(attempt(n + 1)); }, 80);
      });
    });
  }
  return attempt(0);
}

function releaseOAuthFlowLock(owner) {
  return oauthStorageGet([AUTH_OAUTH_LOCK_KEY]).then(function (cur) {
    if (cur[AUTH_OAUTH_LOCK_KEY] && cur[AUTH_OAUTH_LOCK_KEY].owner === owner) {
      return oauthStorageRemove([AUTH_OAUTH_LOCK_KEY]);
    }
  });
}

function buildGoogleAuthUrl(opts) {
  var silent = !!(opts && opts.silent);
  var params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: chrome.identity.getRedirectURL(),
    response_type: 'token id_token',
    scope: GOOGLE_SCOPES,
    nonce: crypto.randomUUID()
  });
  if (silent) params.set('prompt', 'none');
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

/** Parse launchWebAuthFlow callback → { id_token, access_token } or { error, detail }. */
function parseGoogleAuthRedirect(lastErrorMsg, redirectUrl) {
  if (lastErrorMsg || !redirectUrl) {
    var msg = lastErrorMsg || '';
    if (/only one web auth flow is allowed at a time/i.test(msg)) {
      return { error: 'flow_busy', detail: msg };
    }
    if (/could not be opened|blocked|user gesture/i.test(msg)) {
      return { error: 'popup_blocked', detail: msg };
    }
    return { error: 'cancelled', detail: msg || 'cancelled' };
  }
  var frag = new URLSearchParams(new URL(redirectUrl).hash.substring(1));
  var id_token = frag.get('id_token');
  var access_token = frag.get('access_token');
  var oauthErr = frag.get('error');
  if (oauthErr === 'access_denied') return { error: 'denied', detail: oauthErr };
  if (oauthErr === 'login_required' || oauthErr === 'interaction_required') {
    return { error: 'interaction_required', detail: oauthErr };
  }
  if (oauthErr) {
    return { error: /redirect/i.test(oauthErr) ? 'config' : 'generic', detail: oauthErr };
  }
  return id_token && access_token
    ? { id_token: id_token, access_token: access_token }
    : { error: 'interrupted' };
}

function launchGoogleWebAuthFlowRaw(opts) {
  var silent = !!(opts && opts.silent);
  var url = buildGoogleAuthUrl({ silent: silent });
  console.log('[auth] launchWebAuthFlow', silent ? 'silent' : 'interactive', chrome.identity.getRedirectURL());
  return new Promise(function (resolve) {
    chrome.identity.launchWebAuthFlow(
      { url: url, interactive: !silent },
      function (redirectUrl) {
        var le = chrome.runtime.lastError;
        var msg = le && le.message;
        // Chrome lists console.warn on chrome://extensions — skip expected cancel / busy.
        if (msg && !/only one web auth flow|user did not approve|canceled|cancelled/i.test(msg)) {
          console.warn('[auth] launchWebAuthFlow callback error:', msg);
        }
        resolve(parseGoogleAuthRedirect(msg, redirectUrl));
      }
    );
  });
}

/** Serialized launchWebAuthFlow — popup + background share one Chrome auth slot. */
function launchGoogleWebAuthFlow(opts) {
  return acquireOAuthFlowLock().then(function (owner) {
    if (!owner) {
      return { error: 'flow_busy', detail: 'Only one web auth flow is allowed at a time.' };
    }
    return launchGoogleWebAuthFlowRaw(opts).finally(function () {
      return releaseOAuthFlowLock(owner);
    });
  });
}

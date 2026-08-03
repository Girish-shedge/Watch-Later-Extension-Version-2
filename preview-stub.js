// Localhost / Cursor Simple Browser preview stub.
// Active on chrome.html, pop-up.html, or popup.html?preview=1.
// Mocks chrome.* so onboarding → mock login → schedule works without the extension.
(function () {
  const path = location.pathname || '';
  const isPreview =
    /(?:^|[?&])preview=1(?:&|$)/.test(location.search || '') ||
    /(?:^|\/)(chrome|pop-up)\.html$/i.test(path);

  window.__WL_PREVIEW__ = isPreview;
  if (!isPreview) return;

  // Start logged-out so preview mirrors first-run onboarding.
  const store = Object.create(null);

  const previewNames = ['Alex', 'Jordan', 'Sam', 'Riley', 'Casey'];
  const previewTabWatch = {
    id: 1,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'Preview: Watch Later Extension — schedule UI'
  };
  const previewTabHome = {
    id: 2,
    url: 'https://www.youtube.com/',
    title: 'YouTube'
  };
  let activeTab = previewTabWatch;

  function pick(keys) {
    if (keys == null) return { ...store };
    if (typeof keys === 'string') return { [keys]: store[keys] };
    if (Array.isArray(keys)) {
      const out = {};
      keys.forEach(k => { out[k] = store[k]; });
      return out;
    }
    const out = {};
    Object.keys(keys).forEach(k => { out[k] = store[k] !== undefined ? store[k] : keys[k]; });
    return out;
  }

  function mockLogin(silent) {
    if (silent && !store.supabase_token) {
      return { success: false, preview: true };
    }
    store.supabase_token = 'preview-token';
    store.supabase_refresh = 'preview-refresh';
    store.google_access_token = 'preview-google';
    store.userId = 'preview-user';
    const name = previewNames[Math.floor(Math.random() * previewNames.length)];
    return { success: true, preview: true, name };
  }

  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      getURL: (p) => {
      try { return new URL(p.replace(/^\//, ''), location.href).href; }
      catch (_) { return location.origin + (p.startsWith('/') ? p : '/' + p); }
    },
      id: 'preview',
      sendMessage: (msg, cb) => {
        let resp = { success: false, preview: true };
        if (msg?.action === 'login') {
          resp = mockLogin(!!msg.silent);
        }
        if (typeof cb === 'function') cb(resp);
        return Promise.resolve(resp);
      }
    },
    storage: {
      local: {
        get: (keys, cb) => {
          if (typeof keys === 'function') {
            keys({ ...store });
            return Promise.resolve({ ...store });
          }
          const out = pick(keys);
          if (typeof cb === 'function') cb(out);
          return Promise.resolve(out);
        },
        set: (obj, cb) => {
          Object.assign(store, obj);
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        },
        remove: (keys, cb) => {
          [].concat(keys).forEach(k => { delete store[k]; });
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        },
        clear: (cb) => {
          Object.keys(store).forEach(k => { delete store[k]; });
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        }
      }
    },
    tabs: {
      query: (_q, cb) => {
        const tabs = [activeTab];
        if (typeof cb === 'function') cb(tabs);
        return Promise.resolve(tabs);
      },
      create: (opts, cb) => {
        if (opts?.url) {
          activeTab = /watch\?v=/.test(opts.url) ? previewTabWatch : {
            id: 3,
            url: opts.url,
            title: opts.url
          };
        }
        if (typeof cb === 'function') cb(activeTab);
        return Promise.resolve(activeTab);
      },
      update: (id, opts, cb) => {
        if (opts?.url) {
          activeTab = /watch\?v=/.test(opts.url) ? previewTabWatch : {
            id: id || 3,
            url: opts.url,
            title: opts.url
          };
        }
        if (typeof cb === 'function') cb(activeTab);
        return Promise.resolve(activeTab);
      }
    },
    scripting: {
      executeScript: (opts, cb) => {
        let result = 754; // 12:34
        try {
          if (typeof opts?.func === 'function') {
            const r = opts.func();
            if (r != null) result = r;
          }
        } catch (_) { /* page DOM absent in preview */ }
        const payload = [{ result }];
        if (typeof cb === 'function') cb(payload);
        return Promise.resolve(payload);
      }
    }
  };

  // Optional: ?preview=wrongurl starts on a non-watch tab for wrong-URL UI after login
  if (/(?:^|[?&])wrongurl=1(?:&|$)/.test(location.search || '')) {
    activeTab = previewTabHome;
  }
})();

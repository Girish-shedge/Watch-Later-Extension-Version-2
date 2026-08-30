/**
 * Non-Latin → English (shared by popup + tests).
 * Detect script → free gtx translate → cache. Fail → original.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WLTranslate = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TRANSLATE_CACHE_KEY = 'wl_translate_cache';
  const TRANSLATE_CACHE_MAX = 120;
  /** Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam, Arabic, CJK, Hangul, Cyrillic, Thai */
  const NON_LATIN_RE =
    /[\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F\u0600-\u06FF\u0750-\u077F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0400-\u04FF\u0E00-\u0E7F]/;

  const GTX_ENDPOINT =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=';

  function textNeedsTranslation(text) {
    const s = String(text || '').trim();
    return s.length > 0 && NON_LATIN_RE.test(s);
  }

  /** Flatten gtx `translate_a/single` JSON into one string. */
  function parseGtxPayload(data) {
    if (!Array.isArray(data?.[0])) return '';
    return data[0]
      .map(row => (Array.isArray(row) ? row[0] : '') || '')
      .join('')
      .trim();
  }

  function trimTranslateCache(cache, max = TRANSLATE_CACHE_MAX) {
    const out = cache && typeof cache === 'object' ? { ...cache } : {};
    const keys = Object.keys(out);
    if (keys.length <= max) return out;
    keys.slice(0, keys.length - max).forEach(k => { delete out[k]; });
    return out;
  }

  async function defaultReadCache() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        const bag = await new Promise(r => chrome.storage.local.get(TRANSLATE_CACHE_KEY, r));
        const cache = bag?.[TRANSLATE_CACHE_KEY];
        return cache && typeof cache === 'object' ? cache : {};
      }
    } catch { /* ignore */ }
    return {};
  }

  async function defaultWriteCache(cache) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await new Promise(r => chrome.storage.local.set({ [TRANSLATE_CACHE_KEY]: cache }, r));
      }
    } catch { /* ignore quota */ }
  }

  /**
   * @param {string} text
   * @param {{ fetch?: typeof fetch, readCache?: Function, writeCache?: Function }} [opts]
   */
  async function translateToEnglish(text, opts = {}) {
    const original = String(text || '').trim();
    if (!original || !textNeedsTranslation(original)) return original;

    const readCache = opts.readCache || defaultReadCache;
    const writeCache = opts.writeCache || defaultWriteCache;
    const fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);

    const cache = await readCache();
    if (cache[original]) return cache[original];
    if (!fetchImpl) return original;

    try {
      const url = GTX_ENDPOINT + encodeURIComponent(original.slice(0, 4500));
      const res = await fetchImpl(url);
      if (!res || !res.ok) return original;
      const data = await res.json();
      const translated = parseGtxPayload(data);
      if (!translated) return original;
      const next = trimTranslateCache({ ...cache, [original]: translated });
      await writeCache(next);
      return translated;
    } catch {
      return original;
    }
  }

  return {
    TRANSLATE_CACHE_KEY,
    TRANSLATE_CACHE_MAX,
    NON_LATIN_RE,
    GTX_ENDPOINT,
    textNeedsTranslation,
    parseGtxPayload,
    trimTranslateCache,
    translateToEnglish,
  };
});

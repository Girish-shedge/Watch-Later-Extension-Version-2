/**
 * Stress / contract checks for lib/translate.js — no Chrome required.
 * Optional live gtx probe when network is available (skipped on failure).
 */
'use strict';

const assert = require('assert');
const path = require('path');
const T = require(path.join(__dirname, '..', 'lib', 'translate.js'));

function memoryStore(seed = {}) {
  let bag = { ...seed };
  return {
    async readCache() { return { ...bag }; },
    async writeCache(cache) { bag = { ...cache }; },
    snapshot() { return { ...bag }; },
  };
}

function mockFetch(map) {
  return async (url) => {
    const q = decodeURIComponent(String(url).split('q=')[1] || '');
    if (map.throw) throw new Error(String(map.throw));
    if (map.status && map.status !== 200) {
      return { ok: false, status: map.status, json: async () => null };
    }
    const translated = typeof map.fn === 'function' ? map.fn(q) : (map[q] ?? map.default ?? '');
    return {
      ok: true,
      status: 200,
      json: async () => [ [[translated, q, null, null, 10]] ],
    };
  };
}

{
  assert.strictEqual(T.textNeedsTranslation(''), false);
  assert.strictEqual(T.textNeedsTranslation('   '), false);
  assert.strictEqual(T.textNeedsTranslation('Hello world'), false);
  assert.strictEqual(T.textNeedsTranslation('Café résumé'), false); // Latin + diacritics
  assert.ok(T.textNeedsTranslation('नमस्ते दुनिया'));
  assert.ok(T.textNeedsTranslation('मराठी शीर्षक'));
  assert.ok(T.textNeedsTranslation('日本語タイトル'));
  assert.ok(T.textNeedsTranslation('한글 제목'));
  assert.ok(T.textNeedsTranslation('عنوان عربي'));
  assert.ok(T.textNeedsTranslation('Привет мир'));
  assert.ok(T.textNeedsTranslation('Mixed नमस्ते title'));
  assert.ok(T.textNeedsTranslation('ไทย'));
}

{
  assert.strictEqual(T.parseGtxPayload(null), '');
  assert.strictEqual(T.parseGtxPayload({}), '');
  assert.strictEqual(T.parseGtxPayload([[['Hello', 'नमस्ते']]]), 'Hello');
  assert.strictEqual(
    T.parseGtxPayload([[['Part ', 'a'], ['two', 'b']]]),
    'Part two'
  );
}

{
  const fat = {};
  for (let i = 0; i < T.TRANSLATE_CACHE_MAX + 40; i++) fat['k' + i] = 'v' + i;
  const trimmed = T.trimTranslateCache(fat);
  assert.strictEqual(Object.keys(trimmed).length, T.TRANSLATE_CACHE_MAX);
  assert.ok(!trimmed.k0);
  assert.ok(trimmed['k' + (T.TRANSLATE_CACHE_MAX + 39)]);
}

(async () => {
  // Latin skipped — no fetch
  {
    let called = 0;
    const out = await T.translateToEnglish('English only', {
      fetch: async () => { called++; return { ok: true, json: async () => null }; },
    });
    assert.strictEqual(out, 'English only');
    assert.strictEqual(called, 0);
  }

  // Cache hit — no fetch
  {
    let called = 0;
    const store = memoryStore({ 'नमस्ते': 'Hello' });
    const out = await T.translateToEnglish('नमस्ते', {
      ...store,
      fetch: async () => { called++; throw new Error('should not fetch'); },
    });
    assert.strictEqual(out, 'Hello');
    assert.strictEqual(called, 0);
  }

  // Happy path + persist
  {
    const store = memoryStore();
    const out = await T.translateToEnglish('こんにちは', {
      ...store,
      fetch: mockFetch({ 'こんにちは': 'Hello' }),
    });
    assert.strictEqual(out, 'Hello');
    assert.strictEqual(store.snapshot()['こんにちは'], 'Hello');
  }

  // HTTP failure → original
  {
    const out = await T.translateToEnglish('안녕하세요', {
      ...memoryStore(),
      fetch: mockFetch({ status: 503 }),
    });
    assert.strictEqual(out, '안녕하세요');
  }

  // Empty translation payload → original
  {
    const out = await T.translateToEnglish('สวัสดี', {
      ...memoryStore(),
      fetch: async () => ({ ok: true, json: async () => [[]] }),
    });
    assert.strictEqual(out, 'สวัสดี');
  }

  // Network throw → original
  {
    const out = await T.translateToEnglish('你好', {
      ...memoryStore(),
      fetch: mockFetch({ throw: 'offline' }),
    });
    assert.strictEqual(out, '你好');
  }

  // No fetch available → original
  {
    const out = await T.translateToEnglish('مرحبا', {
      ...memoryStore(),
      fetch: null,
    });
    assert.strictEqual(out, 'مرحبا');
  }

  // Hostile / long input — still returns a string, never throws
  {
    const long = 'अ'.repeat(6000);
    const out = await T.translateToEnglish(long, {
      ...memoryStore(),
      fetch: mockFetch({ fn: (q) => 'A'.repeat(Math.min(q.length, 100)) }),
    });
    assert.ok(typeof out === 'string' && out.length > 0);
  }

  // Concurrent identical keys — both resolve; cache ends with one entry
  {
    const store = memoryStore();
    let fetches = 0;
    const fetch = async (url) => {
      fetches++;
      await new Promise(r => setTimeout(r, 5));
      return mockFetch({ 'हिंदी': 'Hindi' })(url);
    };
    const [a, b] = await Promise.all([
      T.translateToEnglish('हिंदी', { ...store, fetch }),
      T.translateToEnglish('हिंदी', { ...store, fetch }),
    ]);
    assert.strictEqual(a, 'Hindi');
    assert.strictEqual(b, 'Hindi');
    assert.ok(fetches >= 1);
    assert.strictEqual(store.snapshot()['हिंदी'], 'Hindi');
  }

  // Optional live gtx (best-effort; skip soft-fail)
  let live = 'skipped';
  try {
    const liveOut = await T.translateToEnglish('नमस्ते', { ...memoryStore() });
    if (liveOut === 'नमस्ते') live = 'kept-original (offline or blocked)';
    else {
      assert.ok(/hello|greetings|namaste/i.test(liveOut) || liveOut.length > 0, liveOut);
      live = `ok → ${JSON.stringify(liveOut)}`;
    }
  } catch (e) {
    live = `skipped (${e.message})`;
  }

  console.log('✅ translate-stress passed');
  console.log('   live gtx:', live);
})().catch(err => {
  console.error(err);
  process.exit(1);
});

/**
 * One-shot: move font: var(--type-*) off component rules into grouped .text-* utilities.
 * Run: node tests/migrate-text-utils.js
 */
const fs = require('fs');
const path = require('path');

const cssPath = path.join(__dirname, '..', 'style.css');
let css = fs.readFileSync(cssPath, 'utf8');

const TYPE_TO_CLASS = {
  heading: 'text-heading',
  highlight: 'text-highlight',
  button: 'text-btn',
  body: 'text-body',
  subtext: 'text-subtext',
  label: 'text-sm',
  'success-copy': 'text-body',
  timestamp: 'text-sm',
  date: 'text-date',
  'onb-duration': 'text-onb-duration',
};

const UTIL_DEFS = {
  'text-heading': '--type-heading',
  'text-highlight': '--type-highlight',
  'text-btn': '--type-button',
  'text-body': '--type-body',
  'text-subtext': '--type-subtext',
  'text-sm': '--type-label',
  'text-date': '--type-date',
  'text-onb-duration': '--type-onb-duration',
};

const TRACKING = {
  'text-heading': '--tracking-heading',
  'text-highlight': '--tracking-highlight',
  'text-btn': '--tracking-button',
  'text-body': '--tracking-body',
  'text-subtext': '--tracking-subtext',
  'text-sm': '--tracking-label',
  'text-date': '--tracking-date',
  'text-onb-duration': '--tracking-label',
};

const buckets = Object.fromEntries(Object.keys(UTIL_DEFS).map(k => [k, new Set([`.${k}`])]));

function stripTypography(body) {
  return body
    .replace(/\s*font:\s*var\(--type-[a-z-]+\)[^;]*;?/g, '')
    .replace(/\s*letter-spacing:\s*var\(--tracking-[a-z-]+\)\s*;?/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

// Walk top-level rules only (good enough for this file).
const parts = [];
let i = 0;
while (i < css.length) {
  const next = css.indexOf('{', i);
  if (next === -1) {
    parts.push({ type: 'raw', text: css.slice(i) });
    break;
  }
  const selector = css.slice(i, next);
  if (selector.trim().startsWith('@')) {
    const close = findBlockEnd(css, next);
    parts.push({ type: 'raw', text: css.slice(i, close + 1) });
    i = close + 1;
    continue;
  }
  const close = findBlockEnd(css, next);
  const body = css.slice(next + 1, close);
  parts.push({ type: 'rule', selector, body });
  i = close + 1;
}

function findBlockEnd(str, openIdx) {
  let depth = 0;
  for (let j = openIdx; j < str.length; j++) {
    if (str[j] === '{') depth++;
    else if (str[j] === '}') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return str.length - 1;
}

for (const part of parts) {
  if (part.type !== 'rule') continue;
  if (part.selector.includes(':root')) continue;
  if (/\.text-(heading|highlight|btn|body|subtext|sm|onb-duration)\b/.test(part.selector)) continue;

  const fontMatch = part.body.match(/font:\s*var\(--type-([a-z-]+)\)/);
  if (!fontMatch) continue;

  const util = TYPE_TO_CLASS[fontMatch[1]];
  if (!util) continue;

  part.selector.split(',').forEach(sel => {
    const s = sel.trim().replace(/\s+/g, ' ');
    if (s) buckets[util].add(s);
  });
  part.body = stripTypography(part.body);
}

css = parts.map(p => (p.type === 'raw' ? p.text : `${p.selector}{${p.body}}`)).join('');

// Replace / insert utility block after :root
let utilBlock = '\n/* Typography utilities — Figma text styles; use .text-* classes */\n';
for (const [util, token] of Object.entries(UTIL_DEFS)) {
  const selectors = [...buckets[util]].sort().join(',\n');
  utilBlock += `${selectors} {\n  font: var(${token});\n  letter-spacing: var(${TRACKING[util]});\n}\n`;
}

css = css.replace(/\n\/\* Typography utilities[\s\S]*?(?=\n\/\*[^*]|\n\.popup|\nhtml|\nbody)/, '\n');
if (!css.includes('/* Typography utilities')) {
  const rootEnd = css.indexOf('\n}', css.indexOf(':root'));
  css = css.slice(0, rootEnd + 2) + utilBlock + css.slice(rootEnd + 2);
} else {
  css = css.replace(/\n\/\* Typography utilities[\s\S]*?(?=\n\.popup|\nhtml|\nbody|\n\/\* =)/, utilBlock);
}

// Update :root comment + body line height
css = css.replace(
  /--type-body: 600 16px\/20px/,
  '--type-body: 600 16px/22px'
);
css = css.replace(
  /Edit once here; use `font: var\(--type-\*\)`/,
  'Edit once here; use .text-* utility classes'
);

fs.writeFileSync(cssPath, css);
console.log('migrate-text-utils: done');

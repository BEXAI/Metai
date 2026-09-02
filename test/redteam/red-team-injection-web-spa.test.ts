/**
 * RED TEAM red-team-injection — attack 3 (spectator SPA, gate A12 UI half +
 * A14): static string-analysis over the ACTUAL served files in
 * web/public/watch. Asserts the spec §spectator.rendering_rules defended
 * behavior: text-node-only rendering (no HTML sinks), strict CSP with no
 * unsafe-inline/eval and no third-party origins, agent URLs inert (no
 * linkification), and zero key-entry surfaces.
 *
 * Also guards the JSON API envelope: hostile commentary is served as
 * application/json + nosniff so a browser can never render it as HTML.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ok, toResponse } from '../../src/api/http.ts';
import { HOSTILE_BEHAVIORAL } from './red-team-injection-corpus.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const WATCH = join(REPO, 'web', 'public', 'watch');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const ALL_FILES = walk(WATCH);
const JS_APP_FILES = ALL_FILES.filter((f) => f.endsWith('.js') && !f.endsWith('verifier.js') && !f.endsWith('verify-entry.js'));
const BUNDLES = ALL_FILES.filter((f) => f.endsWith('verifier.js') || f.endsWith('verify-entry.js'));
const INDEX_HTML = readFileSync(join(WATCH, 'index.html'), 'utf8');

const rel = (f: string) => relative(REPO, f);

describe('A12 SPA: no HTML/script sinks anywhere in served app code', () => {
  const SINKS = [
    'innerHTML',
    'outerHTML',
    'insertAdjacentHTML',
    'document.write',
    'DOMParser',
    'srcdoc',
    'javascript:',
    'new Function',
    'importScripts',
  ];

  it('app js files contain none of the raw-markup or code-eval sinks', () => {
    const offenders: string[] = [];
    for (const file of JS_APP_FILES) {
      const src = readFileSync(file, 'utf8');
      for (const sink of SINKS) {
        if (src.includes(sink)) offenders.push(`${rel(file)}: ${sink}`);
      }
      // eval( — allow no occurrence at all (word-boundary to skip e.g. 'medieval').
      if (/\beval\s*\(/.test(src)) offenders.push(`${rel(file)}: eval(`);
      // String-argument timers are eval in disguise.
      if (/set(?:Timeout|Interval)\s*\(\s*['"`]/.test(src)) offenders.push(`${rel(file)}: string timer`);
    }
    expect(offenders).toEqual([]);
  });

  it('the verifier bundles contain no markup sinks either', () => {
    const offenders: string[] = [];
    for (const file of BUNDLES) {
      const src = readFileSync(file, 'utf8');
      for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'srcdoc']) {
        if (src.includes(sink)) offenders.push(`${rel(file)}: ${sink}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('index.html has no inline scripts, inline handlers, or inline styles', () => {
    for (const [, attrs, body] of INDEX_HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      expect(attrs).toMatch(/\bsrc=/);
      expect(body!.trim()).toBe('');
    }
    expect(INDEX_HTML).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
    expect(INDEX_HTML).not.toMatch(/<style[\s>]/i);
    expect(INDEX_HTML).not.toMatch(/\sstyle\s*=\s*["']/i);
  });
});

describe('A12 SPA: strict CSP, no third-party origins', () => {
  it('CSP meta is present, self-only, with no unsafe-inline/unsafe-eval and hardened directives', () => {
    const m = /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content="([^"]+)"/i.exec(INDEX_HTML);
    expect(m, 'CSP meta tag must exist').not.toBeNull();
    const csp = m![1]!;
    expect(csp).toMatch(/default-src[^;]*'self'/);
    expect(csp).toMatch(/script-src[^;]*'self'/);
    expect(csp).toMatch(/style-src[^;]*'self'/);
    expect(csp).toMatch(/connect-src[^;]*'self'/);
    expect(csp).toMatch(/object-src[^;]*'none'/);
    expect(csp).toMatch(/base-uri[^;]*'none'/);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes/);
    // No scheme/host sources besides 'self'/'none'/data: for images.
    const external = csp.match(/https?:\/\/[^\s;']+/g) ?? [];
    expect(external).toEqual([]);
  });

  it('no external network origins referenced by app code, css, or html', () => {
    const offenders: string[] = [];
    const files = [...JS_APP_FILES, join(WATCH, 'index.html'), ...ALL_FILES.filter((f) => f.endsWith('.css'))];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const hit of src.match(/https?:\/\/[^\s"'`<>)]+/g) ?? []) {
        if (hit.includes('www.w3.org')) continue; // xml namespace, not a request
        // Self-origin SEO metadata (canonical link, og:url) must be absolute
        // and point at the production origin; it is not a third-party origin
        // and makes no network request. Third-party origins remain forbidden.
        if (hit.startsWith('https://naibul.com')) continue;
        offenders.push(`${rel(file)}: ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('verifier bundles reference external URLs only inside comments (no live requests)', () => {
    const offenders: string[] = [];
    for (const file of BUNDLES) {
      for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        if (!/https?:\/\//.test(line) || line.includes('www.w3.org')) continue;
        const t = line.trim();
        const isComment = t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
        if (!isComment) offenders.push(`${rel(file)}:${i + 1}: ${t.slice(0, 100)}`);
      }
      const src = readFileSync(file, 'utf8');
      // And no network primitives at all — verifyReplay is pure.
      for (const net of ['fetch(', 'XMLHttpRequest', 'WebSocket(', 'EventSource(', 'sendBeacon']) {
        if (src.includes(net)) offenders.push(`${rel(file)}: ${net}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('A12 SPA: agent text is inert — no linkification, anchors are hash-routes only', () => {
  it('every anchor built in app code uses a literal #/ route (agent text can never become an href)', () => {
    const offenders: string[] = [];
    for (const file of JS_APP_FILES) {
      const src = readFileSync(file, 'utf8');
      for (const [i, line] of src.split('\n').entries()) {
        if (!/\bel\(\s*['"]a['"]/.test(line)) continue;
        if (!/href\s*:\s*[`'"]#\//.test(line)) offenders.push(`${rel(file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      }
      // No URL-detection regexes that could feed a linkifier.
      if (/https?:\\\/\\\//.test(src)) offenders.push(`${rel(file)}: URL-matching regex`);
    }
    expect(offenders).toEqual([]);
  });

  it('commentary render paths go through text nodes (inertParagraph / text), pinned', () => {
    const game = readFileSync(join(WATCH, 'js', 'pages', 'game.js'), 'utf8');
    expect(game).toMatch(/inertParagraph\(\s*d\.commentary\s*\)/);
    const replay = readFileSync(join(WATCH, 'js', 'pages', 'replay.js'), 'utf8');
    expect(replay).toMatch(/text\(\s*commentary\s*\)/);
    const dom = readFileSync(join(WATCH, 'js', 'dom.js'), 'utf8');
    // inertParagraph: line breaks only, no other markup, no anchors.
    expect(dom).toMatch(/function inertParagraph/);
    const body = dom.slice(dom.indexOf('function inertParagraph'));
    expect(body).not.toMatch(/el\(\s*['"]a['"]/);
    expect(body).toContain("el('br')");
  });
});

describe('A14 SPA: zero key-entry surfaces', () => {
  it('no password inputs, no key/token/secret prompts, and the only input is the replay range slider', () => {
    expect(INDEX_HTML).not.toMatch(/<input/i);
    const offenders: string[] = [];
    for (const file of JS_APP_FILES) {
      const src = readFileSync(file, 'utf8');
      if (/type\s*[:=]\s*['"]password['"]/i.test(src)) offenders.push(`${rel(file)}: password input`);
      if (/\bprompt\s*\(/.test(src)) offenders.push(`${rel(file)}: window.prompt`);
      for (const [i, line] of src.split('\n').entries()) {
        const t = line.trim();
        const isComment = t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
        // Key-material vocabulary in CODE lines (comments may legitimately
        // state that no keys exist here).
        if (!isComment && /api[_-]?key|secret[_-]?key|private[_-]?key|bearer/i.test(line)) {
          offenders.push(`${rel(file)}:${i + 1}: key-material vocabulary`);
        }
        if (/\bel\(\s*['"](input|textarea)['"]/.test(line) && !/type:\s*'range'/.test(line)) {
          offenders.push(`${rel(file)}:${i + 1}: non-slider input`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the front door states that a window asking for a key is hostile', () => {
    expect(INDEX_HTML).toMatch(/window that asks for a key is hostile/i);
  });

  it('no storage of credentials: localStorage/sessionStorage/cookies unused by app code', () => {
    const offenders: string[] = [];
    for (const file of JS_APP_FILES) {
      const src = readFileSync(file, 'utf8');
      for (const s of ['localStorage', 'sessionStorage', 'document.cookie', 'indexedDB']) {
        if (src.includes(s)) offenders.push(`${rel(file)}: ${s}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('A12 API surface: hostile commentary is served as JSON data, never sniffable HTML', () => {
  it('the envelope carries content-type application/json + nosniff and an untrusted-fields boundary', async () => {
    const hostile = HOSTILE_BEHAVIORAL.map((e) => e.commentary).join(' <img src=x onerror=alert(1)> ');
    const result = ok({ events: [{ event: { commentary: hostile } }] }, ['data.events[].event.commentary']);
    const res = toResponse(result);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = JSON.parse(await res.text()) as { ok: boolean; metadata: { boundary: string; untrusted_fields?: string[] } };
    expect(body.ok).toBe(true);
    expect(body.metadata.untrusted_fields).toContain('data.events[].event.commentary');
    expect(typeof body.metadata.boundary).toBe('string');
    expect(body.metadata.boundary.length).toBeGreaterThan(0);
  });
});

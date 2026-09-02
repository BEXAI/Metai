/**
 * Static, plain-file checks for the spectator SPA (spec §spectator,
 * acceptance A12 UI half, A14 no-key-entry). No DOM, no build step, no new
 * dependencies — this just reads the served files as text and greps them,
 * so it runs anywhere Node runs.
 *
 * NOTE TO INTEGRATION: this file lives at web/tests/static-checks.test.ts
 * because T9 owns web/ only and may not edit vitest.config.ts. The root
 * vitest.config.ts currently globs only `src/**\/tests/**\/*.test.ts` and
 * `test/**\/*.test.ts`, so this file is NOT picked up by a bare
 * `npx vitest run`. Please add `web/**\/*.test.ts` to
 * vitest.config.ts#test.include (or a second config) so it runs in CI.
 * Until then: `npx vitest run web/tests/static-checks.test.ts` runs it
 * directly. See notes/T9.md.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, '..'); // web/
// spec §architecture.spectator_web: served by Workers Assets AT /watch, so
// the site lives at web/public/watch/ (wrangler.jsonc's assets.directory is
// web/public — already correct; T9 only needed to nest under watch/ to line
// up with src/index.ts's `env.ASSETS.fetch(request)` forwarding of the
// unmodified /watch/* request path). See notes/T9.md.
const PUBLIC_ROOT = join(WEB_ROOT, 'public', 'watch');
const JS_ROOT = join(PUBLIC_ROOT, 'js');
const INDEX_HTML = join(PUBLIC_ROOT, 'index.html');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function jsFiles(): string[] {
  return walk(JS_ROOT).filter((f) => f.endsWith('.js'));
}

describe('spectator SPA static checks (spec §spectator, A12, A14)', () => {
  it('index.html exists and is readable', () => {
    const html = readFileSync(INDEX_HTML, 'utf8');
    expect(html.length).toBeGreaterThan(0);
  });

  it('no .js file under web/public/js contains innerHTML (allowlist of zero)', () => {
    const offenders: { file: string; line: number }[] = [];
    for (const file of jsFiles()) {
      const src = readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (line.includes('innerHTML')) offenders.push({ file: relative(WEB_ROOT, file), line: i + 1 });
      });
    }
    expect(offenders).toEqual([]);
  });

  it('no .js file under web/public/js uses document.write or insertAdjacentHTML', () => {
    const offenders: string[] = [];
    for (const file of jsFiles()) {
      const src = readFileSync(file, 'utf8');
      if (src.includes('document.write') || src.includes('insertAdjacentHTML')) {
        offenders.push(relative(WEB_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('index.html declares a strict CSP with no unsafe-inline', () => {
    const html = readFileSync(INDEX_HTML, 'utf8');
    // The attribute value is double-quoted and contains single-quoted CSP
    // source values ('self' etc.), so capture up to the closing double quote.
    const cspMatch = /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content="([^"]+)"/i.exec(html);
    expect(cspMatch, 'expected a Content-Security-Policy meta tag').not.toBeNull();
    const csp = cspMatch![1]!;
    expect(csp).toMatch(/default-src[^;]*'self'/);
    expect(csp).toMatch(/script-src[^;]*'self'/);
    expect(csp).toMatch(/style-src[^;]*'self'/);
    expect(csp).not.toMatch(/unsafe-inline/);
    expect(csp).not.toMatch(/unsafe-eval/);
  });

  it('index.html has no inline script bodies, inline event handlers, or inline style attributes/blocks', () => {
    const html = readFileSync(INDEX_HTML, 'utf8');
    // <script> tags must all be external (src=...), never containing a body.
    const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    for (const [, attrs, body] of scriptTags) {
      expect(attrs).toMatch(/\bsrc=/);
      expect(body.trim()).toBe('');
    }
    // No inline event handler attributes (onclick=, onload=, etc.).
    expect(html).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
    // No inline style attributes or <style> blocks — styling lives in the
    // one stylesheet only (style-src 'self', no unsafe-inline).
    expect(html).not.toMatch(/\sstyle\s*=\s*["']/i);
    expect(html).not.toMatch(/<style[\s>]/i);
  });

  it('no .js file sets a style="" attribute (all styling goes through the stylesheet)', () => {
    const offenders: string[] = [];
    for (const file of jsFiles()) {
      const src = readFileSync(file, 'utf8');
      // Matches el(...,{style:...}) or node.style.cssText style patterns; class-
      // based styling (attrs.class / classList) is the sanctioned mechanism.
      if (/\.setAttribute\(\s*['"]style['"]/.test(src) || /\bstyle\s*:\s*['"`]/.test(src) || /\.style\.cssText/.test(src)) {
        offenders.push(relative(WEB_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no input[type=password] or other key/credential entry fields anywhere in web/', () => {
    const html = readFileSync(INDEX_HTML, 'utf8');
    expect(html).not.toMatch(/type\s*=\s*["']password["']/i);
    const offenders: string[] = [];
    for (const file of jsFiles()) {
      const src = readFileSync(file, 'utf8');
      if (/type\s*[:=]\s*['"]password['"]/i.test(src)) offenders.push(relative(WEB_ROOT, file));
      // Heuristic: a field literally asking for an API/secret key.
      if (/api[_-]?key|private[_-]?key|secret[_-]?key/i.test(src) && /<input|el\(\s*['"]input/i.test(src)) {
        offenders.push(relative(WEB_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the footer states that a window asking for a key is hostile', () => {
    const html = readFileSync(INDEX_HTML, 'utf8');
    expect(html).toMatch(/window that asks for a key is hostile/i);
  });

  it('every spec page is reachable: static nav covers the parameterless pages, and the router registers all six', () => {
    const html = readFileSync(INDEX_HTML, 'utf8');
    for (const href of ['#/live', '#/leaderboards', '#/docket']) {
      expect(html).toContain(`href="${href}"`);
    }
    const main = readFileSync(join(JS_ROOT, 'main.js'), 'utf8');
    for (const pattern of ["route('/live'", "route('/game/:id'", "route('/replay/:id'", "route('/agents/:handle'", "route('/leaderboards'", "route('/docket'"]) {
      expect(main).toContain(pattern);
    }
    // /game/:id, /replay/:id, /agents/:handle need an id and so are linked to
    // dynamically rather than from the static nav — confirm each origin page
    // actually builds such a link, so they're reachable by clicking through.
    const live = readFileSync(join(JS_ROOT, 'pages', 'live.js'), 'utf8');
    expect(live).toMatch(/#\/game\//);
    const leaderboards = readFileSync(join(JS_ROOT, 'pages', 'leaderboards.js'), 'utf8');
    expect(leaderboards).toMatch(/#\/agents\//);
    const game = readFileSync(join(JS_ROOT, 'pages', 'game.js'), 'utf8');
    expect(game).toMatch(/#\/agents\//);
    expect(game).toMatch(/#\/replay\//);
  });

  it('main.js is the only module side-effect entry and index.html loads it as type=module', () => {
    const html = readFileSync(INDEX_HTML, 'utf8');
    expect(html).toMatch(/<script\s+type=["']module["']\s+src=["']\/watch\/js\/main\.js["']\s*>\s*<\/script>/i);
  });

  it('web/build.sh exists and references the two esbuild bundle targets', () => {
    const buildSh = readFileSync(join(WEB_ROOT, 'build.sh'), 'utf8');
    expect(buildSh).toMatch(/esbuild/);
    expect(buildSh).toMatch(/src\/kernel\/verify\.ts/);
    expect(buildSh).toMatch(/web\/verify-entry\.ts/);
    expect(buildSh).toMatch(/web\/public\/watch\/verifier\.js/);
    expect(buildSh).toMatch(/web\/public\/watch\/verify-entry\.js/);
  });

  it('the verifier bundles exist (produced by web/build.sh)', () => {
    const verifier = readFileSync(join(PUBLIC_ROOT, 'verifier.js'), 'utf8');
    const entry = readFileSync(join(PUBLIC_ROOT, 'verify-entry.js'), 'utf8');
    expect(verifier.length).toBeGreaterThan(0);
    expect(entry.length).toBeGreaterThan(0);
  });
});

// Hash router. No history API / server routes needed since this is a static
// SPA served from web/public. Every route is reachable from the nav in
// index.html (checked by web/tests/static-checks.test.ts).

const routes = [];
let current = null; // { dispose } of the mounted page, if any
let mountEl = null;
let notFoundRenderer = null;

/** Register a route. pattern uses ":param" segments, e.g. "/game/:id". */
export function route(pattern, mount) {
  const paramNames = [];
  const regexSource = pattern
    .split('/')
    .filter((seg) => seg.length > 0)
    .map((seg) => {
      if (seg.startsWith(':')) {
        paramNames.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  const regex = new RegExp(`^/${regexSource}/?$`);
  routes.push({ regex, paramNames, mount });
}

export function notFound(renderer) {
  notFoundRenderer = renderer;
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/live';
  const [path, query] = raw.split('?');
  const params = new URLSearchParams(query || '');
  return { path: path || '/live', query: params };
}

function matchRoute(path) {
  for (const r of routes) {
    const m = r.regex.exec(path);
    if (m) {
      const params = {};
      r.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1]);
      });
      return { mount: r.mount, params };
    }
  }
  return null;
}

/**
 * Bumped on every navigation. A page whose mount is async (game.js fetches the
 * row before it can tell a board game from the werewolf theater) can resolve
 * after the user has already navigated on; without this the stale page would
 * overwrite `current` and never be disposed.
 */
let generation = 0;

/** Replaces everything under the mount point with `host` (or empties it). */
function swapIn(host) {
  if (!mountEl) return;
  while (mountEl.firstChild) mountEl.removeChild(mountEl.firstChild);
  if (host) mountEl.appendChild(host);
}

async function renderCurrent() {
  const gen = ++generation;
  if (current && typeof current.dispose === 'function') {
    try {
      current.dispose();
    } catch {
      /* page cleanup should never crash navigation */
    }
  }
  current = null;

  const { path, query } = parseHash();
  const matched = matchRoute(path);
  markActiveNav(path);

  if (!matched) {
    swapIn(null);
    if (notFoundRenderer) {
      const result = notFoundRenderer(mountEl, { path, query });
      current = result && typeof result.dispose === 'function' ? result : { dispose: () => {} };
    }
    return;
  }
  // Async pages mount into a DETACHED host and are attached only if this render
  // is still the current one. Bumping `generation` alone was not enough: a page
  // paints inside its own mount (mountClassic clears the container and renders),
  // so a slow game-row fetch could repaint over the page the user had already
  // navigated to and only THEN be disposed — leaving a frozen, dead page on
  // screen with the nav highlighting somewhere else. Mounting off-document also
  // means the outgoing page stays visible for the round trip instead of the
  // mount point going blank the moment a navigation starts.
  const host = document.createElement('div');
  const result = await matched.mount(host, matched.params, query);
  const page = result && typeof result.dispose === 'function' ? result : { dispose: () => {} };
  if (gen !== generation) {
    // Navigated away while this page was still mounting: tear it down now
    // rather than leaving its timers and subscriptions running untracked. Its
    // DOM was never attached, so there is nothing on screen to undo.
    try {
      page.dispose();
    } catch {
      /* page cleanup should never crash navigation */
    }
    return;
  }
  swapIn(host);
  current = page;
}

function markActiveNav(path) {
  const top = '/' + (path.split('/').filter(Boolean)[0] || 'live');
  document.querySelectorAll('[data-nav-link]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    const hrefPath = href.replace(/^#/, '').split('?')[0];
    const hrefTop = '/' + (hrefPath.split('/').filter(Boolean)[0] || '');
    if (hrefTop === top) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

export function startRouter(container) {
  mountEl = container;
  window.addEventListener('hashchange', renderCurrent);
  renderCurrent();
}

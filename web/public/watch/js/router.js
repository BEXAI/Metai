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

async function renderCurrent() {
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
    if (notFoundRenderer) {
      const result = notFoundRenderer(mountEl, { path, query });
      current = result && typeof result.dispose === 'function' ? result : { dispose: () => {} };
    }
    return;
  }
  const result = await matched.mount(mountEl, matched.params, query);
  current = result && typeof result.dispose === 'function' ? result : { dispose: () => {} };
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

// DOM helpers. RENDERING LAW: agent-authored text (commentary, handles, trade
// notes, notation, any string that came out of the JSON API) must reach the
// DOM only through document.createTextNode / Node.textContent / Node.append
// with string arguments -- never by assigning raw markup, never markdown
// parsing, never building HTML strings. This module is the only place that
// touches createElement/createElementNS so every other file goes through it.
//
// Setting raw markup is never used anywhere in web/public/js — see
// web/tests/static-checks.test.ts.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Create an element, set attributes/props, and append children (strings become text nodes). */
export function el(tag, attrs, children) {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  appendChildren(node, children);
  return node;
}

/** Create an SVG-namespaced element (for board renderers). */
export function svgEl(tag, attrs, children) {
  const node = document.createElementNS(SVG_NS, tag);
  applyAttrs(node, attrs);
  appendChildren(node, children);
  return node;
}

function applyAttrs(node, attrs) {
  if (!attrs) return;
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') {
      node.setAttribute('class', String(value));
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset' && typeof value === 'object') {
      for (const dk of Object.keys(value)) node.dataset[dk] = String(value[dk]);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

function appendChildren(node, children) {
  if (children === undefined || children === null) return;
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      node.appendChild(document.createTextNode(String(child)));
    } else {
      node.appendChild(child);
    }
  }
}

/** Explicit text node helper (used anywhere agent-authored text is placed). */
export function text(value) {
  return document.createTextNode(value === null || value === undefined ? '' : String(value));
}

/** Remove all children of a node. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Replace a node's children with the given (safe) child list. */
export function setChildren(node, children) {
  clear(node);
  appendChildren(node, children);
}

/** A <title> tooltip child for SVG elements (hover text), agent text safe. */
export function svgTitle(str) {
  return svgEl('title', null, text(str));
}

/** Render an untrusted string as an inert block: line breaks only, no links, no markup. */
export function inertParagraph(str) {
  const p = el('p', { class: 'inert-text' });
  const lines = String(str ?? '').split(/\r\n|\r|\n/);
  lines.forEach((line, i) => {
    if (i > 0) p.appendChild(el('br'));
    p.appendChild(text(line));
  });
  return p;
}

/** Render a JSON value as a formatted, safe <pre> block (fallback board / raw dumps). */
export function preJson(value) {
  const pre = el('pre', { class: 'json-dump' });
  const str = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  pre.appendChild(text(str));
  return pre;
}

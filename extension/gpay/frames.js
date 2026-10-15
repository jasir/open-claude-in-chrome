// Reading and clicking inside iframes, cross-origin included (fork jasir).
//
// content.js runs in the top frame only, so read_page/find never see what an
// iframe shows — and Google Pay renders everything inside a cross-origin
// payments.google.com iframe. scanFrame runs in EVERY frame
// (chrome.scripting.executeScript allFrames) and reports visible text,
// clickable elements and child iframe boxes in that frame's own viewport;
// assembleFrames then works out where each frame sits in the tab, so every
// element gets a top-level coordinate that computer/left_click can hit.

// MUST stay self-contained: chrome.scripting serializes it into each frame.
// With a nonce, each reported element is tagged data-ocic-gp="<nonce>-<n>"
// (an existing tag is kept) so clickMarked can later click exactly that
// element. Without one (find, read_page) the page DOM is left untouched.
export function scanFrame(nonce) {
  const visible = (el, r) => {
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
  };
  const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const label = (el) => clean(el.getAttribute("aria-label") || el.innerText || el.value || el.title || "").slice(0, 160);
  const SEL = [
    "button", "a[href]", "input:not([type=hidden])", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=option]", "[role=menuitem]", "[role=menuitemradio]",
    "[role=radio]", "[role=checkbox]", "[role=tab]", "[role=combobox]", "[role=listbox] > *",
    "[tabindex]:not([tabindex='-1'])", "[jsaction*='click']"
  ].join(",");
  const items = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const text = label(el);
    const key = `${text}|${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let mark = null;
    if (nonce) {
      mark = el.getAttribute("data-ocic-gp") || `${nonce}-${items.length}`;
      el.setAttribute("data-ocic-gp", mark);
    }
    items.push({
      mark,
      // Outside this frame's viewport: a DOM click still works, a coordinate click would miss.
      offscreen: r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth,
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      text,
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      w: Math.round(r.width),
      h: Math.round(r.height),
      disabled: !!(el.disabled || el.getAttribute("aria-disabled") === "true"),
      selected: el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-checked") === "true"
    });
    if (items.length >= 200) break;
  }
  const iframes = [...document.querySelectorAll("iframe, frame")].map((f) => {
    const r = f.getBoundingClientRect();
    const s = getComputedStyle(f);
    return {
      src: f.src,
      x: r.x + f.clientLeft + (parseFloat(s.paddingLeft) || 0),
      y: r.y + f.clientTop + (parseFloat(s.paddingTop) || 0),
      w: r.width,
      h: r.height,
      visible: visible(f, r)
    };
  });
  return {
    href: location.href,
    title: document.title,
    text: String(document.body ? document.body.innerText : "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000),
    items,
    iframes,
    vw: innerWidth,
    vh: innerHeight
  };
}

// Click an element tagged by scanFrame, in its own frame (run via
// chrome.scripting with frameIds). A DOM click, not input: it needs no
// hit-testing (immune to Google Pay's slow animations in a background tab) and
// does not go through the browser's input path, so the window is never
// activated. Google Pay accepts it for the card row, the card list and
// "Zaplatit" (verified 2026-10-16, TEST environment).
export function clickMarked(mark) {
  const el = document.querySelector(`[data-ocic-gp="${mark}"]`);
  if (!el) return false;
  el.click();
  return true;
}

const urlKey = (u) => {
  try { const x = new URL(u); return x.origin + x.pathname; } catch { return ""; }
};

/**
 * Place every scanned frame in the tab. `results` are chrome.scripting
 * InjectionResults ({ frameId, result }). A child frame is matched to a
 * visible iframe slot in an already placed frame by origin+path of its URL;
 * a frame that matches nothing takes the only remaining visible slot, if
 * there is exactly one. Frames that cannot be placed (hidden iframes, which
 * show nothing anyway) are dropped. Item coordinates come back top-level.
 */
export function assembleFrames(results) {
  const frames = (results || [])
    .filter((r) => r && r.result && typeof r.result === "object")
    .map((r) => ({ frameId: r.frameId, ...r.result, placed: false }));
  const root = frames.find((f) => f.frameId === 0);
  if (!root) return [];
  Object.assign(root, { placed: true, ox: 0, oy: 0, depth: 0 });

  const freeSlots = [];
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift();
    for (const slot of parent.iframes || []) {
      if (!slot.visible) continue;
      const child = frames.find((f) => !f.placed && urlKey(f.href) && urlKey(f.href) === urlKey(slot.src));
      if (!child) { freeSlots.push({ parent, slot }); continue; }
      Object.assign(child, { placed: true, ox: parent.ox + slot.x, oy: parent.oy + slot.y, depth: parent.depth + 1 });
      queue.push(child);
    }
    if (!queue.length) {
      const orphans = frames.filter((f) => !f.placed && (f.items?.length || f.text));
      if (orphans.length === 1 && freeSlots.length === 1) {
        const { parent: p, slot } = freeSlots.pop();
        Object.assign(orphans[0], { placed: true, ox: p.ox + slot.x, oy: p.oy + slot.y, depth: p.depth + 1 });
        queue.push(orphans[0]);
      }
    }
  }

  return frames
    .filter((f) => f.placed)
    .sort((a, b) => a.depth - b.depth)
    .map((f) => ({
      frameId: f.frameId,
      href: f.href,
      title: f.title,
      text: f.text,
      depth: f.depth,
      items: (f.items || []).map((i) => ({ ...i, frameId: f.frameId, x: Math.round(i.x + f.ox), y: Math.round(i.y + f.oy) }))
    }));
}

const norm = (t) => String(t || "").toLowerCase().replace(/[•·∙*]+/g, "•").replace(/\s+/g, " ").trim();

/**
 * Pick the clickable item whose text best matches `query`: exact text first,
 * then the shortest text containing it. Disabled items lose to enabled ones.
 */
export function matchItem(frames, query, { filter } = {}) {
  const q = norm(query);
  if (!q) return null;
  const all = frames.flatMap((f) => f.items.map((i) => ({ ...i, frameHref: f.href })));
  const hits = all.filter((i) => norm(i.text).includes(q) && (!filter || filter(i)));
  if (!hits.length) return null;
  hits.sort((a, b) =>
    (Number(!!a.disabled) - Number(!!b.disabled)) ||
    (Number(norm(b.text) === q) - Number(norm(a.text) === q)) ||
    (a.text.length - b.text.length));
  return hits[0];
}

/** Text form of assembled frames for read_page(frames) and the gpay tool. */
export function formatFrames(frames, { skipRoot = false, maxText = 1500 } = {}) {
  const out = [];
  for (const f of frames) {
    if (skipRoot && f.depth === 0) continue;
    if (!f.items.length && !f.text) continue;
    let origin = f.href;
    try { const u = new URL(f.href); origin = u.origin + u.pathname; } catch {}
    out.push(`--- frame ${f.depth === 0 ? "(top)" : origin} ---`);
    if (f.text) out.push(f.text.slice(0, maxText));
    for (const i of f.items) {
      const flags = [i.disabled ? "disabled" : "", i.selected ? "selected" : "", i.offscreen ? "offscreen" : ""].filter(Boolean).join(",");
      out.push(`  [${i.role}] "${i.text.slice(0, 100)}" at (${i.x}, ${i.y})${flags ? ` (${flags})` : ""}`);
    }
  }
  return out.join("\n");
}

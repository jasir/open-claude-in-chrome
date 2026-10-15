// Google Pay without the browser's payment sheet (fork jasir).
//
// The payment sheet that PaymentRequest opens cannot be driven by an agent:
// Chromium refuses to show it unless the browser window is the OS-active
// window (payment_request.cc: IsBrowserWindowActive -> "Cannot show
// PaymentRequest UI in a preview page or a background tab."), and the sheet is
// browser UI that CDP neither sees nor clicks.
//
// Google's pay.js has a second path for browsers without PaymentRequest: it
// opens pay.google.com with window.open and talks to it by postMessage. That
// page is an ordinary tab, so the agent can read and click it like any other.
// This shim, installed before page scripts (Page.addScriptToEvaluateOnNewDocument)
// only in tabs the agent drives and only on the configured sites, steers pay.js
// onto that path:
//   - hides PaymentRequest, so pay.js picks the window.open path;
//   - opens pay.google.com as a TAB (no window features) instead of a popup
//     window, so it lands in the agent's tab group;
//   - pay.js calls window.open twice with the same name (a "loading" page, then
//     the real URL); the second call navigates the existing tab instead,
//     because window.open onto an existing named window focuses it;
//   - returns the REAL window object both times: pay.js matches the messages
//     from pay.google.com by event.source === its window, so a wrapper (e.g. a
//     Proxy that swallows focus()) makes it ignore the handshake and Google
//     shows "pop-ups are probably blocked" (OR_BIBED_15; verified 2026-10-16);
//   - reports each new Google Pay tab through the CDP binding __ocicGpayOpen,
//     so the native host can hand the operator's focus back (the first
//     window.open still activates the browser window; nothing in the page can
//     prevent that).
//
// MUST stay self-contained: it is serialized with Function.prototype.toString
// and evaluated in the page's main world.
export function gpayShim(sites) {
  const host = location.hostname;
  if (!sites.some((s) => host === s || host.endsWith("." + s))) return "skip";
  if (window.__ocicGpayShim) return "already";
  // pay.js picks its path when it loads. Hiding PaymentRequest under an
  // already loaded pay.js only makes its next call throw, so leave such a page
  // alone; it gets the shim on its next load.
  if (window.google && window.google.payments) return "late";
  Object.defineProperty(window, "__ocicGpayShim", { value: true });

  try { delete window.PaymentRequest; } catch {}
  try {
    if (window.PaymentRequest) {
      Object.defineProperty(window, "PaymentRequest", { value: undefined, configurable: true, writable: true });
    }
  } catch {}

  const nativeOpen = window.open;
  const named = new Map(); // window name -> window
  const isGpay = (u) => {
    try { return new URL(String(u), location.href).hostname === "pay.google.com"; } catch { return false; }
  };
  const signal = () => {
    try { if (typeof window.__ocicGpayOpen === "function") window.__ocicGpayOpen(location.href); } catch {}
  };
  window.open = function (url, name, features) {
    if (!isGpay(url)) return nativeOpen.apply(this, arguments);
    // Reserved targets (_blank, _self, ...) are not window names.
    const key = name && !String(name).startsWith("_") ? String(name) : "";
    const known = key && named.get(key);
    if (known && !known.closed) {
      known.location.href = new URL(String(url), location.href).href;
      return known;
    }
    signal();
    const win = nativeOpen.call(window, url, key || "_blank");
    if (win && key) named.set(key, win);
    return win;
  };
  return "installed";
}

export const GPAY_BINDING = "__ocicGpayOpen";
export const DEFAULT_GPAY_SITES = ["kosik.cz"];

/** The configured site list, normalized: array of host suffixes, [] = off. */
export function normalizeGpaySites(value) {
  if (value === undefined || value === null) return DEFAULT_GPAY_SITES.slice();
  if (value === false || value === "off") return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return list.map((s) => String(s).trim().toLowerCase().replace(/^\*?\./, "")).filter(Boolean);
}

export function hostMatches(url, sites) {
  let host = "";
  try { host = new URL(url).hostname; } catch { return false; }
  return sites.some((s) => host === s || host.endsWith("." + s));
}

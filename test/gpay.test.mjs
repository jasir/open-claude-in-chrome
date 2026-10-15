// Google Pay as a tab (fork jasir): the page shim, frame placement and item
// matching from extension/gpay/.
import { gpayShim, normalizeGpaySites, hostMatches } from "../extension/gpay/shim.js";
import { assembleFrames, matchItem, formatFrames } from "../extension/gpay/frames.js";
let fail = 0; const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

// --- settings ---
ok(JSON.stringify(normalizeGpaySites(undefined)) === '["kosik.cz"]', "default site list is kosik.cz");
ok(normalizeGpaySites("off").length === 0 && normalizeGpaySites(false).length === 0, "off disables");
ok(JSON.stringify(normalizeGpaySites(" Kosik.cz, *.localhost ")) === '["kosik.cz","localhost"]', "comma string normalized");
ok(hostMatches("https://www.kosik.cz/cashdesk", ["kosik.cz"]), "subdomain matches");
ok(!hostMatches("https://notkosik.cz/", ["kosik.cz"]), "suffix must be a whole label");
ok(hostMatches("http://localhost:8765/x", ["localhost"]), "port ignored");

// --- shim, against a fake page window ---
function fakePage(hostname) {
  const opened = [];
  const win = {
    PaymentRequest: function PaymentRequest() {},
    open(url, name, features) {
      const w = { url, name, features, closed: false, focused: 0, location: { href: url }, focus() { this.focused++; }, postMessage(m) { this.last = m; return this; } };
      opened.push(w);
      return w;
    }
  };
  win.location = { hostname, href: `https://${hostname}/cashdesk` };
  return { win, opened };
}
// The shim reads `window`/`location` lazily (inside window.open too), so the
// fake page stays installed as the global for as long as it is exercised.
function runShim(page, sites) {
  Object.defineProperty(globalThis, "window", { value: page.win, configurable: true, writable: true });
  Object.defineProperty(globalThis, "location", { value: page.win.location, configurable: true, writable: true });
  return gpayShim(sites);
}

{
  const p = fakePage("www.example.com");
  ok(runShim(p, ["kosik.cz"]) === "skip", "other sites untouched");
  ok(typeof p.win.PaymentRequest === "function", "PaymentRequest kept on other sites");
}
{
  const p = fakePage("www.kosik.cz");
  const signals = [];
  p.win.__ocicGpayOpen = (s) => signals.push(s);
  ok(runShim(p, ["kosik.cz"]) === "installed", "installs on kosik.cz");
  ok(runShim(p, ["kosik.cz"]) === "already", "second install is a no-op");
  ok(!p.win.PaymentRequest, "PaymentRequest hidden");

  const other = p.win.open("https://www.kosik.cz/help", "x", "width=10");
  ok(p.opened.length === 1 && other.features === "width=10", "non-Google-Pay window.open passes through unchanged");

  const w1 = p.win.open("https://pay.google.com/gp/p/loading", "gp-js-popup-1", "width=600,height=600");
  const real = p.opened[1];
  ok(p.opened.length === 2 && real.features === undefined, "Google Pay opens without features (a tab, not a popup)");
  ok(real.name === "gp-js-popup-1", "window name preserved (pay.js finds it by name)");
  ok(signals.length === 1, "binding signalled once");
  ok(w1 === real, "returns the real window (pay.js matches event.source against it)");

  const w2 = p.win.open("https://pay.google.com/gp/p/ui/pay?x=1", "gp-js-popup-1", "width=600");
  ok(p.opened.length === 2, "second open with the same name does not call window.open again");
  ok(real.location.href === "https://pay.google.com/gp/p/ui/pay?x=1", "...it navigates the existing tab");
  ok(w2 === w1, "...and returns the same window object");
  ok(signals.length === 1, "no second signal for the navigation");

  const b1 = p.win.open("https://pay.google.com/x", "_blank");
  const b2 = p.win.open("https://pay.google.com/y", "_blank");
  ok(b1 !== b2 && p.opened.length === 4, "_blank is not a window name: every call opens its own tab");

  real.closed = true;
  p.win.open("https://pay.google.com/gp/p/loading", "gp-js-popup-1", "width=600");
  ok(p.opened.length === 5 && signals.length === 4, "after the tab closed, a new one is opened and signalled");
}

{
  const p = fakePage("www.kosik.cz");
  p.win.google = { payments: { api: {} } };
  ok(runShim(p, ["kosik.cz"]) === "late", "pay.js already loaded -> shim stays out");
  ok(typeof p.win.PaymentRequest === "function", "...and leaves PaymentRequest for the loaded pay.js");
}

// --- frame placement ---
const results = [
  { frameId: 0, result: { href: "https://pay.google.com/gp/p/ui/pay?ng=true", text: "", items: [],
    iframes: [
      { src: "https://payments.google.com/gp/w/u/0/buyflow2?tc=1", x: 1294, y: 0, w: 608, h: 352, visible: true },
      { src: "https://payments.google.com/gp/w/u/0/modaliframe?x", x: 0, y: 0, w: 0, h: 0, visible: false }
    ] } },
  { frameId: 7, result: { href: "https://payments.google.com/gp/w/u/0/buyflow2?tc=1&other", text: "Test Card: Visa\nVisa ••1111\nZaplatit",
    items: [
      { role: "button", text: "Test Card: Visa Visa ••1111", x: 304, y: 112, w: 560, h: 76 },
      { role: "button", text: "Zaplatit", x: 304, y: 283, w: 560, h: 40 }
    ], iframes: [] } },
  { frameId: 9, result: { href: "https://payments.google.com/gp/w/u/0/modaliframe?x", text: "", items: [], iframes: [] } }
];
const frames = assembleFrames(results);
ok(frames.length === 2, "hidden iframe dropped, visible one placed");
const pay = frames[1].items.find((i) => i.text === "Zaplatit");
ok(pay.x === 1294 + 304 && pay.y === 283, "child coordinates shifted to the top level");
ok(pay.frameId === 7, "items remember their frame (DOM clicks run there)");

// orphan fallback: child URL does not match the iframe src (redirect)
const orphan = assembleFrames([
  { frameId: 0, result: { href: "https://a.test/", items: [], iframes: [{ src: "https://b.test/start", x: 10, y: 20, w: 100, h: 100, visible: true }] } },
  { frameId: 3, result: { href: "https://c.test/after-redirect", text: "x", items: [{ role: "button", text: "OK", x: 5, y: 5 }], iframes: [] } }
]);
ok(orphan.length === 2 && orphan[1].items[0].x === 15 && orphan[1].items[0].y === 25, "unmatched frame takes the only free visible slot");

// --- matching ---
const list = [{ depth: 1, href: "h", items: [
  { role: "option", text: "Airbank Visa ••••5729", x: 1, y: 1 },
  { role: "option", text: "Společný účet Mastercard ••4597", x: 2, y: 2 },
  { role: "button", text: "Zaplatit", x: 3, y: 3, disabled: true },
  { role: "button", text: "Zaplatit", x: 4, y: 4 },
  { role: "button", text: "Zaplatit později", x: 5, y: 5 }
] }];
ok(matchItem(list, "5729").x === 1, "card by last digits");
ok(matchItem(list, "společný").x === 2, "case-insensitive with diacritics");
ok(matchItem(list, "Zaplatit").x === 4, "exact text wins, disabled loses");
ok(matchItem(list, "nic") === null, "no match -> null");
ok(formatFrames(frames).includes('"Zaplatit" at (1598, 283)'), "formatted output carries top-level coordinates");

if (fail) { console.log(`\n${fail} FAILED`); process.exit(1); }
console.log("\nall passed");

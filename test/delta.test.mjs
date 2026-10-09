// Change-only reads (fork jasir): read_page delta:true and screenshot
// if_changed:true, running the SHIPPED code from extension/background.js.
import { extractMethod, extractFunction, compile } from "./_extract.mjs";
let fail = 0; const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const treeDelta = compile(extractFunction("treeDelta"), {}, "treeDelta");
const hashString = compile(extractFunction("hashString"), {}, "hashString");

// --- treeDelta ---
const lines = Array.from({ length: 200 }, (_, i) => `[ref_${i + 1}] item "Produkt ${i + 1}"`);
const base = lines.join("\n");
const changed = lines.map((l, i) => (i === 50 ? '[ref_51] item "Košík (4)"' : l)).join("\n");
const d = treeDelta(base, changed);
ok(d && d.includes('- [ref_51] item "Produkt 51"') && d.includes('+ [ref_51] item "Košík (4)"'), "one changed line shows as - / +");
ok(d && d.includes("1 removed, 1 added"), "counts removed/added");
ok(d && d.length < changed.length / 10, "delta is much smaller than the full tree");
const inserted = [...lines.slice(0, 10), "[ref_999] dialog \"Přidáno\"", ...lines.slice(10)].join("\n");
const d2 = treeDelta(base, inserted);
ok(d2 && d2.includes('+ [ref_999] dialog "Přidáno"') && d2.includes("0 removed, 1 added"), "pure insertion");
const other = Array.from({ length: 200 }, (_, i) => `[ref_${i + 500}] other ${i}`).join("\n");
ok(treeDelta(base, other) === null, "mostly different page -> null (caller sends full tree)");

// --- hashString ---
ok(hashString("abc") === hashString("abc"), "hash stable");
ok(hashString("abc") !== hashString("abd"), "hash differs on change");

// --- read_page handler ---
let pageTree = base;
let tabUrl = "https://www.kosik.cz/";
const deps = {
  chrome: { tabs: { get: async () => ({ url: tabUrl }) } },
  isInGroup: async () => true,
  sendContentMessage: async () => ({ result: pageTree }),
  ensureAttached: async () => {},
  cdp: async () => ({ result: { value: "1280x800" } }),
  lastPageTrees: new Map(),
  treeDelta,
};
const H = compile(`const H = { ${extractMethod("read_page")} };`, deps, "H");
const txt = async (a) => (await H.read_page({ tabId: 1, ...a })).content[0].text;

ok((await txt({ delta: true })).startsWith("(delta: no previous"), "first delta call returns full tree with note");
ok((await txt({ delta: true })).startsWith("Unchanged since previous read_page"), "identical page -> Unchanged");
pageTree = changed;
const t3 = await txt({ delta: true });
ok(t3.startsWith("Delta vs previous") && t3.includes("Košík (4)") && t3.includes("Viewport: 1280x800"), "changed page -> delta + viewport");
tabUrl = "https://www.kosik.cz/kosik";
ok((await txt({ delta: true })).startsWith("(delta: URL or read options changed"), "navigation -> full tree");
ok((await txt({ delta: true, filter: "interactive" })).startsWith("(delta: URL or read options changed"), "other filter -> full tree");
ok((await txt({})).startsWith("[ref_1]"), "without delta behaves as before");

ok(d && d.includes("@@ line 51 @@"), "delta marks the position of a change");

// truncated and error outputs are never reported as Unchanged / diffed
tabUrl = "https://www.kosik.cz/trunc";
pageTree = base + "\n... (truncated)";
await txt({ delta: true });
ok((await txt({ delta: true })).startsWith("(delta: output truncated"), "truncated tree -> full tree, not Unchanged");
pageTree = 'Error: ref_id "ref_x" not found or element was garbage collected.';
await txt({ delta: true });
ok((await txt({ delta: true })).startsWith("Error:"), "error string is passed through, not Unchanged");

// --- screenshot dedupe (if_changed) ---
const screenshotStore = new Map();
const dedupe = compile(extractFunction("dedupeScreenshot"),
  { screenshotStore, lastShotHashes: new Map(), hashString }, "dedupeScreenshot");
screenshotStore.set("A", "img1");
ok(dedupe(1, "img1", "A") === null, "first screenshot -> sent");
for (let k = 0; k < 12; k++) {
  screenshotStore.set("dup" + k, "img1");
  ok(dedupe(1, "img1", "dup" + k) === "A", `identical screenshot #${k + 1} -> earlier ID A`);
  screenshotStore.set("other" + k, "x"); // other tabs' captures keep arriving
  while (screenshotStore.size > 10) screenshotStore.delete(screenshotStore.keys().next().value);
}
ok(screenshotStore.has("A") && !screenshotStore.has("dup0"), "earlier image stays stored, duplicates dropped");
screenshotStore.set("B", "img2");
ok(dedupe(1, "img2", "B") === null, "changed image -> sent");
screenshotStore.clear(); screenshotStore.set("C", "img2");
ok(dedupe(1, "img2", "C") === null, "earlier image evicted -> sent again, not a dangling ID");

import fs from "node:fs";
import { BACKGROUND } from "./_extract.mjs";
const src = fs.readFileSync(BACKGROUND, "utf8");
ok(/args\.if_changed && prevShotId/.test(src), "screenshot honours if_changed");
ok(/lastPageTrees\.delete\(tabId\)/.test(src) && /lastShotHashes\.delete\(tabId\)/.test(src), "per-tab caches cleared on tab close");

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);

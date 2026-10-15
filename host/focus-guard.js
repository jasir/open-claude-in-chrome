// Focus guard (fork jasir): give the operator's window focus back when the
// browser grabs it during automation.
//
// Why this exists: Chromium activates the browser window whenever a page opens
// a tab or window with window.open (BrowserView::Show -> Activate), even a
// background tab in an unfocused window. The Google Pay flow needs exactly that
// (pay.js opens pay.google.com), so without this the person at the keyboard
// loses focus to the browser in the middle of their own work. We cannot stop
// the activation, but we can undo it ~0.1 s later.
//
// Protocol (two native messages from the extension):
//   focus_guard_arm    { ms, needSignal } — sent BEFORE an input action. Records
//                      the currently active X window and watches activations
//                      for `ms`.
//   focus_guard_signal {}                 — the page really did open a Google
//                      Pay window (see extension/gpay/shim.js).
// With needSignal the guard restores only after a signal, so a person who
// switches to the browser on their own while an agent is clicking is never
// yanked back. A restore happens at most once per arm, only when the window
// that became active belongs to OUR browser process (its _NET_WM_PID is our
// parent pid), and only back to the window that was active at arm time.
//
// X11 only (xdotool + xprop). Without them every call reports ok:false and
// nothing else changes.

import { execFile, spawn } from "node:child_process";

function defaultExec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 1000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

// Watch _NET_ACTIVE_WINDOW changes. Calls onWindow(id) for every report
// (the first one is the current state). Returns { stop }.
function defaultSpy(onWindow, onError) {
  const child = spawn("xprop", ["-root", "-spy", "_NET_ACTIVE_WINDOW"], { stdio: ["ignore", "pipe", "ignore"] });
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const id = parseActiveWindowLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (id) onWindow(id);
    }
  });
  child.on("error", onError);
  return { stop: () => { try { child.kill(); } catch {} } };
}

/** "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x740000b" -> 121634827 (0 when none). */
export function parseActiveWindowLine(line) {
  const m = /window id # (0x[0-9a-f]+)/i.exec(String(line));
  return m ? parseInt(m[1], 16) : 0;
}

// An activation counts as ours only this close to the signal (or to the arm,
// for actions that need no signal). Anything else is the operator's own doing.
export const MATCH_WINDOW_MS = 1500;

export function createFocusGuard({
  browserPid,
  exec = defaultExec,
  spy = defaultSpy,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  log = () => {}
} = {}) {
  let guard = null;

  const activeWindow = async () => parseInt(String(await exec("xdotool", ["getactivewindow"])).trim(), 10) || 0;
  const windowPid = async (id) => parseInt(String(await exec("xdotool", ["getwindowpid", String(id)])).trim(), 10) || 0;
  const isBrowserWindow = async (id) => (await windowPid(id).catch(() => 0)) === browserPid;

  function stop(g) {
    if (!g) return;
    g.spy?.stop();
    if (g.timer) clearTimer(g.timer);
    if (guard === g) guard = null;
  }

  async function maybeRestore(g) {
    if (g !== guard || g.restored || g.checking) return;
    if (!g.current || g.current === g.prev || !g.activatedAt) return;
    const ref = g.needSignal ? g.signaledAt : g.armedAt;
    if (!ref || Math.abs(g.activatedAt - ref) > MATCH_WINDOW_MS) return;
    g.checking = true;
    try {
      if (g !== guard || !(await isBrowserWindow(g.current))) return;
      g.restored = true;
      // An activate sent while the browser's own activation is still settling
      // can be lost (seen live), so check and retry a couple of times.
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        await exec("xdotool", ["windowactivate", String(g.prev)]).catch(() => {});
        await new Promise((r) => setTimer(r, 150));
        ok = (await activeWindow().catch(() => 0)) === g.prev;
      }
      log(`focus ${ok ? "restored" : "NOT restored (3 attempts)"}: 0x${g.current.toString(16)} -> 0x${g.prev.toString(16)}`);
      g.result = { restored: ok, from: g.current, to: g.prev };
      stop(g);
    } finally {
      g.checking = false;
    }
    // An activation that arrived while we were checking must not be lost.
    if (g === guard && !g.restored) maybeRestore(g);
  }

  async function arm({ ms = 10000, needSignal = true } = {}) {
    const active = await activeWindow();
    if (!active) throw new Error("no active window (not X11?)");
    const live = guard && !guard.restored ? guard : null;
    // A second action while a guard is live (agents click in bursts): if the
    // browser already holds focus, that is likely the grab we are guarding
    // against, so keep the window we recorded before it.
    if (live && active !== live.prev && (await isBrowserWindow(active))) {
      if (live.timer) clearTimer(live.timer);
      live.needSignal = live.needSignal && !!needSignal;
      live.armedAt = now();
      live.timer = setTimer(() => stop(live), ms);
      return { prev: live.prev, kept: true };
    }
    stop(guard);
    const g = { prev: active, current: active, needSignal: !!needSignal, armedAt: now(), restored: false };
    guard = g;
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      g.spy = spy(
        (id) => {
          if (id !== g.current) { g.current = id; g.activatedAt = now(); }
          done();
          maybeRestore(g);
        },
        (e) => { log(`xprop failed: ${e && e.message}`); done(); }
      );
      // The first report is the current state; don't hold the click hostage
      // if it is slow.
      setTimer(done, 300);
    });
    g.timer = setTimer(() => stop(g), ms);
    return { prev: active };
  }

  function signal() {
    const g = guard;
    if (!g) return { armed: false };
    g.signaledAt = now();
    maybeRestore(g);
    return { armed: true };
  }

  return { arm, signal, _state: () => guard };
}

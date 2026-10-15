#!/usr/bin/env node
// Focus guard (fork jasir): restores the operator's window after the browser
// grabs focus, and ONLY then. Fake xdotool/xprop; no X server needed.
//
// Run: node host/test/focus-guard.test.mjs

import { createFocusGuard, parseActiveWindowLine } from "../focus-guard.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };
const tick = () => new Promise((r) => setTimeout(r, 5));

const BROWSER = 26188, OPERATOR_WIN = 0x740000b, MCP_WIN = 0x3600360, OTHER_BRAVE_WIN = 0x3600552, FOREIGN_WIN = 0x5000001;
const PIDS = { [OPERATOR_WIN]: 999, [MCP_WIN]: BROWSER, [OTHER_BRAVE_WIN]: BROWSER, [FOREIGN_WIN]: 4242 };

function harness(initialActive = OPERATOR_WIN) {
  const calls = [];
  let push = null;
  const env = { active: initialActive, spyStops: 0, t: 1000 };
  const guard = createFocusGuard({
    browserPid: BROWSER,
    exec: async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (args[0] === "getactivewindow") return `${env.active}\n`;
      if (args[0] === "getwindowpid") return `${PIDS[Number(args[1])] || 0}\n`;
      if (args[0] === "windowactivate") { if (env.loseNext) env.loseNext = false; else env.active = Number(args[1]); return ""; }
      return "";
    },
    spy: (onWindow) => { push = onWindow; onWindow(env.active); return { stop: () => env.spyStops++ }; },
    setTimer: (fn, ms) => (ms >= 1000 ? { fn } : setTimeout(fn, 0)),
    clearTimer: () => {},
    now: () => env.t
  });
  const activate = async (id) => { env.active = id; push(id); await tick(); };
  const restores = () => calls.filter((c) => c.startsWith("xdotool windowactivate"));
  return { guard, env, activate, restores };
}

ok(parseActiveWindowLine("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x740000b") === 0x740000b, "parses xprop line");
ok(parseActiveWindowLine("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0") === 0, "no window -> 0");

{
  const h = harness();
  await h.guard.arm({ needSignal: true });
  h.guard.signal();
  await h.activate(MCP_WIN);
  ok(h.restores().length === 1 && h.env.active === OPERATOR_WIN, "signal then browser activation -> focus restored");
}
{
  const h = harness();
  await h.guard.arm({ needSignal: true });
  await h.activate(MCP_WIN);
  ok(h.restores().length === 0, "activation without signal is left alone (operator may have switched)");
  h.guard.signal();
  await tick();
  ok(h.restores().length === 1 && h.env.active === OPERATOR_WIN, "...signal arriving after the activation restores it");
}
{
  const h = harness();
  await h.guard.arm({ needSignal: true });
  h.guard.signal();
  await h.activate(FOREIGN_WIN);
  ok(h.restores().length === 0, "activation of another application's window is never undone");
}
{
  const h = harness(MCP_WIN);
  await h.guard.arm({ needSignal: false });
  await h.activate(MCP_WIN);
  ok(h.restores().length === 0, "operator already in the browser window -> nothing to do");
}
{
  const h = harness(OTHER_BRAVE_WIN);
  await h.guard.arm({ needSignal: false });
  await h.activate(MCP_WIN);
  ok(h.restores().length === 1 && h.env.active === OTHER_BRAVE_WIN, "operator in another window of the same browser gets it back");
}
{
  const h = harness();
  await h.guard.arm({ needSignal: false });
  await h.activate(MCP_WIN);
  await h.activate(MCP_WIN);
  await h.activate(OPERATOR_WIN);
  await h.activate(MCP_WIN);
  ok(h.restores().length === 1, "at most one restore per arm");
  ok(h.env.spyStops >= 1, "spy stopped after restoring");
}
{
  // The first activate is lost (browser still settling); the guard retries.
  const h = harness();
  await h.guard.arm({ needSignal: false });
  h.env.loseNext = true;
  await h.activate(MCP_WIN);
  await tick(); await tick();
  ok(h.env.active === OPERATOR_WIN && h.restores().length === 2, "lost activate is retried until the operator window is active");
}
{
  const h = harness();
  await h.guard.arm({ needSignal: true });
  h.guard.signal();
  h.env.t += 3000;
  await h.activate(MCP_WIN);
  ok(h.restores().length === 0, "browser activation long after the signal is the operator's own switch: left alone");
}
{
  const h = harness();
  await h.guard.arm({ needSignal: false });
  h.env.t += 3000;
  await h.activate(MCP_WIN);
  ok(h.restores().length === 0, "same without a signal: only activations right after the action count");
}
{
  // Burst: second action arrives after the grab but before the signal.
  const h = harness();
  await h.guard.arm({ needSignal: true });
  await h.activate(MCP_WIN);
  const r = await h.guard.arm({ needSignal: true });
  ok(r.prev === OPERATOR_WIN && r.kept, "second arm while the browser holds focus keeps the operator window");
  h.guard.signal();
  await tick();
  ok(h.env.active === OPERATOR_WIN, "...and the signal then restores it");
}
{
  const h = harness();
  ok(h.guard.signal().armed === false, "signal without an armed guard is harmless");
}
{
  const guard = createFocusGuard({ browserPid: 1, exec: async () => { throw new Error("xdotool: not found"); } });
  let threw = false;
  try { await guard.arm({}); } catch { threw = true; }
  ok(threw, "without xdotool arm reports failure instead of pretending");
}

if (fail) { console.log(`\n${fail} FAILED`); process.exit(1); }
console.log("\nall passed");

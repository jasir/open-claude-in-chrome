#!/usr/bin/env node
// Which instance spawned the native host (fork jasir, see host/instance-name.js).
// Run: node host/test/instance-name.test.mjs
import os from "node:os";
import { userDataDirFromCmdline, nameForDir, instanceNameFromParent, resolveInstance } from "../instance-name.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };
const H = os.homedir();
const reg = `brave\t${H}/.config/BraveSoftware/Brave-Browser\nkarel\t${H}/.config/brave-karel\n`;

ok(userDataDirFromCmdline(`/opt/brave\0--user-data-dir=${H}/.config/brave-karel\0--no-first-run\0`) === `${H}/.config/brave-karel`, "--user-data-dir=X");
ok(userDataDirFromCmdline(`/opt/brave\0--user-data-dir\0/x/y\0`) === "/x/y", "--user-data-dir X");
ok(userDataDirFromCmdline(`/opt/brave\0--type=renderer\0`) === "", "default profile -> none");
ok(userDataDirFromCmdline(`/opt/brave/brave --user-data-dir=/home/j/.config/brave-karel --password-store=basic`) === "/home/j/.config/brave-karel",
  "space-joined (Chromium rewrites its process title)");
ok(nameForDir(reg, `${H}/.config/brave-karel/`) === "karel", "trailing slash ignored");
ok(nameForDir(reg, "~/.config/brave-karel") === "karel", "~ expanded");
ok(nameForDir(reg, "/elsewhere") === "", "unknown dir -> none");

const files = (cmdline) => (p) => {
  if (p.startsWith("/proc/")) return cmdline;
  if (p === "REG") return reg;
  throw new Error("ENOENT");
};
ok(instanceNameFromParent({ ppid: 1, readFile: files(`brave\0--user-data-dir=${H}/.config/brave-karel\0`), registry: "REG" }) === "karel",
  "Brave instance with its own dir gets its own name (not the default wrapper's)");
ok(instanceNameFromParent({ ppid: 1, readFile: files(`brave\0--enable-crash-reporter\0`), registry: "REG" }) === "",
  "Jarda's default Brave keeps the wrapper's name");
ok(instanceNameFromParent({ ppid: 1, readFile: () => { throw new Error("no /proc"); } }) === "", "no /proc -> no override");

{
  const unknown = files(`brave --user-data-dir=/tmp/unregistered-profile --x`);
  const r = resolveInstance({ ppid: 1, readFile: unknown, registry: "REG", wrapperDir: `${H}/.config/BraveSoftware/Brave-Browser` });
  ok(!!r.refuse && !r.name, "unregistered instance launched through Jarda's brave wrapper is refused (no bridge hijack)");
  const own = resolveInstance({ ppid: 1, readFile: files(`chrome --user-data-dir=/x/own`), registry: "REG", wrapperDir: "/x/own" });
  ok(!own.refuse && !own.name, "wrapper's own directory, not in the registry: keep the wrapper name");
  const noreg = resolveInstance({ ppid: 1, readFile: (p) => { if (p.startsWith("/proc/")) return `brave --user-data-dir=${H}/.config/brave-karel`; throw new Error("ENOENT"); }, registry: "REG", wrapperDir: `${H}/.config/BraveSoftware/Brave-Browser` });
  ok(!!noreg.refuse, "missing registry with a foreign --user-data-dir is refused too");
}

if (fail) { console.log(`\n${fail} FAILED`); process.exit(1); }
console.log("\nall passed");

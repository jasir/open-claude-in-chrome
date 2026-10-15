// Which browser instance launched this native host (fork jasir).
//
// install.sh registers a native host per user-data-dir and puts the manifest in
// <user-data-dir>/NativeMessagingHosts. Brave (verified 2026-10-16, 153.1.95)
// ignores that for a --user-data-dir instance and reads the manifest of its
// DEFAULT profile directory instead, so a second Brave started with
// --user-data-dir=~/.config/brave-karel launched the host wrapper of "brave"
// and would have fought Jarda's own Brave for bridge-brave.sock.
//
// So the host also asks its parent: the browser that spawned it carries
// --user-data-dir on its command line, and install.sh records which name
// belongs to which directory in ~/.config/open-claude-in-chrome/instances.tsv.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REGISTRY = path.join(os.homedir(), ".config", "open-claude-in-chrome", "instances.tsv");

/**
 * --user-data-dir value from /proc/<pid>/cmdline, or "". Chromium rewrites its
 * process title, so the arguments arrive space-joined rather than
 * NUL-separated (seen on Brave 153); a directory with a space in its path is
 * therefore not supported.
 */
export function userDataDirFromCmdline(cmdline) {
  const m = /(?:^|[\0 ])--user-data-dir(?:=|[\0 ]+)([^\0 ]+)/.exec(String(cmdline));
  return m ? m[1] : "";
}

const norm = (p) => {
  const abs = path.resolve(String(p).replace(/^~(?=\/|$)/, os.homedir()));
  try { return fs.realpathSync(abs); } catch { return abs.replace(/\/+$/, ""); }
};

/** Name registered for `dir` in the "name<TAB>dir" registry text, or "". */
export function nameForDir(registryText, dir) {
  const want = norm(dir);
  for (const line of String(registryText).split("\n")) {
    const [name, d] = line.split("\t");
    if (name && d && norm(d) === want) return name;
  }
  return "";
}

/**
 * Decide this host's name from the browser that spawned it.
 *   { name }   — the parent's --user-data-dir is registered under `name`;
 *   { refuse } — the parent runs a --user-data-dir that is neither registered
 *                nor the wrapper's own directory (OCIC_USER_DATA_DIR): serving
 *                under the wrapper's name would hijack another browser's
 *                bridge, so the host must not start;
 *   {}         — keep OCIC_BROWSER from the wrapper.
 */
export function resolveInstance({
  ppid = process.ppid,
  readFile = fs.readFileSync,
  registry = REGISTRY,
  wrapperDir = process.env.OCIC_USER_DATA_DIR || ""
} = {}) {
  let dir = "";
  try { dir = userDataDirFromCmdline(readFile(`/proc/${ppid}/cmdline`, "utf-8")); } catch { return {}; }
  if (!dir) return {};
  let text = "";
  try { text = readFile(registry, "utf-8"); } catch {}
  const name = nameForDir(text, dir);
  if (name) return { name };
  if (wrapperDir && norm(wrapperDir) !== norm(dir)) {
    return { refuse: `launched by a browser with --user-data-dir=${dir}, which is not registered (install.sh name=dir); refusing to serve as "${process.env.OCIC_BROWSER || ""}"` };
  }
  return {};
}

/** Back-compat helper: just the name ("" when none). */
export function instanceNameFromParent(opts) {
  return resolveInstance(opts).name || "";
}

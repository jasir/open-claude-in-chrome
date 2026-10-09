#!/usr/bin/env bash
# Zaregistruje MCP server ocic-<jméno> pro každý prohlížeč do Claude Code (scope user)
# a do Codexu (~/.codex/config.toml). Když existuje ~/scripts-ai/mcp-lazy, server jde
# přes něj: nástroje se ukazují z cache a node proces běží jen při používání.
#
#   ./mcp-register.sh brave chrome chrome-debug
#   ./mcp-register.sh --remove chrome-debug
#
# Agent pak vidí nástroje mcp__ocic-<jméno>__*, každý prohlížeč zvlášť.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$SCRIPT_DIR/host/mcp-server.js"
LAZY="$HOME/scripts-ai/mcp-lazy/mcp-lazy.ts"
IDLE=1800
CODEX_CONFIG="$HOME/.codex/config.toml"
BACKUP_DIR="$HOME/.config/mcp-lazy-zalohy"

REMOVE=0
if [[ "${1:-}" == --remove ]]; then REMOVE=1; shift; fi
[[ $# -gt 0 ]] || { echo "Použití: ./mcp-register.sh [--remove] jméno…" >&2; exit 1; }

NODE="$(command -v node)" || { echo "Chybí node." >&2; exit 1; }
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"

stamp="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
[[ -f "$HOME/.claude.json" ]] && cp "$HOME/.claude.json" "$BACKUP_DIR/claude.json.$stamp-pred-ocic"
[[ -f "$CODEX_CONFIG" ]] && cp "$CODEX_CONFIG" "$BACKUP_DIR/codex-config.toml.$stamp-pred-ocic"

for name in "$@"; do
  [[ "$name" =~ ^[A-Za-z0-9_-]{1,32}$ ]] || { echo "Neplatné jméno '$name'." >&2; exit 1; }
  server="ocic-$name"
  cmd=""; args=()

  claude mcp remove -s user "$server" >/dev/null 2>&1 || true

  if [[ $REMOVE -eq 0 ]]; then
    if [[ -f "$LAZY" && -x "$BUN" ]]; then
      cmd="$BUN"; args=("$LAZY" --idle "$IDLE" -- "$NODE" "$SERVER" --browser "$name")
    else
      cmd="$NODE"; args=("$SERVER" --browser "$name")
    fi
    json="$(python3 -c 'import json,sys; print(json.dumps({"type":"stdio","command":sys.argv[1],"args":sys.argv[2:],"env":{}}))' "$cmd" "${args[@]}")"
    claude mcp add-json -s user "$server" "$json" >/dev/null
    echo "  Claude Code: $server"
  else
    echo "  Claude Code: $server odebrán"
  fi

  if [[ -f "$CODEX_CONFIG" ]]; then
    python3 - "$CODEX_CONFIG" "$server" "$REMOVE" "$cmd" ${args[@]+"${args[@]}"} <<'EOF'
import json, re, sys
path, server, remove, cmd, *args = sys.argv[1:]
text = open(path).read()
header = f"[mcp_servers.{server}]"
# odstranit starou sekci (až po další hlavičku)
# včetně podtabulek [mcp_servers.<server>.*]
own = rf"mcp_servers\.{re.escape(server)}(?:\.[^\]]+)?\]"
text = re.sub(rf"(?ms)^\[{own}\n.*?(?=^\[(?!{own})|\Z)", "", text)
if remove != "1":
    block = f"{header}\ncommand = {json.dumps(cmd)}\nargs = {json.dumps(args, ensure_ascii=False)}\n\n"
    # za poslední mcp_servers sekci, jinak na konec
    last = list(re.finditer(r"(?ms)^\[mcp_servers\.[^\]]+\]\n.*?(?=^\[|\Z)", text))
    pos = last[-1].end() if last else len(text)
    if pos > 0 and not text[:pos].endswith("\n"):
        block = "\n" + block
    text = text[:pos] + block + text[pos:]
open(path, "w").write(text)
EOF
    [[ $REMOVE -eq 0 ]] && echo "  Codex: $server" || echo "  Codex: $server odebrán"
  fi
done

echo
echo "Hotovo. Nové nástroje uvidí až nové session (Claude Code: /mcp)."

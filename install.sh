#!/usr/bin/env bash
# Registrace native hostu pro jeden nebo více prohlížečů (fork jasir, jen Linux).
#
#   ./install.sh                         výchozí prohlížeče (DEFAULT_TARGETS), které na stroji jsou
#   ./install.sh brave chrome            jen vybrané z výchozích
#   ./install.sh kosik=~/.config/chrome-kosik   vlastní jméno = user-data-dir
#   ./install.sh --remove brave          odregistrovat
#
# Každý prohlížeč (přesněji každý user-data-dir) dostane vlastní wrapper
# host/native-host-<jméno>.sh s OCIC_BROWSER=<jméno>, takže jeho native host
# drží vlastní socket bridge-<jméno>.sock a prohlížeče jdou ovládat paralelně.
# Chromium na Linuxu hledá uživatelské native hosty v <user-data-dir>/NativeMessagingHosts,
# proto funguje i instance s vlastním --user-data-dir (chrome-debug).
#
# ID rozšíření je pevné (klíč v extension/manifest.json), ručně se nezadává.
# MCP server pro Claude Code a Codex zaregistruje ./mcp-register.sh.

set -euo pipefail

declare -A DEFAULT_TARGETS=(
  [brave]="$HOME/.config/BraveSoftware/Brave-Browser"
  [chrome]="$HOME/.config/google-chrome"
  [chrome-debug]="$HOME/.config/chrome-mcp-debug"
)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$SCRIPT_DIR/host"
HOST_NAME="com.anthropic.open_claude_in_chrome"

[[ "$(uname)" == Linux ]] || { echo "Tento fork instaluje jen na Linuxu (upstream install.sh je v historii gitu)." >&2; exit 1; }

NODE="$(command -v node)" || { echo "Chybí node." >&2; exit 1; }
bad_path() { [[ -z "$1" || "$1" == *"'"* || "$1" == *$'\n'* ]]; }
! bad_path "$NODE$HOST_DIR" || { echo "Cesta s apostrofem nebo novým řádkem není podporovaná." >&2; exit 1; }

EXT_ID="$(python3 - "$SCRIPT_DIR/extension/manifest.json" <<'EOF'
import base64, hashlib, json, sys
key = json.load(open(sys.argv[1]))["key"]
h = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
print("".join(chr(ord("a") + int(c, 16)) for c in h))
EOF
)"

valid_name() { [[ "$1" =~ ^[A-Za-z0-9_-]{1,32}$ ]] || { echo "Neplatné jméno '$1' (A-Z a-z 0-9 _ -)." >&2; exit 1; }; }

# jméno nebo jméno=adresář → "jméno<TAB>adresář"
resolve() {
  local arg="$1" name dir
  if [[ "$arg" == *=* ]]; then
    name="${arg%%=*}"; dir="${arg#*=}"; dir="${dir/#\~/$HOME}"
  else
    name="$arg"; dir="${DEFAULT_TARGETS[$arg]:-}"
    [[ -n "$dir" ]] || { echo "Neznámý prohlížeč '$arg', použij jméno=user-data-dir." >&2; exit 1; }
  fi
  valid_name "$name"
  ! bad_path "$dir" || { echo "Neplatný adresář pro '$name'." >&2; exit 1; }
  printf '%s\t%s\n' "$name" "$dir"
}

REMOVE=0
if [[ "${1:-}" == --remove ]]; then REMOVE=1; shift; fi

TARGETS=()
if [[ $# -eq 0 ]]; then
  [[ $REMOVE -eq 0 ]] || { echo "Použití: ./install.sh --remove jméno…" >&2; exit 1; }
  for n in "${!DEFAULT_TARGETS[@]}"; do
    [[ -d "${DEFAULT_TARGETS[$n]}" ]] && TARGETS+=("$(resolve "$n")")
  done
else
  for a in "$@"; do TARGETS+=("$(resolve "$a")"); done
fi

if [[ $REMOVE -eq 0 && ! -d "$HOST_DIR/node_modules" ]]; then
  echo "Instaluji závislosti hostu…"
  npm install --prefix "$HOST_DIR" --no-fund --no-audit
fi

for t in "${TARGETS[@]}"; do
  IFS=$'\t' read -r name dir <<<"$t"
  wrapper="$HOST_DIR/native-host-$name.sh"
  manifest="$dir/NativeMessagingHosts/$HOST_NAME.json"

  if [[ $REMOVE -eq 1 ]]; then
    rm -f "$wrapper" "$manifest"
    echo "  $name: odregistrováno"
    continue
  fi

  if [[ ! -d "$dir" ]]; then
    echo "  $name: přeskočeno, $dir neexistuje"
    continue
  fi

  cat >"$wrapper" <<EOF
#!/bin/sh
# Vygenerováno install.sh – native host pro prohlížeč '$name' ($dir).
OCIC_BROWSER='$name' exec '$NODE' '$HOST_DIR/native-host.js' "\$@"
EOF
  chmod +x "$wrapper"

  mkdir -p "$(dirname "$manifest")"
  python3 - "$manifest" "$wrapper" "$EXT_ID" "$name" <<'EOF'
import json, sys
path, wrapper, ext_id, name = sys.argv[1:]
json.dump({
    "name": "com.anthropic.open_claude_in_chrome",
    "description": f"Open Claude in Chrome native host ({name})",
    "path": wrapper,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{ext_id}/"],
}, open(path, "w"), indent=2)
EOF
  echo "  $name: $manifest"
done

[[ $REMOVE -eq 1 ]] && exit 0

cat <<EOF

ID rozšíření: $EXT_ID

Dál:
  1. V každém prohlížeči: <prohlížeč>://extensions → Režim pro vývojáře → Načíst rozbalené
     → $SCRIPT_DIR/extension
  2. Prohlížeč úplně zavřít a znovu spustit (native hosty čte při startu).
  3. ./mcp-register.sh <jméno>…   (MCP server ocic-<jméno> pro Claude Code a Codex přes mcp-lazy)
EOF

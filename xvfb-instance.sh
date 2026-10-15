#!/usr/bin/env bash
# Vlastní Brave pro agenta na virtuálním displeji (fork jasir, plán B: docs/plan-b-karel-xvfb.md).
# Prohlížeč běží na Xvfb, takže operátorovi nikdy nevezme fokus ani myš.
#
#   ./xvfb-instance.sh install karel [--display 99] [--size 1600x1000] [--max 2h]
#   ./xvfb-instance.sh start|stop|status karel
#   ./xvfb-instance.sh login karel     # jednorázově: stejný profil viditelně na tvém displeji
#   ./xvfb-instance.sh remove karel    # služby a registrace pryč, profil zůstane
#
# install: profil ~/.config/brave-<jméno>, native host (install.sh), MCP server ocic-<jméno>
# (mcp-register.sh), systemd user služby ocic-xvfb-<jméno> a ocic-<jméno>. Rozšíření se
# načítá z extension/ přes --load-extension (Brave 153 to umí, ověřeno 2026-10-16).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
BROWSER_BIN="$(command -v brave-browser || true)"

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
[[ $# -ge 2 ]] || usage
cmd="$1"; name="$2"; shift 2
[[ "$name" =~ ^[A-Za-z0-9_-]{1,32}$ ]] || { echo "Neplatné jméno '$name'." >&2; exit 1; }
# Jména běžných prohlížečů jsou obsazená: install brave by přepsal most Jardova Brave.
case "$name" in brave|chrome|chrome-debug)
  echo "Jméno '$name' patří běžnému prohlížeči, zvol jiné." >&2; exit 1 ;;
esac

profile="$HOME/.config/brave-$name"
REGISTRY="$HOME/.config/open-claude-in-chrome/instances.tsv"
# Cesty jdou bez uvozovek do ExecStart a do /proc cmdline (mezery tam nepřežijí).
[[ "$profile$SCRIPT_DIR" != *[[:space:]%]* ]] || { echo "Cesta s mezerou nebo % není podporovaná." >&2; exit 1; }
xvfb_unit="ocic-xvfb-$name.service"
brave_unit="ocic-$name.service"
conf="$HOME/.config/open-claude-in-chrome/xvfb-$name.env"

browser_args() { # displej-nezávislé argumenty prohlížeče
  printf '%s\n' "--user-data-dir=$profile" --password-store=basic --no-first-run \
    --no-default-browser-check "--load-extension=$SCRIPT_DIR/extension"
}

case "$cmd" in
  install)
    display=99; size=1600x1000; max=2h
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --display) display="${2#:}"; shift 2 ;;
        --size) size="$2"; shift 2 ;;
        --max) max="$2"; shift 2 ;;
        *) usage ;;
      esac
    done
    [[ "$display" =~ ^[0-9]+$ && "$size" =~ ^[0-9]+x[0-9]+$ ]] || usage
    [[ -n "$BROWSER_BIN" ]] || { echo "Chybí brave-browser." >&2; exit 1; }
    command -v Xvfb >/dev/null || { echo "Chybí Xvfb (apt install xvfb)." >&2; exit 1; }
    if [[ -e "/tmp/.X11-unix/X$display" ]] && ! systemctl --user is-active -q "$xvfb_unit"; then
      echo "Displej :$display už používá jiný X server, zvol jiný (--display)." >&2; exit 1
    fi
    for other in "$(dirname "$conf")"/xvfb-*.env; do
      [[ -f "$other" && "$other" != "$conf" ]] || continue
      if grep -qx "DISPLAY_NUM=$display" "$other"; then
        echo "Displej :$display už má instance $(basename "$other" .env | sed 's/^xvfb-//'), zvol jiný (--display)." >&2; exit 1
      fi
    done
    if [[ -f "$REGISTRY" ]] && awk -F'\t' -v n="$name" -v d="$profile" '$1==n && $2!=d {f=1} END {exit !f}' "$REGISTRY"; then
      echo "Jméno '$name' už je v $REGISTRY zaregistrované pro jiný adresář." >&2; exit 1
    fi
    mkdir -p "$profile" "$UNIT_DIR" "$(dirname "$conf")"
    printf 'DISPLAY_NUM=%s\nSIZE=%s\n' "$display" "$size" >"$conf"

    "$SCRIPT_DIR/install.sh" "$name=$profile" | sed -n '1p'

    cat >"$UNIT_DIR/$xvfb_unit" <<EOF
# Vygenerováno $SCRIPT_DIR/xvfb-instance.sh
[Unit]
Description=Xvfb :$display pro ocic-$name
StopWhenUnneeded=yes

[Service]
ExecStart=$(command -v Xvfb) :$display -screen 0 ${size}x24 -nolisten tcp
EOF

    w="${size%x*}"; h="${size#*x}"
    cat >"$UNIT_DIR/$brave_unit" <<EOF
# Vygenerováno $SCRIPT_DIR/xvfb-instance.sh
[Unit]
Description=Brave pro agenta (MCP ocic-$name) na Xvfb :$display
Requires=$xvfb_unit
After=$xvfb_unit

[Service]
Environment=DISPLAY=:$display
# Profil už otevřený (./xvfb-instance.sh login): Brave by spuštění předal tomu oknu
# a služba by skončila "úspěšně" bez prohlížeče. Raději selhat.
ExecStartPre=/bin/sh -c '! pgrep -f -- "--user-data-dir=$profile( |\$)" >/dev/null || { echo "profil $profile je otevřený (login?)" >&2; exit 1; }'
# Xvfb chvíli trvá, než přijímá spojení.
ExecStartPre=/bin/sh -c 'for i in \$(seq 50); do [ -e /tmp/.X11-unix/X$display ] && exit 0; sleep 0.1; done; exit 1'
ExecStart=$BROWSER_BIN $(browser_args | tr '\n' ' ')--window-size=$w,$h --window-position=0,0
# Pojistka pro zapomenutý prohlížeč: po $max ho systemd natvrdo ukončí (i uprostřed
# nákupu), proto agent službu po práci zastaví sám a dlouhé nákupy začíná znovu.
RuntimeMaxSec=$max
Restart=no
EOF
    systemctl --user daemon-reload
    "$SCRIPT_DIR/mcp-register.sh" "$name" | sed -n '1,2p'
    cat <<EOF

Hotovo: profil $profile, displej :$display, služby $brave_unit (+ $xvfb_unit), MCP ocic-$name.
Dál: jednorázové přihlášení  ./xvfb-instance.sh login $name
Agent: systemctl --user start $brave_unit  …  mcp__ocic-${name}__*  …  systemctl --user stop $brave_unit
EOF
    ;;

  start) systemctl --user start "$brave_unit"; systemctl --user --no-pager status "$brave_unit" | sed -n '1,3p' ;;
  stop) systemctl --user stop "$brave_unit" ;;
  status) systemctl --user --no-pager status "$brave_unit" "$xvfb_unit" || true ;;

  login)
    # Stejný profil viditelně na displeji, ze kterého skript spouštíš: přihlášení na weby
    # (Google, e-shop) udělá člověk. Po zavření okna se služba může zase spouštět.
    [[ -n "${DISPLAY:-}" ]] || { echo "Spusť z grafické session (chybí DISPLAY)." >&2; exit 1; }
    systemctl --user stop "$brave_unit" 2>/dev/null || true
    echo "Otevírám Brave s profilem $profile. Přihlas se, pak okno zavři (Ctrl+Shift+Q)."
    mapfile -t args < <(browser_args)
    "$BROWSER_BIN" "${args[@]}" --new-window "${@:-about:blank}" >/dev/null 2>&1 || true
    echo "Zavřeno. Agent si teď prohlížeč spustí sám (systemctl --user start $brave_unit)."
    ;;

  remove)
    systemctl --user stop "$brave_unit" 2>/dev/null || true
    rm -f "$UNIT_DIR/$brave_unit" "$UNIT_DIR/$xvfb_unit" "$conf"
    systemctl --user daemon-reload
    "$SCRIPT_DIR/install.sh" --remove "$name=$profile"
    "$SCRIPT_DIR/mcp-register.sh" --remove "$name" | sed -n '1p'
    echo "Profil $profile zůstal (přihlášení); smaž ho ručně, pokud ho už nechceš."
    ;;

  *) usage ;;
esac

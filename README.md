# Open Claude in Chrome – fork jasir

Ovládání běžného prohlížeče (s tvým přihlášením) z Claude Code a Codexu přes MCP.
Fork [noemica-io/open-claude-in-chrome](https://github.com/noemica-io/open-claude-in-chrome)
(MIT), otevřené napodobeniny oficiálního
[Claude in Chrome](https://code.claude.com/docs/en/chrome). Původní README: `docs/README.upstream.md`.

## Co je jinak než upstream

- **Více prohlížečů paralelně.** Každý prohlížeč (user-data-dir) má vlastní native host
  a socket `/tmp/open-claude-in-chrome-<uid>/bridge-<jméno>.sock`; agent má pro každý
  vlastní MCP server `ocic-<jméno>` (nástroje `mcp__ocic-brave__*`, `mcp__ocic-chrome__*`…).
  Upstream měl jeden socket a `switch_browser` jen předával řízení.
- **Bez nahrávače** (imitation learning): manifest nevkládá `recorder/capture.js` do stránek,
  nemá oprávnění `offscreen` ani stránku Options, ikona nic nespouští, nástroj
  `retranscribe_recording` je pryč. Kód nahrávače v `background.js` zůstal nečinný,
  aby šly snadno přebírat změny z upstreamu.
- **Pryč:** `benchmark/` (355 MB), `scratch/`, `REAL/`, `host/codemode/` (sandbox s Cloudflare Workerem).
- **Pevné ID rozšíření** `ppklppeameifkpjiahjebdlfgmcpbghm` (klíč v manifestu), stejné ve všech prohlížečích.
- **Čtení jen změn (úspora tokenů, inspirováno vercel-labs/agent-browser):**
  `read_page` s `delta: true` vrátí jen změněné řádky stromu od minulého čtení záložky
  (`- ` pryč, `+ ` nové, `@@ line N @@` pozice; `Unchanged`, když se nic nezměnilo).
  Po navigaci, změně filtru, oříznutí `max_chars` nebo velké změně vrátí celý strom.
  `computer` → `screenshot` s `if_changed: true` stejný obrázek znovu neposílá,
  vrátí ID předchozího.
- **Google Pay bez platebního listu a bez fokusu** (nástroj `gpay`, nastavení `gpay_tab_sites`, výchozí `kosik.cz`).
  Nativní platební list (PaymentRequest) Chromium neukáže, když okno prohlížeče není aktivní
  (`payment_request.cc`: `IsBrowserWindowActive` → „Cannot show PaymentRequest UI in a preview page
  or a background tab.“). Proto v záložkách, které ovládá MCP, a jen na nastavených webech skript
  před načtením stránky schová `PaymentRequest` (`extension/gpay/shim.js`). pay.js Googlu pak otevře
  pay.google.com přes `window.open`, a to jako záložku ve skupině MCP, ne jako okno.
  `gpay` (`read`, `select_card`, `pay`, `click`) tu záložku drží na pozadí a kliká DOM klikem
  přímo v iframu payments.google.com. Myší (CDP) by každý klik do iframu ve vybrané záložce aktivoval
  okno. `find` a `read_page` s `frames: true` vidí i obsah iframů.
  Otevření záložky z `window.open` Brave aktivuje vždy. Native host proto před klikem zapamatuje
  aktivní okno a po signálu ze stránky ho vrátí (`host/focus-guard.js`, xdotool + xprop, jen X11;
  vypnout jde nastavením `gpay_focus_guard: false`). Jardovi tak zmizí fokus jednou na ~0,2 s.
  Ověřeno 2026-10-16 v Brave na testovací stránce s pay.js (TEST):
  tlačítko → read → select_card 4444/1111/4445 → pay → stránka dostala kartu 4445.
- **Líné MCP:** `mcp-register.sh` registruje servery přes `~/scripts-ai/mcp-lazy`, node běží jen při používání.

## Architektura

```
Claude Code ─stdio MCP─ mcp-server.js --browser brave ─┐
Codex ───────stdio MCP─ mcp-server.js --browser brave ─┤ bridge-brave.sock ─ native-host (OCIC_BROWSER=brave) ─native messaging─ rozšíření v Brave
Claude Code ─stdio MCP─ mcp-server.js --browser chrome ─ bridge-chrome.sock ─ native-host (OCIC_BROWSER=chrome) ─ rozšíření v Chrome
```

- `extension/` – Manifest V3, nástroje přes CDP (`chrome.debugger`) v `background.js`, čtení stránky `content.js`.
- `host/native-host.js` – spouští ho prohlížeč; vlastní socket, multiplexuje víc MCP klientů.
- `host/mcp-server.js` – MCP server; `--browser JMÉNO` (nebo `OCIC_BROWSER`) vybere socket.
- `host/tool-definitions.js` – schémata nástrojů; implementace v `background.js` (`toolHandlers`).

## Instalace (Linux)

```bash
./install.sh                    # brave, chrome, chrome-debug – ty, které na stroji jsou
./install.sh kosik=~/.config/chrome-kosik   # vlastní instance s --user-data-dir
```

1. V každém prohlížeči `…://extensions` → Režim pro vývojáře → **Načíst rozbalené** → `extension/`.
2. `./mcp-register.sh brave chrome chrome-debug` – Claude Code (scope user) + `~/.codex/config.toml`,
   zálohy konfigurací do `~/.config/mcp-lazy-zalohy/`.
3. Nová session agenta → nástroje `mcp__ocic-<jméno>__*`; první volání `tabs_context_mcp`.

Odebrání: `./install.sh --remove jméno`, `./mcp-register.sh --remove jméno`.
Po změně `extension/` stačí v `…://extensions` kliknout na obnovit (od verze s nástrojem `gpay` jde i bez myši: skrytý nástroj `reload_extension` přes `callTool` z `host/tool-runtime.js`, agentům se nenabízí); po změně `host/` se
native host restartuje s dalším připojením rozšíření (nebo obnovit rozšíření).

## Omezení

- Dva profily **jednoho** user-data-dir sdílejí registraci, a tedy jméno – běží-li oba,
  most drží jen první. Řešení: profil s vlastním `--user-data-dir`.
- Víc agentů na **stejném** prohlížeči jde (host multiplexuje), ale sdílí skupinu záložek „MCP“;
  každý má pracovat ve vlastní záložce (`tabs_create_mcp`).
- `computer` → `screenshot` záložky na pozadí visí do timeoutu (20 s); nejdřív `set_tab_focus`.
  `get_page_text` a `navigate` fungují i na pozadí (ověřeno 2026-10-09 v Brave).
- **Rozšíření „Clutter Free – Prevent duplicate tabs“** (v Brave na nb-asus i nb-dell): `navigate` na URL, které je už otevřené v jiné záložce, nechá MCP záložku na `about:blank` (nejspíš Clutter Free navigaci zruší a přepne na existující záložku; příčina odvozená, ne prověřená vypnutím rozšíření); `get_page_text` pak hlásí `Cannot access a chrome-extension:// URL of different extension`. Obejití: odlišit URL (např. `?ocic=1`). Ověřeno 2026-10-13 na nb-dell.
- Upstream odstranil blocklist domén oficiálního rozšíření – agent smí kamkoli včetně bankovnictví.

- `gpay`: nekontroluje částku ani obchodníka, to musí udělat agent z `gpay read` před `pay`.
  Shim schová `PaymentRequest` na celém nastaveném webu (na kosik.cz tedy i pro jiné platby přes
  PaymentRequest) a do každé připojené záložky přidá `Runtime.enable`, `Page.enable` a binding
  `__ocicGpayOpen`. Stránka binding vidí, ale volání mimo nastavené weby se ignorují.
- `gpay`: potvrzení platby na telefonu zůstává na člověku. Když Google změní strukturu stránky
  pay.google.com, `select_card`/`pay` nemusí najít prvek. `gpay read` a `gpay click` pak ukážou,
  co na stránce je. Na webu, který volá `PaymentRequest` přímo (bez pay.js), schování
  `PaymentRequest` platbu Google Pay vypne. Proto je seznam webů výslovný.

## Testy

```bash
(cd host && npm test)
for t in test/*.test.mjs; do node "$t" || break; done
```

## Upstream

```bash
git fetch upstream && git merge upstream/main   # větev jarda
```

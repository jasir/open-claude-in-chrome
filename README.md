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
Po změně `extension/` stačí v `…://extensions` kliknout na obnovit; po změně `host/` se
native host restartuje s dalším připojením rozšíření (nebo obnovit rozšíření).

## Omezení

- Dva profily **jednoho** user-data-dir sdílejí registraci, a tedy jméno – běží-li oba,
  most drží jen první. Řešení: profil s vlastním `--user-data-dir`.
- Víc agentů na **stejném** prohlížeči jde (host multiplexuje), ale sdílí skupinu záložek „MCP“;
  každý má pracovat ve vlastní záložce (`tabs_create_mcp`).
- `computer` → `screenshot` záložky na pozadí visí do timeoutu (20 s); nejdřív `set_tab_focus`.
  `get_page_text` a `navigate` fungují i na pozadí (ověřeno 2026-10-09 v Brave).
- Upstream odstranil blocklist domén oficiálního rozšíření – agent smí kamkoli včetně bankovnictví.

## Testy

```bash
(cd host && npm test)
for t in test/*.test.mjs; do node "$t" || break; done
```

## Upstream

```bash
git fetch upstream && git merge upstream/main   # větev jarda
```

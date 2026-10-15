# Plán B: vlastní Brave pro Karla na virtuálním displeji

Stav: implementováno 2026-10-16 (`xvfb-instance.sh`, viz README). Odchylky od plánu níže v „Skutečnost“.

## Cíl

Karel nakupuje ve vlastním Brave na virtuálním displeji (Xvfb). Jardovi to nikdy nevezme fokus
ani myš, ani na 0,1 s jako v plánu A. Na virtuálním displeji je okno Karlova Brave jediné, takže je
aktivní. Fungoval by tak i nativní platební list Google Pay. Doporučení ale je zůstat i tady
u cesty A (Google Pay jako záložka, nástroj `gpay`): je čitelná přes CDP a nepotřebuje snímky
displeje.

## Jak to bude vypadat

```
Karel (Claude) ─ MCP ocic-karel ─ bridge-karel.sock ─ native host ─ rozšíření ─ Brave (--user-data-dir=~/.config/brave-karel)
                                                                                   │
                                                                         Xvfb :99 (virtuální displej, 1600x1000)
```

1. **Displej:** `Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp` jako systemd user služba
   `karel-xvfb.service`.
2. **Prohlížeč:** `brave-browser --user-data-dir=$HOME/.config/brave-karel --password-store=basic
   --no-first-run --no-default-browser-check --window-size=1600,1000` s `DISPLAY=:99`, služba
   `karel-brave.service` (Requires=karel-xvfb). Vlastní user-data-dir znamená samostatný proces,
   ten se nepřipojí k Jardovu Brave.
   - `--password-store=basic`: bez něj může Brave chtít odemknout klíčenku, a to okno by na :99
     nikdo neviděl.
3. **Rozšíření:** do profilu se jednou ručně načte rozbalené `extension/` (viz Přihlášení).
   `--load-extension` už značkové Chrome nepodporují. U Brave to není ověřené, proto
   s ním plán nepočítá.
4. **ocic/MCP:** `./install.sh karel=~/.config/brave-karel` a `./mcp-register.sh karel`.
   Karel pak dostane nástroje `mcp__ocic-karel__*`. Bez změny kódu, víc prohlížečů paralelně
   fork už umí. V `~/agents/karel` přepnout nástroje z `ocic-brave` na `ocic-karel`.
5. **Spouštění:** Karel si na začátku nákupu spustí `systemctl --user start karel-brave` a po
   skončení ho zastaví. Paměť ~0,5–1 GB po dobu nákupu (stroj má 62 GB, Jardův Brave teď bere ~9 GB).

## Přihlášení (jednou, Jarda, ~15 min)

1. Spustit Karlův Brave jednorázově na Jardově displeji (`DISPLAY=:1`), ať je vidět.
2. Načíst rozšíření: `brave://extensions` → Režim pro vývojáře → Načíst rozbalené → `extension/`.
3. Přihlásit se na kosik.cz (Jardův účet) a do Google (účet s kartami Google Pay). Google bude
   chtít potvrzení na Pixelu jako na novém zařízení.
4. Zavřít a spustit jako službu na `:99`. Cookies zůstanou v profilu.

Když přihlášení vyprší (Košík nebo Google), Karel to pozná (stránka přihlášení v `get_page_text`)
a požádá Jardu přes Felixe o kroky 1, 3 a 4.

## Rizika

1. **Google označí nový profil jako podezřelý** a bude chtít ověření častěji. Zmírnění: stálý
   profil, žádné mazání cookies, stejná IP.
2. **Vypršení přihlášení na Košíku**: neviditelné, dokud Karel nezkusí nákup. Zmírnění: kontrola
   přihlášení na začátku každého nákupu.
3. **Zapomenutý běžící Brave** zbytečně drží paměť. Zmírnění: `RuntimeMaxSec=2h` ve službě.
4. **Native host na `:99`:** hlídání fokusu z A pracuje s displejem, na kterém prohlížeč běží,
   tedy `:99`. Jardův displej neuvidí a nic na něm nezmění. Neškodí, jen tam zbytečně běží.
5. **Debugging na Jardovu žádost:** okno na `:99` není vidět. Snímek dává ocic (CDP).
   Pro živý pohled jde doinstalovat `x11vnc` (teď na stroji není), nebo Brave na chvíli pustit
   na `:1`.

## Odhad

- Služby, instalace a dokumentace: 2 h.
- Jednorázové přihlášení s Jardou: 15 min jeho času.
- Ověření celého nákupu na testovací stránce a úprava Karla: 1,5 h.
- Celkem asi půl dne. Kód rozšíření se nemění, A je v něm hotové.

## Skutečnost (implementace 2026-10-16)

1. `--load-extension` v Brave 153 funguje, ruční načtení rozšíření v profilu odpadlo.
2. Brave pro `--user-data-dir` instanci čte manifest native hostu z VÝCHOZÍHO profilu, takže
   spustil host pod jménem `brave` (soupeřil by s Jardovým Brave o most). Řeší
   `host/instance-name.js`: host se přejmenuje podle `--user-data-dir` rodiče.
3. Na Xvfb bez window manageru nefunguje `xdotool getactivewindow`; hlídání fokusu z A se tam
   tiše vypne (není co hlídat).
4. Klik do nové záložky na pozadí v instanci neprošel; po `set_tab_focus` ano. Agent v instanci
   proto svou záložku vybere.

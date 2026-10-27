<p align="center">
  <img src="public/logo.svg" width="96" alt="Logo Updaterr">
</p>

<h1 align="center">Updaterr</h1>

<p align="center">
  <b>Filmy a seriály z Radarru/Sonarru ve tvém jazyce.</b><br>
  Updaterr najde lepší verze toho, co už máš – s dabingem i originálem –<br>
  nebo chybějící dabing rovnou přidá do souboru, který už máš.
</p>

<p align="center">
  <a href="LICENSE"><img alt="Licence: MIT" src="https://img.shields.io/badge/license-MIT-3f74f0"></a>
  <img alt="Node.js 22+" src="https://img.shields.io/badge/node-22%2B-3c873a">
  <img alt="Docker" src="https://img.shields.io/badge/docker-compose-2496ed">
  <img alt="Bez npm závislostí" src="https://img.shields.io/badge/npm%20z%C3%A1vislosti-0-6ee7a8">
  <img alt="Asi 50 jazyků" src="https://img.shields.io/badge/jazyky%20dabingu-~50-f0a73f">
  <a href="README.md"><img alt="English" src="https://img.shields.io/badge/README-English-lightgrey"></a>
</p>

<p align="center">
  <img src="docs/screenshots/proposals.png" alt="Návrhy upgradů: releasy s lepším dabingem seřazené podle jazyka, kvality a seedů" width="100%">
</p>

---

Radarr a Sonarr jsou výborné na kvalitu, ale dabing neřeší. Klidně nechají 4K soubor jen s angličtinou, i když
existuje release s češtinou *i* originálem. A jazyk v názvu releasu nebo ve značce stopy navíc často nesedí.

Updaterr projde knihovnu, zjistí, jaké jazyky každý soubor **skutečně** má, a hledá něco lepšího. Hledaný dabing
si vybereš (čeština, slovenština, polština, němčina…) a k němu druhý jazyk, obvykle originál. Pořadí je:

> **oba jazyky › jen dabing › jen druhý jazyk**, při stejném jazyku vyšší rozlišení. Pro češtinu tedy **CZ + EN › CZ › EN**.

Nalezené upgrady nabídne ke schválení jedním kliknutím na webu, v Telegramu nebo přes ntfy. U hlídaných filmů a
seriálů je stáhne sám. Příklady níže jsou s češtinou, platí pro jakýkoli jazyk.

## Co umí

- **Čte skutečné zvukové stopy** (MediaInfo), ne názvy souborů. Když značky lžou, **poslechne si je**: lokálně
  běžící Whisper určí, jakým jazykem se mluví.
- **Rozumí názvům releasů** podle zvyklostí různých scén (`(CZ/EN)`, `.CZ-FTU`, `CZ dabing`, `German.DL`,
  `MULTi.VFF`, `PL.Lektor`…) a pozná dabing od titulků (`CZ titulky`, `VOSTFR`, `Napisy`).
- **Přidá dabing do souboru, který už máš.** 4K video s angličtinou zůstane, z jiného releasu se vezme jen česká
  stopa. Synchronizace se změří, výsledek ověří a originál zazálohuje.
- **Najde posunutý dabing** v souborech, které už oba jazyky mají, a opraví ho bez překódování.
- **Pohlídá stahování.** Mrtvý torrent vymění za dalšího kandidáta. Import, který Radarr/Sonarr odmítne
  („není upgrade“, nevyparsovaný název), vynutí. Po importu ověří jazyk podle skutečných stop.
- **Dá se bezpečně vyzkoušet.** Náhled jen pro čtení běží vedle ostré instance a nic nestahuje, neimportuje
  ani nemaže.
- **Nenáročný.** Čistý Node.js bez npm balíčků v Alpine obrazu. Rozhraní je česky a anglicky, nový překlad je
  jeden JSON soubor na každé straně.

## Screenshoty

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/merge.png" alt="Návrhy na přidání zvuku"><br><b>Přidání dabingu</b>: obraz zůstane, z jiného releasu se vezme jen zvuková stopa.</td>
    <td width="50%"><img src="docs/screenshots/library.png" alt="Přehled knihovny"><br><b>Knihovna</b>: jaký jazyk má každý film a série doopravdy.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/dub-sync.png" alt="Detail synchronizace dabingu"><br><b>Kontrola synchronizace</b>: dabing posunutý o 154 ms, oprava jedním kliknutím.</td>
    <td><img src="docs/screenshots/listening.png" alt="Jazyk ověřený poslechem"><br><b>Ověření poslechem</b>: stopa bez značky, Whisper slyší angličtinu.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/activity.png" alt="Aktivita"><br><b>Aktivita</b>: dokončené upgrady z EN na CZ + EN.</td>
    <td><img src="docs/screenshots/settings.png" alt="Nastavení"><br><b>Nastavení</b>: jazyky, automatika a limity, všechno v rozhraní.</td>
  </tr>
</table>

<p align="center">
  <img src="docs/screenshots/mobile.png" alt="Zobrazení na mobilu" width="280"><br>
  <sub>Funguje i na mobilu – hodí se, když tě na návrh pošle notifikace z Telegramu. Screenshoty jsou z anglického rozhraní.</sub>
</p>

## Rychlý start (Docker)

```bash
git clone https://github.com/nechodom/updaterr.git && cd updaterr
cp .env.example .env              # doplň adresy, API klíče a cesty
docker compose up -d --build
```

Otevři `http://<server>:5290` (port `UPDATERR_PORT`) a v **Nastavení → Jazyky** vyber jazyk dabingu (nebo ho nastav
v `.env`: `PRIMARY_LANGUAGE=cs`, `SECOND_LANGUAGE=en`). Dokud není vybraný, knihovna se neprochází.

### Co kam patří

| Soubor | Co |
| --- | --- |
| `.env` | Vše, co závisí na tvém serveru: port a adresa, URL a API klíče Radarru/Sonarru, cesty ke knihovně, qBittorrent, notifikace, heslo. Vzor: [`.env.example`](.env.example). |
| `docker-compose.yaml` | Obecná definice služby, žádné adresy ani cesty napevno. |
| `docker-compose.override.yaml` | Úpravy pro tvůj server (Docker síť s Radarrem/Sonarrem, `config.xml` s API klíči). Compose ho načte sám, git ho ignoruje. Vzor: [`docker-compose.override.example.yaml`](docker-compose.override.example.yaml). |
| `docker-compose.gpu.yaml` | Volitelně grafická karta pro rozpoznání řeči. |
| `docker-compose.preview.yaml` | Náhled jen pro čtení na jiném portu (viz níže). |
| UI → **Nastavení** | Zbytek: jazyky, intervaly, limity, seedy, slučování, automatika. Ukládá se do `data/state.json`. |

**Cesty:** knihovna musí být v kontejneru pod **stejnou cestou** jako v Radarru, Sonarru a qBittorrentu
(`MEDIA_HOST_DIR` na hostiteli → `MEDIA_DIR` v kontejneru). Pracovní složka `STAGING_DIR` (donory a zálohy) má být
uvnitř, ať jsou zálohy hardlinky na stejném disku. Když jsou filmy a seriály na různých filesystémech, nastav i
`STAGING_DIR_RADARR` a `STAGING_DIR_SONARR`: každá aplikace pak má vlastní pracovní složku na disku své knihovny
a `STAGING_DIR` slouží jen jako záloha.

### Náhled jen pro čtení na jiném portu

Druhá instance vedle běžící, třeba na vyzkoušení nové verze nad skutečnou knihovnou:

```bash
mkdir -p data-preview && cp data/state.json data-preview/     # volitelně: začít z kopie dat
docker compose -p updaterr-preview -f docker-compose.preview.yaml up -d --build
# → http://<server>:5291  (PREVIEW_PORT)
docker compose -p updaterr-preview -f docker-compose.preview.yaml down
```

S `READ_ONLY=true` jen čte knihovnu z Radarru/Sonarru: nic nehledá, nestahuje, neimportuje, nemaže ani neposílá
notifikace a knihovna je připojená jen pro čtení. Nastavení jde měnit, platí ale jen pro kopii dat.

### Bez Dockeru

Node.js 22+, žádné npm závislosti. Pro slučování, kontrolu synchronizace a rozpoznání řeči je potřeba i
`ffmpeg`/`ffprobe`, `mkvtoolnix` a `whisper-cli` z whisper.cpp s modely (viz [Dockerfile](Dockerfile)).

```bash
RADARR_URL=http://localhost:7878 RADARR_API_KEY=… PRIMARY_LANGUAGE=cs PORT=5290 npm start
```

## Jak to funguje

1. **Knihovna.** Každou hodinu načte filmy a série. Skutečný jazyk zjišťuje ze **zvukových stop souboru**
   (MediaInfo z Radarru/Sonarru), ne z názvu. Když MediaInfo jazyk nezná (`und`), použije odhad z názvu a v UI ho
   označí jako „odhad“.
2. **Hledání.** Postupně (výchozí 1 položka za 90 s, ať indexery nezahltí) spouští interaktivní hledání
   v Radarru/Sonarru, tedy přes všechny indexery z Prowlarru. Pořadí: hlídané položky, nikdy nekontrolované,
   jen-EN, neznámé, jen-CZ. Co nic nenašlo, zkusí znovu za `recheckDays`.
3. **Vyhodnocení.** Jazyk releasu čte z názvu (`(CZ/EN)`, `.CZ-FTU`, `CZ dabing`, `MultiDub`…) a pozná, že
   `CZ titulky` / `+ CZtitulky` / `CZ-Sub` jsou titulky, ne dabing. Release bez uvedeného jazyka je originální
   znění; u českých filmů je cílem samotné CZ. Vyřadí mrtvé torrenty (méně než 3 seedy), CAM/TS/3D, releasy mimo
   rozlišení 720p–1080p, příliš velké releasy a „Unknown movie“.
4. **Návrh.** Až 5 kandidátů seřazených podle jazyka, jistoty, rozlišení a seedů. Schválíš na webu nebo tlačítkem
   v Telegramu. Tlačítka odkazují na konkrétní release, takže když se návrh mezitím přehledá, nestáhne se omylem jiný.
5. **Stažení.** Když je výsledek hledání starší než 20 min, nejdřív znovu ověří, že torrent žije. Pak hlídá frontu:
   - **žádný pokrok 3 h**: odebere torrent z klienta, zablokuje ho a stáhne dalšího kandidáta (max. 3 pokusy).
     Pomalý, ale živý torrent se za mrtvý nepovažuje.
   - Radarr/Sonarr odmítne import, protože podle *svých* pravidel to „není upgrade“, nebo Radarr nevyparsuje název
     souboru (třeba překlep v roce): **vynutí ruční import**, kvalitu a jazyky doplní z releasu a naimportuje jen
     největší video. Import, který zůstane zablokovaný, zkouší znovu každých 6 hodin.
   - po importu **ověří zvukové stopy** nového souboru. Když release o jazyku lhal, upozorní a release zablokuje.
   - když stahování selže nebo ho zrušíš, návrh se znovu otevře se zbylými kandidáty.

Pravidla kvality a custom formáty z Radarru/Sonarru Updaterr záměrně **ignoruje** – dabingu nerozumí.

## Funkce podrobně

<details>
<summary><b>Ověření jazyka poslechem</b></summary>

Značky jazyka ve stopách občas lžou – typicky soubory z YouTube mají českou stopu označenou jako `eng`.
Než Updaterr něco nabídne, „poslechne“ si stopy stávajícího souboru: z několika míst vezme 90 s zvuku,
detektor řeči (Silero VAD) vybere jen úseky, kde se mluví, a **Whisper** (`whisper.cpp`, model `base`, běží
lokálně v kontejneru) určí jazyk. Když se řeč jasně liší od značky (např. značka `eng`, slyšet čeština ve
všech úsecích), použije se jazyk podle poslechu a zbytečné návrhy zmizí. Čeština × slovenština se Whisperu
plete, tam platí značka. U seriálu se ověřují 3 epizody série. Trvá to asi 8 s na stopu.

- Čekající návrhy, které vznikly bez ověření, se ověří postupně na pozadí.
- V detailu položky je tlačítko **Ověřit jazyk poslechem** a výsledek pro každou stopu.
- Ověřuje se i po stažení, než se release označí, že o jazyku „lhal“.
- Vypnout jde v Nastavení → Co je upgrade → *Ověřovat jazyk poslechem*.
</details>

<details>
<summary><b>Grafická karta (GPU)</b></summary>

Rozpoznání řeči (Whisper) umí běžet na grafické kartě přes **Vulkan** (`docker-compose.gpu.yaml`). Je to jediná
úloha, které GPU pomůže – měření synchronizace a slučování stop brzdí čtení z disku a dekódování zvuku. Ve Whisperu
GPU zrychlí výpočet a hlavně uvolní procesor pro torrent klienta a mediální server, takže jde použít i přesnější
model **small** (líp rozezná češtinu a slovenštinu).

- Kontejner má `devices: /dev/dri` a `group_add: VIDEO_GID` (skupina, která na hostiteli vlastní `/dev/dri/*`,
  např. `video`). Obraz obsahuje ovladač Vulkan pro AMD (`mesa-vulkan-ati`).
- V obrazu jsou dvě binárky: `whisper-cli` (procesor) a `whisper-cli-vulkan`. Když GPU chybí nebo selže,
  výpočet převezme procesor a GPU se 30 min nezkouší.
- Nastavení → **Grafická karta**: zapnutí/vypnutí, výběr modelu (base / small) a tlačítko **Ověřit** – zkontroluje
  zařízení v kontejneru, oprávnění a ovladač Vulkan, pustí Whisper na testovací nahrávce a porovná výsledek
  i čas s procesorem. Stejné ověření proběhne při každém startu kontejneru (výsledek je v Logu a v Připojení).
- Zkompilované shadery se ukládají do `data/cache/mesa`, ať se nepřipravují po každém novém kontejneru znovu.
</details>

<details>
<summary><b>Slučování zvukových stop (CZ + EN ze dvou releasů)</b></summary>

Když máš třeba film jen s EN a existuje CZ release, Updaterr nabídne kromě výměny celého souboru i
**„Přidat CZ zvuk“** – obraz a ostatní stopy zůstanou ze stávajícího souboru. Nabízí se jen tehdy, když je
jazyk stávajícího souboru ověřený – ze značek stop (MediaInfo), nebo poslechem:

1. Stáhne „donor“ release **přímo do qBittorrentu** (kategorie `updaterr`, mimo Radarr), a z torrentu jen
   potřebné video (u seriálu jen chybějící epizody). Video se stahuje **od začátku** (sekvenčně) a po
   prvních ~48 MB se z něj přes ffprobe zjistí snímková frekvence – **zjevně jiná fps** (rozdíl nad 2 %, např.
   PAL 25 vs 23,976) donor odmítne hned (torrent smaže a zkusí dalšího kandidáta), ne až po stažení celého
   torrentu. Menší rozdíly nechá na úplnou kontrolu v bodě 3 (hlavička MKV bývá zaokrouhlená na celé ms).
2. Podle **skutečných zvukových stop** (ffprobe) ověří, že donor CZ opravdu obsahuje.
3. Zkontroluje snímkovou frekvenci (25 vs 23,976 fps by se rozjíždělo) a délku.
4. **Synchronizace**: na 8 místech filmu porovná „obálku“ zvuku (hudba a ruchy jsou v dabingu i originálu
   stejné) a najde posun. Pozná jiný střih i postupný drift a v tom případě nesloučí. Když přímé porovnání
   nestačí, použije EN stopu donoru jako prostředníka.
5. Sloučí `mkvmerge` (s nalezeným posunem, CZ jako výchozí stopa) a **výsledek znovu ověří** – délku, oba
   jazyky a synchronizaci přímo ve výsledném souboru. Stávající stopy bez značky nebo se špatnou značkou
   dostanou ve výsledku jazyk podle poslechu.
6. Původní soubor zazálohuje (hardlink; bez zálohy se nic nemění) a výsledek naimportuje přes Radarr/Sonarr.

Test na reálném filmu: uměle posunutá CZ stopa o 1,2 s byla srovnána s přesností na 1 ms a CZ stopa
z jiného filmu byla odmítnuta. Vyžaduje `QBIT_URL` + `QBIT_PASSWORD` a `STAGING_DIR` (případně `STAGING_DIR_RADARR` / `STAGING_DIR_SONARR`).
</details>

<details>
<summary><b>Synchronizace dabingu u souborů s oběma jazyky</b></summary>

Soubory, které už CZ i EN stopu mají, se **postupně na pozadí** proměřují stejnou metodou jako při slučování
(CZ proti EN ve stejném souboru). Kontrola šetří disk: obě stopy čte jedním průchodem ffmpegu s nejnižší
prioritou, posun hledá jen v ±10 s a skončí, jakmile je výsledek jistý (typicky 5–6 míst po 80 s, tedy asi
7 % souboru). Mezi soubory dělá pauzu (`syncCheckPauseSec`) a během slučování nebo opravy nečte vůbec.

Posun nad `syncWarnMs` (výchozí 80 ms) se v **Knihovně** ukáže jako „CZ dabing posunutý o X ms“ (filtr
*Posunutý dabing*). V detailu položky je **Opravit synchronizaci** – jen po kliknutí a potvrzení:
CZ stopy se znovu změří na všech 8 místech, `mkvmerge --sync` je posune do nového souboru (obraz, titulky,
kapitoly i přílohy beze změny), výsledek se znovu změří (musí sedět na ±40 ms), originál se zazálohuje
a nový soubor se naimportuje přes Radarr/Sonarr. Ve filtru *Posunutý dabing* je navíc **Opravit vše**: založí
opravu pro všechny zobrazené posunuté položky, které zrovna nic nedělají; opravují se postupně po jedné.

Ověřeno na kopii *Iron Man 2*: CZ dabing −340 ms → po opravě +3 ms (shoda 8/8).
</details>

<details>
<summary><b>Zálohy</b></summary>

Záložka **Zálohy** ukazuje původní soubory, které Updaterr nahradil při slučování zvuku nebo opravě
synchronizace (`STAGING_DIR/backup/<id úlohy>/`): ke které položce patří, kolik zabírají, kdy se smažou
a které soubory obsahují. Záloha vzniká jako hardlink, ale po importu Radarr/Sonarr originál z knihovny smaže,
takže pak záloha **zabírá plnou velikost** – přehled rozlišuje místo opravdu zabrané a sdílené s knihovnou.

- **Retence** (platí i pro stávající zálohy): *Smazat po N dnech* od dokončení úlohy (`keepBackupDays`, výchozí 7)
  a *Max. místo* (`maxBackupGB`, 0 = bez limitu) – nad limit se mažou nejstarší. Před uložením retence, která by
  něco hned smazala, se zobrazí seznam a potvrzení.
- U každé zálohy jde nastavit **vlastní termín** (30 / 90 dní, rok, natrvalo) nebo ji hned **smazat**.
  Zálohy s vlastním termínem limit velikosti nemaže.
- Po nepovedeném importu se záloha drží aspoň 30 dní a podle velikosti se nemaže. Úklid běží každých 10 minut.
</details>

<details>
<summary><b>Hlídání filmů a seriálů</b></summary>

V **Knihovně** ikona oka (nebo detail položky). Hlídaná položka se kontroluje častěji (`watchIntervalDays`,
výchozí 2 dny) a nalezený jistý upgrade (min. `autoMinSeeders` seedů, ne horší rozlišení) **stáhne sama** –
dostaneš jen oznámení. U seriálu platí pro celý seriál, i pro série, které teprve přibudou. Automatický
upgrade jde v detailu vypnout – pak se jen častěji hledá a upgrade se nabídne ke schválení.

**Nové filmy a seriály** může hlídání zapnout samo: Nastavení → Procházení knihovny → *Hlídat nově přidané*
(*Nehlídat* – výchozí, *Hlídat a upgradovat samo*, *Hlídat, upgrade schválím*). Film nebo seriál, který se
v knihovně objeví poprvé, se začne hlídat – když se třeba stáhne jen v EN, dál se hledá upgrade na všechny
hledané jazyky. Při prvním načtení knihovny se nehlídá nic a ručně nastavené hlídání se nepřepisuje.
</details>

<details>
<summary><b>Hledané jazyky a formát videa u položky</b></summary>

V detailu položky → **Hledané jazyky**: *CZ + EN* (výchozí), *Jen CZ* nebo *Jen EN*. S jedním jazykem je cílem
mít ten jeden – ostatní se neřeší (u „Jen CZ“ se nenabízí EN release ani přidání EN stopy a CZ + EN není lepší
než samotné CZ). U seriálu platí pro celý seriál. Po změně se čekající návrhy pročistí a položky se při dalším
průchodu zkontrolují znovu.

V detailu položky → **Formát videa**: *Neřešit* (výchozí), *H.265 / AV1* nebo *Jen AV1*. Když soubor má starší kodek
(podle MediaInfo, např. H.264), hledá se release se **stejným jazykem (nebo lepším) a stejným nebo vyšším
rozlišením** v hledaném kodeku – nabídne se jako *Novější formát*. Kodek releasu se čte z názvu (`x265`, `H.265`,
`HEVC`, `AV1`, `x264`…); release, který kodek neuvádí, se kvůli formátu nenabízí. Úrovně: starší (XviD, MPEG-2…)
› H.264 › H.265 / VP9 › AV1. Kontejner (MKV, MP4) se neřeší.

- Jazyk má přednost: jazykový upgrade se nabídne i ve starším kodeku, jen s varováním „starší formát videa“ a
  v pořadí kandidátů jsou napřed ty v hledaném kodeku.
- Novější kodek = stejný obraz v menším souboru, ne automaticky lepší obraz. Přehrávač ho musí umět dekódovat,
  jinak ho mediální server převádí.
- Automaticky se novější formát stahuje jen u hlídaných položek s automatickým upgradem. Po importu se ověří kodek
  nového souboru; když release lhal, zablokuje se.
</details>

<details>
<summary><b>Seriály: balíky více sérií a sady epizod</b></summary>

- **Balíky více sérií** (`Mr. Robot S01-S04 (CZ/EN)`, `Peaky Blinders S01-S02 (CZ) / S03-S06 (EN)`) – rozsah sérií
  se čte z názvu (`S01-S04`, `S01.S02.S03`, `Season 1-4`, `1.-3. série`…), jazyk zvlášť pro každou část názvu.
  Balík se nabídne jako **jeden návrh pro všechny série, které zlepší**; série, které už jsou stejně dobré, se
  z balíku neimportují. Sonarr takové releasy odmítá, proto se stahují s ručně zadanými epizodami (override).
- **Sady epizod** – když série nemá použitelný balík, ale každá epizoda pod cílovou úrovní má živý lepší
  release, nabídne se celá sada jako jeden kandidát.
- Obojí je jen po schválení a jde vypnout v Nastavení.
</details>

<details>
<summary><b>qBittorrent: zaseknuté torrenty a úklid po importu</b></summary>

**Zaseknuté torrenty.** Nastavení → Stahování a import → *Fronta qBittorrentu* (výchozí vypnuto). Platí **pro
všechny torrenty v qBittorrentu**, i ty z Radarru/Sonarru. Torrent, který stojí bez spojení (`stalledDL`, magnet bez
metadat) déle než `qbitStallMin` (30 min), se zastaví a dostane štítek `updaterr-stalled`, aby uvolnil místo ve
frontě dalším. Každých `qbitStallRetryMin` (120 min) se zastavené znovu spustí: když se rozjedou, štítek zmizí.
Vynucené (force start) a ručně zastavené torrenty se nechávají být.

**Úklid po importu.** Nastavení → Stahování a import → *Po importu smazat torrent* (`qbitRemoveImported`, výchozí
zapnuto). Jakmile je upgrade stažený přes Radarr/Sonarr naimportovaný, Updaterr jeho torrent smaže z qBittorrentu
**i se staženými soubory** – v knihovně zůstává importovaná kopie (hardlink nebo kopie). Týká se jen torrentů ze
stahování Updaterru (párují se podle hashe). Limit seedování v qBittorrentu neplatí pro vynucené torrenty (Force
start), ty by jinak seedovaly navždy. Kdo chce seedovat (sdílecí poměr na privátních trackerech), nastavení vypne.
</details>

<details>
<summary><b>Notifikační centrum</b></summary>

Zvonek v horní liště webu. Sbírá stejné události jako Telegram/ntfy – **i když Telegram ani ntfy nastavené
nejsou**: nové návrhy, automatické stažení a náhradní pokusy, dokončené upgrady, selhání, zablokované importy,
zálohy ke kontrole a chyby z Logu. Opakující se událost (např. nedostupný Radarr) se do 6 h sloučí do jedné
položky s počtem. Kliknutí vede rovnou na místo (návrh, řádek v Aktivitě, detail položky, Zálohy, Log).
Uchovává se posledních 300 oznámení, nejdéle 60 dní.
</details>

## Napojení

### Telegram (doporučeno – tlačítka „Stáhnout“ přímo ve zprávě)

1. U [@BotFather](https://t.me/BotFather) založ bota a zkopíruj token.
2. Napiš botovi cokoli, pak zjisti chat id (`https://api.telegram.org/bot<TOKEN>/getUpdates` nebo @userinfobot).
3. Do `.env` doplň `TELEGRAM_BOT_TOKEN=…` a `TELEGRAM_CHAT_ID=…` a spusť `docker compose up -d`.

Bot používá long-polling, takže nepotřebuje veřejnou adresu. Funguje i ntfy (`NTFY_URL`, `NTFY_TOKEN`).

### qBittorrent (pro slučování stop)

Do `.env` doplň `QBIT_URL=…` a `QBIT_PASSWORD=…` (případně `QBIT_USERNAME`, výchozí `admin`) a spusť
`docker compose up -d`. V Nastavení pak u qBittorrentu uvidíš verzi.

### Okamžitá kontrola nově stažených

Radarr i Sonarr → *Settings → Connect → + → Webhook*, zaškrtnout **On File Import** a **On File Upgrade**:

- Radarr: `http://updaterr:8080/api/webhook/radarr`
- Sonarr: `http://updaterr:8080/api/webhook/sonarr`

(`updaterr` = název kontejneru ve společné Docker síti; jinak adresa serveru a `UPDATERR_PORT`.)
S `WEBHOOK_TOKEN` v `.env` přidej `?token=…`.

### Automatika pro celou knihovnu

Výchozí je **vždy se ptát**. V Nastavení → *Stahovat bez ptaní* jde zapnout „Jen jisté CZ + EN“ (cílové verze)
nebo „Každý jistý upgrade“. Jemnější je hlídání jednotlivých položek (viz výše).

## Jazyky a překlady

Vestavěných je asi 50 jazyků ([`src/languages.js`](src/languages.js)): kódy ISO 639-1/639-2, názvy z Radarru/Sonarru
a slova, kterými jazyk zmiňují názvy releasů (včetně slov pro dabing a titulky, např. `Lektor`/`Napisy` u polštiny,
`VFF`/`VOSTFR` u francouzštiny, `DL` u němčiny). Když tvoje scéna používá jiné slovo, přidej ho do seznamů
`tokens` / `dub` / `sub` – PR vítány. **Místní indexery** (Nastavení) jsou trackery, jejichž releasy „MULTI“ nejspíš
obsahují i hledaný jazyk – pro češtinu třeba `sktorrent,trezzor,cztorrent`.

Texty rozhraní jsou v [`public/locales/<jazyk>.json`](public/locales), texty serveru (log, notifikace, chyby)
v [`src/locales/<jazyk>.json`](src/locales). Nový jazyk = zkopírovat `en.json` pod nový kód v obou složkách
a přeložit; pak se objeví v Nastavení → Jazyky → *Jazyk rozhraní*.

## Omezení

- Balíky bez čísel sérií v názvu („Complete Series“) a releasy, které Sonarr nevyparsuje, se nenabízejí.
- Jazyk kandidáta se odhaduje z názvu – `MULTI` bez dalšího je „odhad“, `.CZ-FTU` se bere jen jako CZ
  (i když často obsahuje i EN). Po stažení se to vždy ověří ze zvukových stop.
- Slučování nepřekódovává – donor s jinou snímkovou frekvencí (PAL 25 fps) se odmítne.
- Pokud má film v Radarru profil s upgrady a Updaterr do něj dá třeba CZ 720p místo EN 1080p, Radarr se ho
  může později pokusit „upgradovat“ zpátky. Pomůže vypnout upgrady v profilu, nebo použít slučování stop.

## Vývoj

```bash
npm test                      # parser jazyků, kodeky, série, kandidáti, stahování, slučování, synchronizace, zálohy, úklid
docker compose up -d --build  # nasazení
```

Bez npm závislostí – jen Node.js 22+, ffmpeg, mkvtoolnix a whisper.cpp (v kontejneru, i s Vulkanem pro GPU).
Image je na čistém Alpine: Node.js z balíků, ffmpeg sestavený jen se součástmi, které aplikace používá,
a modely Whisperu v kvantizaci q8_0 (stejné výsledky jako plné modely, poloviční velikost).

## Licence

[MIT](LICENSE)

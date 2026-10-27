<p align="center">
  <img src="public/logo.svg" width="96" alt="Updaterr logo">
</p>

<h1 align="center">Updaterr</h1>

<p align="center">
  <b>Your Radarr/Sonarr library, in your language.</b><br>
  Updaterr finds better-dubbed releases of the movies and series you already have,<br>
  or adds the missing dub to the file you already have.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-3f74f0"></a>
  <img alt="Node.js 22+" src="https://img.shields.io/badge/node-22%2B-3c873a">
  <img alt="Docker" src="https://img.shields.io/badge/docker-compose-2496ed">
  <img alt="No npm dependencies" src="https://img.shields.io/badge/npm%20dependencies-0-6ee7a8">
  <img alt="About 50 languages" src="https://img.shields.io/badge/dub%20languages-~50-f0a73f">
  <a href="README.cs.md"><img alt="Česky" src="https://img.shields.io/badge/README-%C4%8Desky-lightgrey"></a>
</p>

<p align="center">
  <img src="docs/screenshots/proposals.png" alt="Upgrade proposals: better-dubbed releases ranked by language, quality and seeders" width="100%">
</p>

---

Radarr and Sonarr are very good at quality. Dubbing is a different matter. They will happily keep an English-only
4K file when a release with your dub *and* the original exists, and the language in a release title or a track tag
is often wrong anyway.

Updaterr goes through your library, finds out which languages each file **really** has, and looks for something
better. You pick the dub you want (German, Polish, Czech, French, …) and a second language, usually the original.
The order is:

> **both languages › only the dub › only the second language**, and with the same languages, higher resolution.

Upgrades are offered for one-click approval in the web UI, Telegram or ntfy, or downloaded automatically for
titles you watch.

## Highlights

- **Reads the actual audio tracks** (MediaInfo), not file names. When tags lie, it **listens**: Whisper runs locally
  and identifies the spoken language.
- **Understands release titles** in many scene conventions (`German.DL`, `MULTi.VFF`, `PL.Lektor`, `(CZ/EN)`,
  `CZ titulky`…) and tells a dub from subtitles.
- **Adds a dub to the file you already have.** Keep your 4K English video and take only the German audio from
  another release. The sync is measured, the result is verified and the original is backed up.
- **Picks the first download too.** When you add a movie or series (e.g. from Jellyseerr), Updaterr can grab the
  best-dubbed release right away instead of Radarr/Sonarr, so you don't download the same title twice.
- **Finds dubs that are out of sync** in files you already have and fixes them without re-encoding.
- **Takes care of downloads.** Dead torrents are swapped for the next candidate. Imports that Radarr/Sonarr refuse
  as "not an upgrade" or "unable to parse" are forced through. After import, the language is checked against
  the real audio tracks.
- **Safe to try.** A read-only preview runs next to your real instance and never downloads, imports or deletes
  anything.
- **Light on dependencies.** Plain Node.js with no npm packages, in an Alpine image. The UI is in English and
  Czech, and a new translation is one JSON file per side.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/merge.png" alt="Add audio proposals"><br><b>Add a dub</b>: keep your video, take only the audio track from another release.</td>
    <td width="50%"><img src="docs/screenshots/library.png" alt="Library overview"><br><b>Library</b>: what language every movie and season really has.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/dub-sync.png" alt="Dub sync detail"><br><b>Dub sync check</b>: an offset of 154 ms found, fixed with one click.</td>
    <td><img src="docs/screenshots/listening.png" alt="Language verified by listening"><br><b>Listening check</b>: an untagged track identified as English by Whisper.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/activity.png" alt="Activity"><br><b>Activity</b>: finished upgrades, from EN to CZ + EN.</td>
    <td><img src="docs/screenshots/settings.png" alt="Settings"><br><b>Settings</b>: languages, automation and limits, all in the UI.</td>
  </tr>
</table>

<p align="center">
  <img src="docs/screenshots/mobile.png" alt="Mobile view" width="280"><br>
  <sub>It works on a phone too, handy when a Telegram notification takes you to the proposal.</sub>
</p>

## Quick start (Docker)

```bash
git clone https://github.com/nechodom/updaterr.git && cd updaterr
cp .env.example .env              # addresses, API keys and paths
docker compose up -d --build
```

Open `http://<server>:5290` (`UPDATERR_PORT`) and choose your dub language in **Settings → Languages**, or set
`PRIMARY_LANGUAGE` / `SECOND_LANGUAGE` in `.env`. The library isn't scanned until a dub language is chosen.

### What goes where

| File | What |
| --- | --- |
| `.env` | Everything specific to your server: port and bind address, Radarr/Sonarr URLs and API keys, media paths, qBittorrent, notifications, password. Template: [`.env.example`](.env.example). |
| `docker-compose.yaml` | Generic service definition with no addresses or paths hardcoded. |
| `docker-compose.override.yaml` | Your server-specific additions (the Docker network of your *arr stack, Radarr/Sonarr `config.xml` mounts). Compose loads it automatically and git ignores it. Template: [`docker-compose.override.example.yaml`](docker-compose.override.example.yaml). |
| `docker-compose.gpu.yaml` | Optional GPU (Vulkan) for speech recognition. |
| `docker-compose.preview.yaml` | Read-only preview on another port (see below). |
| UI → **Settings** | Everything else: languages, intervals, limits, seeders, merging, automation. Stored in `data/state.json`. |

**Paths:** mount the media library under the **same path** Radarr, Sonarr and qBittorrent use
(`MEDIA_HOST_DIR` on the host → `MEDIA_DIR` in the container). Keep `STAGING_DIR` (donor downloads and backups)
inside it, so backups are hardlinks on the same disk. If movies and series live on different filesystems, set
`STAGING_DIR_RADARR` and `STAGING_DIR_SONARR` as well: each app then uses its own staging folder on its library's disk,
and `STAGING_DIR` is only the fallback.

### Read-only preview on another port

Run a second instance next to the real one, for example to try a new version against your real library:

```bash
mkdir -p data-preview && cp data/state.json data-preview/     # optional: start from your current data
docker compose -p updaterr-preview -f docker-compose.preview.yaml up -d --build
# → http://<server>:5291  (PREVIEW_PORT)
docker compose -p updaterr-preview -f docker-compose.preview.yaml down
```

With `READ_ONLY=true` it only reads the library from Radarr/Sonarr: no searches, downloads, imports, deletions or
notifications, and the media library is mounted read-only. Settings can be changed, but they only affect the copy.
If Radarr/Sonarr are reachable only inside a Docker network, add that network the same way as in the override
template (`-f docker-compose.preview.yaml -f your-preview.local.yaml`).

### Without Docker

Node.js 22+ with no npm dependencies. Merging, sync checks and speech detection also need `ffmpeg`/`ffprobe`,
`mkvtoolnix` and `whisper-cli` from whisper.cpp with its models (see the [Dockerfile](Dockerfile)).

```bash
RADARR_URL=http://localhost:7878 RADARR_API_KEY=… PRIMARY_LANGUAGE=de PORT=5290 npm start
```

## How it works

1. **Library.** Every hour the movies and series are loaded. The language comes from the file's **audio tracks**
   (MediaInfo from Radarr/Sonarr). When MediaInfo doesn't know it (`und`), the guess from the file name is used and
   marked as "guess" in the UI.
2. **Search.** One item at a time (by default one per 90 s, so indexers aren't hammered), Updaterr runs the
   Radarr/Sonarr interactive search across all your Prowlarr indexers. Order: watched items, never checked, second
   language only, unknown, dub only. Items with nothing better are retried after `recheckDays`.
3. **Evaluation.** The release language is read from the title (`(CZ/EN)`, `German.DL`, `MULTi`, `VFF`, `Lektor`,
   `MultiDub`…). `CZ titulky`, `VOSTFR`, `Napisy` and `Sub` are recognized as subtitles, not dubs. A release with no
   language in the title is taken as the original language; for works whose original *is* your dub language, the
   original alone is the goal. Dead torrents (fewer than 3 seeders), CAM/TS/3D, releases outside 720p–1080p,
   oversized releases and "Unknown movie" are dropped.
4. **Proposal.** Up to 5 candidates, ranked by language, confidence, resolution and seeders. Approve in the web UI
   or with a Telegram button. Buttons point to a specific release, so a later search can't swap it for another.
5. **Download.** If the search result is older than 20 min, Updaterr first checks the torrent is still alive. Then
   it watches the queue:
   - **no progress for 3 h**: the torrent is removed, blocklisted and the next candidate is grabbed (max. 3
     attempts). A slow torrent that is still moving isn't treated as dead.
   - Radarr/Sonarr refuses the import because by *its* rules it's "not an upgrade", or Radarr can't parse the file
     name (e.g. a typo in the year): **forced manual import**, with quality and languages taken from the grabbed
     release and only the largest video file imported. Imports that stay blocked are retried every 6 hours.
   - after import the **audio tracks of the new file are verified**. If the release lied about its language, you
     get a warning and the release is blocklisted.
   - if the download fails or you cancel it, the proposal reopens with the remaining candidates.

Radarr/Sonarr quality profiles and custom formats are deliberately **ignored**, because they don't understand
dubbing.

## Features in detail

<details>
<summary><b>Language check by listening</b></summary>

Track language tags are sometimes wrong, e.g. YouTube rips with a dubbed track tagged `eng`. Before proposing
anything, Updaterr listens to the tracks of the current file: it takes 90 s of audio from several places, a voice
activity detector (Silero VAD) keeps only the speech, and **Whisper** (`whisper.cpp`, model `base`, running locally
in the container) identifies the language. When the speech clearly differs from the tag, the heard language wins and
pointless proposals disappear. Closely related languages that Whisper confuses (Czech × Slovak,
Croatian × Serbian × Bosnian, Indonesian × Malay) keep the tag. For series, 3 episodes per season are checked. It
takes about 8 s per track and can be switched off in Settings.
</details>

<details>
<summary><b>GPU acceleration</b></summary>

Speech recognition can run on a GPU via **Vulkan** (`docker-compose.gpu.yaml`). It's the only task that benefits
from a GPU: Whisper gets faster, the CPU stays free for the torrent client and the media server, and the more
accurate **small** model becomes practical. If the GPU is missing or fails, the CPU takes over and the GPU isn't
retried for 30 min. Settings → **GPU** has a **Check** button that verifies the device, permissions and Vulkan
driver and compares a test transcription with the CPU.
</details>

<details>
<summary><b>Merging audio tracks (two releases → one file)</b></summary>

When you have, say, a movie with English only and a German release exists, Updaterr offers **"Add DE audio"**
next to replacing the whole file. The video and the other tracks stay from your current file.

1. It downloads the "donor" release **directly into qBittorrent** (category `updaterr`, outside Radarr), and only
   the needed video from the torrent (for series, only the missing episodes). The video is downloaded
   **sequentially**. When no full-season donor exists for a series, a set of per-episode torrents is used.
2. It checks the **real audio tracks** (ffprobe) to confirm the donor really has the language.
3. It checks the frame rate and duration. A donor that runs at a **different speed** (PAL 25 fps vs 23.976, or a
   gradual drift like 24 vs 23.976) is **retimed** to your file's tempo with the voice pitch restored, instead of
   being rejected. AAC stays AAC; other codecs become E-AC-3 (max. 5.1).
4. **Synchronization**: at 8 places in the movie it compares the audio "envelope" (music and effects are the same in
   the dub and the original) and finds the offset. A different cut or gradual drift is detected and not merged.
5. It merges with `mkvmerge` (with the offset found, the dub as the default track) and **verifies the result again**.
6. It backs up the original file (hardlink; no backup means no change) and imports the result through Radarr/Sonarr.

- **Different cuts** (Extended, Director's Cut…) are recognized from titles and donors with the same cut are tried
  first. When the dub only exists for another cut, a *Version for the dub* proposal downloads that cut and then adds
  the dub to it. Never automatic.
- **Unsuitable donors are remembered** (by hash and title), listed in the item details and can be unblocked or retried
  from a proposal.
- **Damaged or truncated files** (much shorter than the film) get no audio added; a whole-file *Repair* proposal is
  offered instead, only after approval.
- The added track is named e.g. "German (By: Updaterr)" (`mergeCredit`, can be turned off).

Requires `QBIT_URL` + `QBIT_PASSWORD` and `STAGING_DIR` (or `STAGING_DIR_RADARR` / `STAGING_DIR_SONARR`).
</details>

<details>
<summary><b>First download of new movies and series</b></summary>

Settings → New movies and series → *Updaterr picks the first download* (`firstGrab`, off by default). A movie or a
season that is newly added (e.g. requested in Jellyseerr), newly released or newly monitored is downloaded by
Updaterr with its own rules (both languages › dub › second language, then resolution) instead of Radarr/Sonarr, so
the same title isn't downloaded twice (Radarr's version first, the upgrade right after it).

- *Movies* (`firstGrabMovies`) and *Series* (`firstGrabSeries`, whole seasons incl. multi-season packs; episodes
  still airing are left to Sonarr), both on.
- *Cancel their download* (`firstGrabCancelArr`, on): when Radarr/Sonarr grab a different release first (search after
  adding, RSS), it's cancelled. The same release is left to them.
- *Nothing suitable → Radarr/Sonarr searches* (`firstGrabFallback`, on): when nothing fits or all attempts fail,
  their own search starts. From then on only upgrades.
- New items are picked up every minute, or immediately with the **On Movie Added** / **On Series Add** / **On Grab**
  webhooks. Such downloads have a *New* tag in Activity.
- **Jellyseerr / Seerr**: if it's set to start a search in Radarr/Sonarr after a request, they download first and
  Updaterr has to cancel it. Settings warns about it and shows how to turn it off. Needs `JELLYSEERR_CONFIG` (its
  mounted `settings.json`) or `JELLYSEERR_URL` + `JELLYSEERR_API_KEY`.
</details>

<details>
<summary><b>Bulk check</b></summary>

Library → **Bulk check…**: listen to the tracks of all unverified items (or everything again), or search all items
without the dub / without both languages at once. A progress bar shows how far it got and can be stopped. The
*Show unverified* filter lists items whose language hasn't been confirmed by listening; verified ones get a
headphones icon.
</details>

<details>
<summary><b>Dub sync check for files that already have both languages</b></summary>

Files that already have both languages are **measured in the background** with the same method (dub vs original in
the same file). It reads only ~7 % of the file at the lowest I/O priority. An offset above `syncWarnMs` (default
80 ms) shows in the **Library**. **Fix sync** in the item detail creates a new file with the dub tracks shifted
(`mkvmerge --sync`), measures it again, backs up the original and imports the new file. In the *Out-of-sync dub*
filter, **Fix all** queues a fix for every out-of-sync item shown that is idle; they run one by one.
</details>

<details>
<summary><b>Backups</b></summary>

The **Backups** tab lists the original files replaced by merging or sync fixes (`STAGING_DIR/backup/<job id>/`),
with retention by age (`keepBackupDays`, default 7) and total size (`maxBackupGB`), a custom expiry per backup, or
immediate deletion.
</details>

<details>
<summary><b>Watching movies and series</b></summary>

The eye icon in the **Library**. A watched item is checked more often (`watchIntervalDays`, default 2 days) and a
confident upgrade **is downloaded automatically**; you just get a notification. For series it applies to the whole
series, including seasons added later. Newly added titles can be watched automatically (Settings → Library scanning
→ *Watch newly added*).
</details>

<details>
<summary><b>Wanted languages and video format per item</b></summary>

Item detail → **Wanted languages**: *both* (default), *dub only* or *second language only*. With one language, the
goal is having that one and the other is ignored.

Item detail → **Video format**: *Don't care* (default), *H.265 / AV1* or *AV1 only*. When the file has an older codec
(per MediaInfo, e.g. H.264), Updaterr looks for a release with the **same or better language and the same or higher
resolution** in the wanted codec, offered as *Newer format*. The release codec is read from the title (`x265`,
`H.265`, `HEVC`, `AV1`, `x264`…); releases that don't state it aren't offered. Levels: older (XviD, MPEG-2…) ›
H.264 › H.265 / VP9 › AV1. The container (MKV, MP4) doesn't matter.

- Language comes first: a language upgrade is still offered in an older codec, with an "older video format" warning,
  and candidates in the wanted codec rank first.
- A newer codec means the same picture in a smaller file, not automatically a better picture. Your players must
  decode it, otherwise the media server transcodes.
- A newer format is downloaded automatically only for watched items with auto-upgrade. After import the codec of the
  new file is verified, and a release that lied is blocklisted.
</details>

<details>
<summary><b>Series: multi-season packs and episode sets</b></summary>

- **Multi-season packs** (`Show S01-S04 (DE/EN)`, `Show S01-S02 (CZ) / S03-S06 (EN)`): the season range and the
  language of each part are read from the title, and there is one proposal for all the seasons it improves. Sonarr
  rejects such releases, so they're grabbed with explicit episodes (override).
- **Episode sets**: when a season has no usable pack but every episode below the goal has a live, better release.
</details>

<details>
<summary><b>qBittorrent: stalled torrents and cleanup after import</b></summary>

**Stalled torrents.** Settings → Download and import → *qBittorrent queue* (off by default). It applies to **all
torrents** in qBittorrent except Updaterr's own downloads: a torrent stalled without peers for longer than `qbitStallMin` is stopped and tagged
`updaterr-stalled` to free the queue, and retried every `qbitStallRetryMin`.

**Cleanup after import.** Settings → Download and import → *Delete torrent after import* (`qbitRemoveImported`, on
by default). Once an upgrade grabbed through Radarr/Sonarr is imported, Updaterr deletes its torrent from qBittorrent
**including the downloaded files** (only once the torrent is fully downloaded); the library keeps the imported copy (hardlink or copy). Only torrents from
Updaterr's own downloads are touched (matched by hash). qBittorrent's seeding limit doesn't apply to force-started
torrents, so they would otherwise seed forever. Turn it off if you want to seed (ratio on private trackers).
</details>

<details>
<summary><b>Notification center</b></summary>

The bell in the top bar collects the same events as Telegram/ntfy, **even with neither configured**: new proposals,
automatic downloads and retries, finished upgrades, failures, blocked imports, backups to review and errors from the
log. A repeating event (e.g. Radarr unreachable) is merged into one entry with a count for 6 h. Clicking an entry
takes you to the right place (proposal, activity row, item, backups, log). The last 300 entries are kept, for at
most 60 days.
</details>

## Integrations

### Telegram (recommended: "Download" buttons right in the message)

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Message the bot, then find your chat id (`https://api.telegram.org/bot<TOKEN>/getUpdates` or @userinfobot).
3. Set `TELEGRAM_BOT_TOKEN=…` and `TELEGRAM_CHAT_ID=…` in `.env`, then run `docker compose up -d`.

The bot uses long polling, so it doesn't need a public address. ntfy works too (`NTFY_URL`, `NTFY_TOKEN`).

### Instant check of new downloads

In Radarr and Sonarr go to *Settings → Connect → + → Webhook* and tick **On File Import** and **On File Upgrade**
(for *First download* also **On Movie Added** / **On Series Add** and **On Grab**):

- Radarr: `http://updaterr:8080/api/webhook/radarr`
- Sonarr: `http://updaterr:8080/api/webhook/sonarr`

(`updaterr` is the container name inside a shared Docker network; otherwise use the host and `UPDATERR_PORT`.)
With `WEBHOOK_TOKEN` set, add `?token=…`.

### Automation for the whole library

The default is **always ask**. Settings → *Download without asking* can switch to "Only confident" target versions or "Every confident upgrade".

## Languages

About 50 languages are built in ([`src/languages.js`](src/languages.js)): ISO 639-1/639-2 codes, the names Radarr
and Sonarr use, and the words release titles use for each language, dub and subtitle words included (e.g.
`Lektor`/`Napisy` for Polish, `VFF`/`VOSTFR` for French, `DL` for German). If your scene uses another word, add it to
the `tokens` / `dub` / `sub` lists. PRs welcome. **Local indexers** (Settings) are trackers whose `MULTI` releases
most likely include your dub language.

## Translations

- Web UI: [`public/locales/<lang>.json`](public/locales)
- Server (log, notifications, errors): [`src/locales/<lang>.json`](src/locales)

Copy `en.json` to a new language code in both folders and translate the values. The language then shows up in
Settings → Languages → *Interface language*. Plural forms use `Intl.PluralRules` categories (`one`, `few`, `other`…).

## Limitations

- Packs without season numbers in the title ("Complete Series") and releases Sonarr can't parse aren't offered.
- A candidate's language is estimated from the title, so a bare `MULTI` is a "guess". After download it is always
  verified from the audio tracks.
- Merging doesn't re-encode the video. Only an audio track that has to be retimed (different speed) is re-encoded.
- Multi-season packs that would make some episodes worse get a warning and are never grabbed automatically.
- If a movie's Radarr profile allows upgrades and Updaterr picks e.g. a dubbed 720p over an English 1080p, Radarr may
  later try to "upgrade" it back. Disable upgrades in the profile, or use track merging.

## Development

```bash
npm test                      # language parser, codecs, seasons, candidates, downloads, merging, sync, backups, cleanup
docker compose up -d --build  # deploy
```

No npm dependencies: just Node.js 22+, ffmpeg, mkvtoolnix and whisper.cpp (in the container, with Vulkan for the
GPU). The image is plain Alpine, with Node.js from packages, ffmpeg built with only the parts the app uses, and
Whisper models in q8_0 quantization (same results as the full models at half the size).

## License

[MIT](LICENSE)

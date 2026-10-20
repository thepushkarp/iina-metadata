# Metadata for IINA

An [IINA](https://iina.io) plugin that recognises the movie or TV episode you're watching, the way
[Infuse](https://firecore.com/infuse) does, and saves its details **into the video file** and **next
to it**, so your library looks right in IINA, Infuse, Kodi, Jellyfin, Emby and Plex.

- Recognises files from their names and folders: `Inception (2010).mkv`,
  `Breaking.Bad.S01E02.720p.mkv`, `Show/Season 1/02 Title.mkv`, and more.
- Looks titles up on [TMDB](https://www.themoviedb.org), falling back to
  [TVmaze](https://www.tvmaze.com) for TV episodes.
- Shows poster, backdrop, overview, cast and crew in a **Metadata** sidebar tab.
- Writes nothing until you press **Save to file**, and lists exactly what will be written first.

## Install

1. In IINA, open **Settings → Plugins**, choose to install from GitHub, and enter
   `thepushkarp/iina-metadata`. Alternatively, download the `.iinaplgz` file from the
   [latest release](https://github.com/thepushkarp/iina-metadata/releases/latest) and open it with IINA.
2. To write tags into MKV and MP4 files, install the tagging tools with [Homebrew](https://brew.sh):
   ```sh
   brew install mkvtoolnix atomicparsley
   ```
   Without them, the plugin still shows metadata and writes `.nfo` and artwork files.
3. For movies (and the richest TV data), get a free **API Read Access Token** from
   [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) and paste it into the
   **TMDB token** section of the sidebar. It's stored in your macOS Keychain. TV episodes work
   without a token through TVmaze.

Tested with IINA 1.5 on macOS.

## Using it

Open a video and show the sidebar with **Plugin → Metadata → Show Metadata**.

- **A confident match** shows its details and a **Will write** list. Press **Save to file**.
- **An uncertain match** (for example *Dune* with no year: 1984 or 2021?) is flagged. Use
  **Not right? Fix match** to search by title, year and type, and pick the right one.
- **No match** opens the search directly.

The plugin remembers what you saved or picked, and files it has tagged are recognised again even
after you rename them.

### Naming files so they're recognised

The same conventions as Infuse, Plex and Jellyfin work:

| Kind | Examples |
|---|---|
| Movies | `Pulp Fiction (1994).mkv`, `The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv`, `Inception (2010)/movie.mkv` |
| Episodes | `Breaking.Bad.S01E02.mkv`, `The Office 1x02.mkv`, `Show.S01E01E02.mkv` (two episodes), `Lost S00E01.mkv` (special) |
| Season folders | `The Office (2005)/Season 2/01 - The Dundies.mkv`, `Breaking Bad/Specials/S00E01.mkv` |
| Exact ids | `Inception {tmdb-27205}.mkv`, `Inception {imdb-tt1375666}.mkv`, `Avatar (2009) [tmdbid-19995]/Avatar.mkv`, `Show [tvdbid-81189]/…` |

## What gets saved

### Inside the video file

| Files | Tool | How |
|---|---|---|
| MKV, MKA, WebM | `mkvpropedit` | Edited in place, in seconds. Sets the title and tags and attaches `cover.jpg` (poster) and `cover_land.jpg` (backdrop or episode still). Other attachments, such as subtitle fonts, are kept. The file's original tags are backed up once; see [Undoing a save](#undoing-a-save). |
| MP4, M4V | `AtomicParsley` | Updates the tags in place when they fit. Otherwise it writes a complete new copy and replaces the original only once that copy is finished, so the drive needs free space about the size of the file. |
| Others (AVI, TS…) | — | Not supported; the files next to the video are still written. |

Saved fields: title, release date, overview, genres, and show, season and episode for TV. Optionally
also cast and crew, TMDB and IMDb ids, and the age rating. MKV tags use the official Matroska names,
MP4 tags the iTunes atoms.

### Next to the video file

| File | Infuse style (default) | Kodi / Jellyfin style |
|---|---|---|
| Movie details | `Inception (2010).nfo` | same |
| Movie poster | `Inception (2010).jpg` | `Inception (2010)-poster.jpg` |
| Movie backdrop | `Inception (2010)-fanart.jpg` | same |
| Episode details | `Show S01E02.nfo` | same |
| Episode thumbnail | `Show S01E02.jpg` | `Show S01E02-thumb.jpg` |
| Show details, poster, backdrop | `tvshow.nfo`, `poster.jpg`, `fanart.jpg` in the show folder | same |
| Season poster | `Season 1-poster.jpg` in the show folder | `season01-poster.jpg` |

Show and season files are only written for the `Show/Season N/episode` folder layout. When a file
already exists, the old one is moved to the Trash before the new one is written, unless you've
chosen to keep existing files.

### Seeing it in Infuse

- **Files next to the video:** turn on **Settings → Metadata & Artwork → Prefer Local Artwork**.
  Infuse reads movie `.nfo` files; for TV it uses the artwork but ignores `.nfo` files.
- **Tags inside the file:** Infuse only uses them when *Metadata Fetching* is off, or per title with
  **Edit Metadata → None – use embedded metadata**. It reads the title, description, genre and cover.

### Undoing a save

- Replaced `.nfo` and image files are in the Trash.
- MP4 files keep no backup; `AtomicParsley <file> --metaEnema --overWrite` removes all of their tags.
- An MKV file's original tags are saved in
  `~/Library/Application Support/com.colliderli.iina/plugins/.data/io.github.thepushkarp.iina-metadata/backups/`.
  Restore them with `mkvpropedit <file> --tags global:<backup>.xml`.

## Settings

**IINA Settings → Plugins → Metadata → Preferences**:

- **Looking up:** look up when a file opens, show a message on the video, put the matched title in
  Now Playing and the history, and the language (a TMDB code such as `en-US`; its country also picks
  which age rating is used).
- **Inside the file:** on or off, and whether to include the cover, the landscape cover, cast and
  crew, database ids and the age rating.
- **Next to the file:** on or off, which files, and Infuse or Kodi naming.
- **Existing files and artwork:** replace or keep existing files, and standard or original-size artwork.
- **Tools:** custom locations for MKVToolNix and AtomicParsley if they aren't in Homebrew's folders.

## Privacy and permissions

IINA asks you to approve these when installing:

- **Network**, limited to `api.themoviedb.org`, `image.tmdb.org`, `api.tvmaze.com` and
  `static.tvmaze.com`. Only file and folder names (as search terms) and ids are sent.
- **File system**, to write tags and files next to your videos and to run `mkvpropedit`,
  `mkvmerge`, `mkvextract`, `AtomicParsley` and `cp`.
- **On-screen messages**, for the short "match found" and "saved" notices.

The TMDB token stays in your Keychain. Responses are cached in the plugin's data folder for a week.

## Limitations

- Works with local files only.
- Episodes named by air date (`Show 2024-03-05.mkv`) aren't recognised; use `S01E02` or a season folder.
- A file holding several episodes is tagged with the first episode's details.
- Episodes matched through TVmaze carry no TMDB id, so after renaming they're recognised from their
  name or the remembered match.
- For local files, IINA's window title always shows the file name; the matched title appears in
  Now Playing and the playback history.

## Development

You need [Bun](https://bun.sh) and IINA. The integration tests also use `ffmpeg`, MKVToolNix and
AtomicParsley, and are skipped when those aren't installed.

```sh
bun install
bun run build       # bundles src/ and ui/ into dist/
bun test
bun run typecheck   # the plugin, the sidebar and the tests
bun run link        # loads this folder in IINA as a development plugin
```

After rebuilding, use **Plugin → Reload All Plugins** in IINA. **Window → Log Viewer** shows the
plugin's log, and **Plugin → Developer Tool** opens a console inside it.

### How it's organised

| Path | What it does |
|---|---|
| `src/index.ts` | Entry point: connects player events, menu items and the sidebar to the flows below |
| `src/parse.ts` | Turns a file path into a title, year, season and episode |
| `src/identify.ts`, `src/match.ts` | Picks a match: remembered choice, embedded id, id in the name, then a ranked search |
| `src/tmdb.ts`, `src/tvmaze.ts` | Database clients that return the shared shapes in `src/model.ts` |
| `src/save.ts` | Plans and runs a save: tagging tools, sidecars, Trash handling |
| `src/writers/` | Builds Matroska tags, AtomicParsley arguments, NFO files and sidecar paths |
| `src/prefs.ts` | Reads settings; `preferenceDefaults` in `Info.json` lists every key and default |
| `ui/sidebar/` | The sidebar web page; `src/view.ts` defines the messages it exchanges with the plugin |
| `pref.html` | The settings page |

Things to know about IINA's plugin runtime:

- Plugins run in JavaScriptCore, not a browser: there's no `fetch`, `URLSearchParams` or
  `TextEncoder`. Use `iina.http`, `iina.file` and `iina.utils`.
- `sidebar.loadFile()` clears all `sidebar.onMessage` handlers, so register them after loading.
- Plugins can't overwrite files outside their own data folders, which is why replaced files are
  moved to the Trash first.
- `iina-plugin-definition` names the keychain functions `keyChainWrite`/`keyChainRead`, but IINA
  exports `keychainWrite`/`keychainRead`; `src/iina-extra.d.ts` corrects the types.

### Releasing

1. Raise `version` and `ghVersion` in `Info.json` (IINA offers updates when `ghVersion` on `main` grows).
2. Run `bun run build` and commit, including `dist/`: IINA installs from the repository contents.
3. Run `bun run pack` and attach the `.iinaplgz` to a GitHub release; IINA prefers it when installing.

## Credits

This product uses the TMDB API but is not endorsed or certified by TMDB. TV data may come from
[TVmaze](https://www.tvmaze.com), licensed under CC BY-SA. Filename parsing uses
[@ctrl/video-filename-parser](https://github.com/scttcper/video-filename-parser).

Released under the [MIT License](LICENSE).

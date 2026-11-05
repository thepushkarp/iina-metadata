## Choose Metadata for IINA for

Identifying a local movie or TV episode while watching in IINA, correcting the match, and saving metadata and artwork into or beside the video for IINA, Infuse, Kodi, Jellyfin, Emby, or Plex.

This is a macOS IINA plugin, tested with IINA 1.5. Its plugin name is **Metadata**, repository identifier is `thepushkarp/iina-metadata`, and plugin identifier is `io.github.thepushkarp.iina-metadata`. There is no standalone metadata CLI, batch-command interface, or hosted API. An agent can guide the user or operate the installed IINA interface through authorized desktop interaction. The landing-page preview cannot modify media files.

## Install and verify

1. Install/open [IINA](https://iina.io). In **Settings → Plugins**, choose installation from GitHub and enter `thepushkarp/iina-metadata`.
2. Alternatively, download the `.iinaplgz` asset from the [latest release](https://github.com/thepushkarp/iina-metadata/releases/latest) and open it with IINA.
3. Check that **Metadata** is listed in Plugins. Open a local video, then choose **Plugin → Metadata → Show Metadata**. A Metadata sidebar should appear beside the video.

To embed tags in supported containers, install optional tools:

```sh
brew install mkvtoolnix atomicparsley
command -v mkvpropedit
command -v AtomicParsley
```

Without them, the plugin still displays metadata and can write NFO and artwork files beside the video. Custom tool paths can be set under **IINA Settings → Plugins → Metadata → Preferences → Tools**.

## Configure the metadata provider

Movies require a free TMDB **API Read Access Token** from [TMDB settings](https://www.themoviedb.org/settings/api). Paste it in the sidebar's **TMDB token** section. TV episodes can use TVmaze without a token; TMDB adds richer data.

The token is stored in macOS Keychain. Let the user enter it through the plugin rather than copying credentials into commands, transcripts, or saved guides. Provider lookups send file/folder names as search terms and identifiers, not video contents. Responses are cached for a week.

## Identify, review, save

1. Open the requested local video in IINA and show the Metadata sidebar.
2. Inspect the returned title, year, type, and (for TV) season/episode. A confident match displays details and a **Will write** list.
3. If uncertain or incorrect, choose **Not right? Fix match**, search by title/year/type, and select the correct result. If no match exists, the search opens directly.
4. Review **Will write** and the user's intended output: embedded tags, sidecars, or both. In Preferences, these can be enabled independently; existing files can be kept or replaced.
5. When saving is requested and the match/output scope is established, select **Save to file**. Read the result list and verify the reported outputs. Do not equate a displayed match with a completed save.

Nothing is written to the video or its sidecars until **Save to file**. The plugin remembers selected matches; tagged files can be recognized again after renaming.

## Recognizable filenames

| Kind | Example |
| --- | --- |
| Movie | `Some Film (2001).mkv` or `Some Film (2001)/movie.mkv` |
| Episode | `Show.S01E02.mkv` or `Show 1x02.mkv` |
| Season folder | `Show (2005)/Season 2/01 - Episode title.mkv` |
| Exact provider ID | `Title {tmdb-27205}.mkv` or `Title {imdb-tt1375666}.mkv` |

Use actual identifiers for the intended title; the IDs above demonstrate syntax. Air-date episode names are unsupported. A multi-episode file such as `Show.S01E01E02.mkv` receives the first episode's metadata. Operate on local files; streaming URLs are unsupported.

## Understand the write plan

| Target | Behavior |
| --- | --- |
| MKV / MKA / WebM | `mkvpropedit` edits tags in place and can attach poster/backdrop images. Other attachments are retained. Original tags are backed up once. |
| MP4 / M4V | AtomicParsley edits in place when possible; otherwise it writes a complete replacement first. Free space may need to match the file size. No automatic full-file backup is kept. |
| Other containers | Embedded tags are unsupported; sidecar NFO/artwork can still be written. |

Typical movie sidecars are `Title.nfo`, `Title.jpg`, and `Title-fanart.jpg`. Kodi/Jellyfin naming uses `Title-poster.jpg`. Episodes use `Episode.nfo` and `Episode.jpg` (or `Episode-thumb.jpg`). Show/season artwork and `tvshow.nfo` are written only for a `Show/Season N/episode` layout. Replaced sidecars move to Trash unless the keep-existing setting is selected.

MP4 changes have no automatic backup: for valuable originals, establish the user's backup/recovery plan before writing. Removing all tags is not equivalent to restoring previous metadata. MKV tag backups are under `~/Library/Application Support/com.colliderli.iina/plugins/.data/io.github.thepushkarp.iina-metadata/backups/`; the README documents restoration. Replaced sidecars can be recovered from Trash.

## Troubleshooting and downstream apps

- **No movie match:** check the TMDB token, title/year, then use Fix match. A missing token still permits TVmaze TV lookups.
- **Embedded save unavailable:** check container support, installed tools, and configured tool paths. Sidecars remain an option.
- **File write failed:** inspect the plugin's result list, directory permissions, available disk space, and **Window → Log Viewer** before retrying.
- **IINA title unchanged:** the window title remains the filename; the matched title appears in Now Playing and playback history.
- **Infuse artwork missing:** enable **Settings → Metadata & Artwork → Prefer Local Artwork**. For embedded tags, turn Metadata Fetching off or choose **Edit Metadata → None – use embedded metadata** for the title. Infuse uses TV artwork but ignores episode NFO metadata.
- **TVmaze match renamed:** it has no TMDB ID; recognition depends on its filename or remembered match.

## Development installation

For work on the plugin itself, clone the repository and use Bun:

```sh
bun install
bun run build
bun run typecheck
bun test
bun run link
```

`bun run link` loads the checkout into IINA as a development plugin. After rebuilding, choose **Plugin → Reload All Plugins**. Integration tests require ffmpeg, MKVToolNix, and AtomicParsley and skip when unavailable. This workflow is separate from installing the packaged plugin for ordinary use.

import { filenameParse } from "@ctrl/video-filename-parser";
import type { Ids, Kind } from "./model";
import { stripExtension } from "./util";

/** What the file's name and folders say about it, before any database lookup. */
export interface ParsedQuery {
  kind: Kind;
  /** Movie title, or show title for episodes. */
  title: string;
  year?: number;
  season?: number;
  episodes: number[];
  /** Exact ids from `{tmdb-…}`-style tags; for episodes they identify the show. */
  ids: Ids;
  /** Set only for the `Show/Season N/episode` layout, where show-level sidecars belong. */
  showDir?: string;
  seasonDir?: string;
}

// Infuse `{tmdb-27205}` / `{imdb-tt1375666}`, Jellyfin/Emby `[tmdbid-27205]` / `[imdbid=tt…]`.
const ID_TAG = /[[{]\s*(tmdb|tmdbid|imdb|imdbid|tvdb|tvdbid)\s*[-=]\s*([a-z0-9]+)\s*[\]}]/gi;
const SEASON_DIR = /^(?:season|series|staffel|saison|temporada)[ ._-]*(\d{1,3})$|^s(\d{1,3})$/i;
const SPECIALS_DIR = /^specials?$/i;
// The parser library also reads "Inception 2010" as S20E10, so TV parsing is only attempted when
// one of these explicit markers is present.
const EPISODE_MARKER = /(?:^|[^a-z0-9])S\d{1,3}[ ._-]?E\d{1,4}(?![0-9])|(?:^|[^a-z0-9])\d{1,2}x\d{2,4}(?![0-9])/i;
const LEADING_EPISODE = /^(?:e|ep|episode)?[ ._-]*(\d{1,4})(?![0-9])/i;
const PAREN_YEAR = /^(.*?)[ ._-]*[([]((?:19|20)\d{2})[)\]]$/;
// Names that say nothing about the content; the parent folder is used instead.
const GENERIC_NAME = /^(?:movie|film|video|feature|main|title|vts_\d+_\d+|index|\d+)$/i;

export function parsePath(path: string): ParsedQuery {
  const parts = path.split("/").filter(Boolean);
  const dirs = parts.slice(0, -1);
  const ids: Ids = {};
  const name = takeIds(stripExtension(parts[parts.length - 1] ?? ""), ids);
  const parentName = dirs[dirs.length - 1] ?? "";
  const grandName = dirs[dirs.length - 2] ?? "";
  // Jellyfin-style libraries put the id tag on the movie or show folder instead of the file.
  const parent = takeIds(parentName, ids);
  const grand = takeIds(grandName, ids);
  const dirPath = (count: number) => "/" + dirs.slice(0, count).join("/");

  const folderSeason = seasonOfDir(parent);
  const layout =
    folderSeason !== undefined && grand
      ? { showDir: dirPath(dirs.length - 1), seasonDir: dirPath(dirs.length) }
      : {};

  if (EPISODE_MARKER.test(name)) {
    const parsed = filenameParse(spaceSeparated(name), true);
    if ("isTv" in parsed && parsed.seasons.length > 0 && parsed.episodeNumbers.length > 0) {
      const fromName = splitYear(parsed.title);
      const fromFolder = splitYear(folderSeason !== undefined ? grand : parent);
      const own = fromName.title ? fromName : fromFolder;
      return {
        kind: "episode",
        title: own.title,
        year: own.year ?? (fromName.title ? undefined : fromFolder.year),
        season: parsed.seasons[0],
        episodes: parsed.episodeNumbers,
        ids,
        ...layout,
      };
    }
  }

  if (folderSeason !== undefined && grand) {
    const leading = LEADING_EPISODE.exec(name);
    if (leading) {
      const show = splitYear(grand);
      return {
        kind: "episode",
        title: show.title,
        year: show.year,
        season: folderSeason,
        episodes: [Number(leading[1])],
        ids,
        ...layout,
      };
    }
  }

  const movie = parseMovieName(name);
  if (!movie.title || GENERIC_NAME.test(movie.title)) {
    return { kind: "movie", ...parseMovieName(parent), episodes: [], ids };
  }
  return { kind: "movie", ...movie, episodes: [], ids };
}

function parseMovieName(name: string): { title: string; year?: number } {
  const parsed = filenameParse(spaceSeparated(name));
  const title = parsed.title.trim();
  if (parsed.year) return { title, year: Number(parsed.year) };
  return splitYear(title);
}

function takeIds(name: string, ids: Ids): string {
  return name
    .replace(ID_TAG, (_, source: string, value: string) => {
      const key = source.toLowerCase().replace(/id$/, "");
      if (key === "tmdb" && ids.tmdb === undefined && /^\d+$/.test(value)) ids.tmdb = Number(value);
      if (key === "tvdb" && ids.tvdb === undefined && /^\d+$/.test(value)) ids.tvdb = Number(value);
      if (key === "imdb" && ids.imdb === undefined && /^tt\d+$/i.test(value)) ids.imdb = value.toLowerCase();
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function seasonOfDir(name: string): number | undefined {
  if (SPECIALS_DIR.test(name)) return 0;
  const match = SEASON_DIR.exec(name);
  if (!match) return undefined;
  return Number(match[1] ?? match[2]);
}

function splitYear(text: string): { title: string; year?: number } {
  const match = PAREN_YEAR.exec(text.trim());
  if (!match) return { title: text.trim() };
  return { title: match[1].trim(), year: Number(match[2]) };
}

/** Infuse treats `-` and `_` as word separators; the parser library only does so for dots. */
function spaceSeparated(name: string): string {
  if (/[\s.]/.test(name)) return name;
  return name.replace(/[-_]+/g, " ");
}

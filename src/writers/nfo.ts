import type { CastMember, EpisodeMetadata, Ids, MovieMetadata, ShowMetadata } from "../model";
import { escapeXml } from "../util";

// Kodi NFO format, which Infuse (movies), Jellyfin, Emby and Plex (via XBMCnfo agents) also read.
// Artwork is written as separate image files, so no <thumb>/<fanart> URLs are included.
const HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';

export function movieNfo(meta: MovieMetadata): string {
  return document("movie", [
    element("title", meta.title),
    element("originaltitle", meta.originalTitle),
    element("year", meta.year),
    element("premiered", meta.releaseDate),
    element("tagline", meta.tagline),
    element("plot", meta.overview),
    element("runtime", meta.runtimeMinutes),
    element("mpaa", meta.contentRating),
    ratings(meta.rating),
    ...meta.genres.map((genre) => element("genre", genre)),
    ...meta.directors.map((name) => element("director", name)),
    ...meta.writers.map((name) => element("credits", name)),
    ...meta.studios.map((name) => element("studio", name)),
    ...actors(meta.cast),
    ...uniqueIds(meta.ids),
  ]);
}

export function episodeNfo(meta: EpisodeMetadata): string {
  return document("episodedetails", [
    element("title", meta.title),
    element("showtitle", meta.show.title),
    element("season", meta.season),
    element("episode", meta.episodes[0]),
    element("aired", meta.releaseDate),
    element("plot", meta.overview),
    element("runtime", meta.runtimeMinutes),
    element("mpaa", meta.contentRating),
    ratings(meta.rating),
    ...meta.directors.map((name) => element("director", name)),
    ...meta.writers.map((name) => element("credits", name)),
    ...actors(meta.cast),
    ...uniqueIds(meta.ids),
  ]);
}

export function showNfo(show: ShowMetadata): string {
  return document("tvshow", [
    element("title", show.title),
    element("originaltitle", show.originalTitle),
    element("year", show.year),
    element("premiered", show.premiered),
    element("plot", show.overview),
    element("mpaa", show.contentRating),
    ratings(show.rating),
    ...show.genres.map((genre) => element("genre", genre)),
    element("studio", show.network),
    ...actors(show.cast),
    ...uniqueIds(show.ids),
  ]);
}

/** Empty strings mark absent optional fields and are dropped. */
function document(root: string, children: string[]): string {
  const body = children.filter(Boolean).map((child) => `  ${child}\n`).join("");
  return `${HEADER}\n<${root}>\n${body}</${root}>\n`;
}

/** `<name>value</name>`, or "" when the value is missing. */
function element(name: string, value: string | number | undefined): string {
  if (value === undefined || value === "") return "";
  return `<${name}>${escapeXml(String(value))}</${name}>`;
}

function ratings(rating: number | undefined): string {
  if (rating === undefined) return "";
  return `<ratings><rating name="default" max="10" default="true"><value>${rating.toFixed(1)}</value></rating></ratings>`;
}

function actors(cast: CastMember[]): string[] {
  return cast.map(
    (member, order) =>
      `<actor>${element("name", member.name)}${element("role", member.character)}<order>${order}</order></actor>`,
  );
}

function uniqueIds(ids: Ids): string[] {
  const entries: [string, string | number | undefined][] = [
    ["tmdb", ids.tmdb],
    ["imdb", ids.imdb],
    ["tvdb", ids.tvdb],
    ["tvmaze", ids.tvmaze],
  ];
  const present = entries.filter(([, value]) => value !== undefined);
  return present.map(
    ([type, value], index) =>
      `<uniqueid type="${type}"${index === 0 ? ' default="true"' : ""}>${escapeXml(String(value))}</uniqueid>`,
  );
}

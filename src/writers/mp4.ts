import { episodeCode, type Metadata, tmdbTag } from "../model";
import type { Prefs } from "../prefs";
import { escapeXml } from "../util";

// AtomicParsley rejects ratings outside its built-in list, which would abort the whole write.
const ATOMICPARSLEY_RATINGS = new Set([
  "G", "PG", "PG-13", "R", "NC-17", "Unrated",
  "TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA",
]);
// The `desc` atom holds at most 255 bytes; the full text goes into `ldes`.
const SHORT_DESCRIPTION_BYTES = 255;

/**
 * Arguments for one AtomicParsley run. `--overWrite` updates the tags in place when they fit the
 * file's padding, and otherwise writes a complete copy that replaces the original only once it
 * has been written successfully.
 */
export function atomicParsleyArgs(
  file: string,
  meta: Metadata,
  prefs: Prefs,
  coverPath: string | undefined,
): string[] {
  const args = [file, "--overWrite"];
  const add = (flag: string, value: string | number | undefined) => {
    if (value !== undefined && value !== "") args.push(flag, String(value));
  };
  // Free-form "----" atoms under the reverse-DNS domain iTunes uses for its own extras.
  const addCustom = (name: string, value: string | undefined) => {
    if (value) args.push("--rDNSatom", value, `name=${name}`, "domain=com.apple.iTunes");
  };

  add("--title", meta.title);
  add("--year", meta.releaseDate ? `${meta.releaseDate}T00:00:00Z` : meta.year);
  if (meta.overview) {
    add("--description", truncateUtf8(meta.overview, SHORT_DESCRIPTION_BYTES));
    add("--longdesc", meta.overview);
  }
  add("--genre", meta.genres[0]);
  if (meta.kind === "movie") {
    add("--stik", "Movie");
  } else {
    add("--stik", "TV Show");
    add("--TVShowName", meta.show.title);
    add("--TVSeasonNum", meta.season);
    add("--TVEpisodeNum", meta.episodes[0]);
    add("--TVEpisode", episodeCode(meta.season, meta.episodes));
    add("--TVNetwork", meta.show.network);
  }
  if (prefs.embed_content_rating && ATOMICPARSLEY_RATINGS.has(meta.contentRating ?? "")) {
    add("--contentRating", meta.contentRating);
  }
  if (coverPath) args.push("--artwork", "REMOVE_ALL", "--artwork", coverPath);
  if (prefs.embed_people) addCustom("iTunMOVI", castPlist(meta));
  if (prefs.embed_ids) {
    addCustom("TMDB", tmdbTag(meta));
    addCustom("IMDB", meta.kind === "movie" ? meta.ids.imdb : meta.show.ids.imdb);
  }
  return args;
}

/** The iTunMOVI property list with cast and crew, as read by the TV app and media managers. */
function castPlist(meta: Metadata): string | undefined {
  const sections: [string, string[]][] = [
    ["cast", meta.cast.map((member) => member.name)],
    ["directors", meta.directors],
    ["screenwriters", meta.writers],
  ];
  const people = sections
    .filter(([, names]) => names.length > 0)
    .map(([key, names]) => {
      const entries = names.map((name) => `<dict><key>name</key><string>${escapeXml(name)}</string></dict>`);
      return `<key>${key}</key><array>${entries.join("")}</array>`;
    })
    .join("");
  const studio = meta.studios[0] ? `<key>studio</key><string>${escapeXml(meta.studios[0])}</string>` : "";
  if (!people && !studio) return undefined;
  return (
    '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>' +
    people +
    studio +
    "</dict></plist>"
  );
}

function truncateUtf8(text: string, maxBytes: number): string {
  const ellipsis = "…";
  if (utf8Length(text) <= maxBytes) return text;
  let bytes = utf8Length(ellipsis);
  let result = "";
  for (const char of text) {
    bytes += utf8Length(char);
    if (bytes > maxBytes) break;
    result += char;
  }
  return result.trimEnd() + ellipsis;
}

// No TextEncoder in the plugin's JavaScriptCore context, so count UTF-8 bytes by code point.
function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

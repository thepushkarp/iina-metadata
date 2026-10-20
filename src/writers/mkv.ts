import { type CastMember, type Metadata, tmdbTag } from "../model";
import type { Prefs } from "../prefs";
import { escapeXml } from "../util";

export interface Attachment {
  /** Matroska cover-art convention: "cover.jpg" (portrait) and "cover_land.jpg" (landscape). */
  name: string;
  path: string;
  mimeType: string;
}

interface Simple {
  name: string;
  value: string;
  children?: Simple[];
}

type Entry = [name: string, value: string | number | undefined];

/** Turns name/value pairs into tags, dropping missing values. */
function simples(entries: Entry[]): Simple[] {
  return entries
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([name, value]) => ({ name, value: String(value) }));
}

/**
 * Global tags in mkvtoolnix's XML format, using the official Matroska tag names. Levels: 50 is the
 * movie or episode, 60 the season, 70 the show. Targets carry only TargetTypeValue because Infuse
 * ignores any tag whose Targets also include a TargetType name.
 */
export function matroskaTags(meta: Metadata, prefs: Prefs): string {
  const item = simples([
    ["TITLE", meta.title],
    ["DATE_RELEASED", meta.releaseDate ?? meta.year],
    ["DESCRIPTION", meta.overview],
    ["SYNOPSIS", meta.overview],
    ...meta.genres.map((genre): Entry => ["GENRE", genre]),
    ["LAW_RATING", prefs.embed_content_rating ? meta.contentRating : undefined],
  ]);
  if (prefs.embed_people) {
    item.push(...simples(meta.directors.map((name): Entry => ["DIRECTOR", name])));
    item.push(...simples(meta.writers.map((name): Entry => ["WRITTEN_BY", name])));
    item.push(...actors(meta.cast));
  }
  const ids = prefs.embed_ids;

  if (meta.kind === "movie") {
    if (ids) item.push(...simples([["TMDB", tmdbTag(meta)], ["IMDB", meta.ids.imdb]]));
    return document([tag(50, item)]);
  }

  const show = simples([
    ["TITLE", meta.show.title],
    ["DATE_RELEASED", meta.show.premiered],
    ...(ids
      ? ([
          ["TMDB", tmdbTag(meta)],
          ["IMDB", meta.show.ids.imdb],
          ["TVDB2", meta.show.ids.tvdb ? `series/${meta.show.ids.tvdb}` : undefined],
        ] satisfies Entry[])
      : []),
  ]);
  const episode = [
    ...simples([["PART_NUMBER", meta.episodes[0]]]),
    ...item,
    ...(ids
      ? simples([
          ["IMDB", meta.ids.imdb],
          ["TVDB2", meta.ids.tvdb ? `episodes/${meta.ids.tvdb}` : undefined],
        ])
      : []),
  ];
  return document([tag(70, show), tag(60, simples([["PART_NUMBER", meta.season]])), tag(50, episode)]);
}

function actors(cast: CastMember[]): Simple[] {
  return cast.map((member) => ({
    name: "ACTOR",
    value: member.name,
    children: member.character ? [{ name: "CHARACTER", value: member.character }] : undefined,
  }));
}

function document(tags: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE Tags SYSTEM "matroskatags.dtd">\n<Tags>\n${tags.join("\n")}\n</Tags>\n`;
}

function tag(level: number, content: Simple[]): string {
  return [
    "  <Tag>",
    `    <Targets><TargetTypeValue>${level}</TargetTypeValue></Targets>`,
    ...content.map((simple) => simpleXml(simple, "    ")),
    "  </Tag>",
  ].join("\n");
}

function simpleXml(simple: Simple, indent: string): string {
  const head = `${indent}<Simple><Name>${escapeXml(simple.name)}</Name><String>${escapeXml(simple.value)}</String>`;
  if (!simple.children) return `${head}</Simple>`;
  const children = simple.children.map((child) => simpleXml(child, indent + "  "));
  return `${head}\n${children.join("\n")}\n${indent}</Simple>`;
}

/**
 * One in-place mkvpropedit run: segment title, all global tags, and cover attachments.
 * Covers with the same name are replaced, so repeated saves don't pile up attachments; other
 * attachments (such as subtitle fonts) are left alone.
 */
export function mkvpropeditArgs(
  file: string,
  title: string,
  tagsPath: string,
  attachments: Attachment[],
  existingAttachmentNames: string[],
): string[] {
  const args = [file, "--edit", "info", "--set", `title=${title}`, "--tags", `global:${tagsPath}`];
  for (const attachment of attachments) {
    args.push("--attachment-name", attachment.name, "--attachment-mime-type", attachment.mimeType);
    if (existingAttachmentNames.includes(attachment.name)) {
      args.push("--replace-attachment", `name:${attachment.name.replace(/:/g, "\\c")}:${attachment.path}`);
    } else {
      args.push("--add-attachment", attachment.path);
    }
  }
  return args;
}

/** The parts of `mkvmerge -J` output that decide how to write. */
export function parseMkvmergeIdentify(json: string): { attachmentNames: string[]; hasGlobalTags: boolean } {
  const info = JSON.parse(json);
  return {
    attachmentNames: (info.attachments ?? []).map((attachment: any) => attachment.file_name),
    hasGlobalTags: (info.global_tags ?? []).some((entry: any) => entry.num_entries > 0),
  };
}

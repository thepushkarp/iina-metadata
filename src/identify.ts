import { type Confidence, confidenceOf, rank } from "./match";
import type { Candidate, Kind, MatchRef, Metadata } from "./model";
import type { ParsedQuery } from "./parse";
import type { Tmdb } from "./tmdb";
import type { Tvmaze } from "./tvmaze";

export interface Providers {
  /** Absent until the user stores a TMDB token. */
  tmdb?: Tmdb;
  tvmaze: Tvmaze;
}

type Identification =
  | {
      status: "matched";
      metadata: Metadata;
      ref: MatchRef;
      confidence: Confidence;
      via: string;
      candidates: Candidate[];
    }
  | { status: "unmatched"; reason: string; candidates: Candidate[] };

export class NeedsTokenError extends Error {
  constructor(what: string) {
    super(`${what} needs a TMDB token. Add one in the Metadata sidebar.`);
  }
}

/**
 * Tries, in order: the match the user picked for this path, the TMDB id embedded by a previous
 * save, an id tag in the file or folder name, and finally a title search.
 */
export async function identify(
  query: ParsedQuery,
  providers: Providers,
  hints: { remembered?: MatchRef; embedded?: MatchRef },
): Promise<Identification> {
  const matched = async (ref: MatchRef, confidence: Confidence, via: string, candidates: Candidate[] = []) =>
    ({ status: "matched", metadata: await fetchMetadata(ref, providers), ref, confidence, via, candidates }) as const;

  const known: [string, () => Promise<MatchRef | undefined>][] = [
    ["remembered match", async () => hints.remembered],
    ["embedded id", async () => hints.embedded],
    ["id in filename", () => refFromIds(query, providers)],
  ];
  for (const [via, lookup] of known) {
    const ref = await lookup();
    if (!ref || (ref.provider === "tmdb" && !providers.tmdb)) continue;
    const located = withEpisode(ref, query);
    if (located) return matched(located, "high", via);
  }

  if (!query.title) return { status: "unmatched", reason: "Couldn't read a title from the file name.", candidates: [] };
  const ranked = rank(query, await search(query.kind, query.title, query.year, providers));
  const candidates = ranked.map((entry) => entry.candidate);
  const best = candidates[0];
  if (!best) return { status: "unmatched", reason: `Nothing found for "${query.title}".`, candidates };
  const ref = withEpisode({ provider: best.provider, kind: best.kind, id: best.id }, query);
  if (!ref) return { status: "unmatched", reason: "Season and episode numbers are missing.", candidates };
  return matched(ref, confidenceOf(ranked)!, "search", candidates);
}

/** TMDB first; TV falls back to TVmaze when there is no token or TMDB finds nothing. */
export async function search(kind: Kind, title: string, year: number | undefined, providers: Providers) {
  const { tmdb, tvmaze } = providers;
  if (!tmdb && kind === "movie") throw new NeedsTokenError("Looking up movies");
  if (tmdb) {
    let results = await tmdb.search(kind, title, year);
    // A wrong year in the file name shouldn't hide the right title.
    if (results.length === 0 && year) results = await tmdb.search(kind, title);
    if (results.length > 0 || kind === "movie") return results;
  }
  return tvmaze.searchShows(title);
}

export async function fetchMetadata(ref: MatchRef, providers: Providers): Promise<Metadata> {
  if (ref.provider === "tvmaze") return providers.tvmaze.episode(ref.id, ref.season!, ref.episodes!);
  const { tmdb } = providers;
  if (!tmdb) throw new NeedsTokenError("This TMDB match");
  if (ref.kind === "movie") return tmdb.movie(ref.id);
  return tmdb.episode(ref.id, ref.season!, ref.episodes!);
}

/** Episode refs need season and episode numbers, which only the file name supplies. */
function withEpisode(ref: MatchRef, query: ParsedQuery): MatchRef | undefined {
  if (ref.kind === "movie") return { provider: ref.provider, kind: "movie", id: ref.id };
  const season = query.season ?? ref.season;
  const episodes = query.episodes.length > 0 ? query.episodes : ref.episodes;
  if (season === undefined || !episodes || episodes.length === 0) return undefined;
  return { ...ref, season, episodes };
}

async function refFromIds(query: ParsedQuery, providers: Providers): Promise<MatchRef | undefined> {
  const { ids, kind } = query;
  const { tmdb, tvmaze } = providers;
  if (ids.tmdb) return { provider: "tmdb", kind, id: ids.tmdb };
  if (!ids.imdb && !ids.tvdb) return undefined;
  if (tmdb) {
    const found = ids.imdb ? await tmdb.find("imdb_id", ids.imdb) : await tmdb.find("tvdb_id", String(ids.tvdb));
    const id = kind === "movie" ? found.movie : found.show;
    if (id) return { provider: "tmdb", kind, id };
  }
  if (kind === "episode") {
    const id = ids.imdb ? await tvmaze.lookup("imdb", ids.imdb) : await tvmaze.lookup("thetvdb", String(ids.tvdb));
    if (id) return { provider: "tvmaze", kind, id };
  }
  return undefined;
}

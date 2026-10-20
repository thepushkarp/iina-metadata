import { expect, test } from "bun:test";
import { identify, NeedsTokenError, type Providers } from "../src/identify";
import { type Candidate, type Kind, parseTmdbTag, tmdbTag } from "../src/model";
import { parsePath } from "../src/parse";
import type { Tmdb } from "../src/tmdb";
import type { Tvmaze } from "../src/tvmaze";
import { breakingBadEpisode, breakingBadFromTvmaze, inception } from "./helpers";

const hit = (provider: "tmdb" | "tvmaze", kind: Kind, id: number, title: string, year: number): Candidate => ({
  provider,
  kind,
  id,
  title,
  year,
});

// Fake providers return fixture data; each test overrides only what it is about.
function fakeTmdb(overrides: Partial<Record<keyof Tmdb, unknown>> = {}): Tmdb {
  return {
    search: async (kind: Kind) =>
      kind === "movie" ? [hit("tmdb", "movie", 27205, "Inception", 2010)] : [hit("tmdb", "episode", 1396, "Breaking Bad", 2008)],
    find: async () => ({}),
    movie: async () => inception(),
    episode: async () => breakingBadEpisode(),
    ...overrides,
  } as unknown as Tmdb;
}

function fakeTvmaze(overrides: Partial<Record<keyof Tvmaze, unknown>> = {}): Tvmaze {
  return {
    searchShows: async () => [hit("tvmaze", "episode", 169, "Breaking Bad", 2008)],
    lookup: async () => undefined,
    episode: async () => breakingBadFromTvmaze(),
    ...overrides,
  } as unknown as Tvmaze;
}

const providers = (tmdb: Tmdb = fakeTmdb()): Providers => ({ tmdb, tvmaze: fakeTvmaze() });
const withoutToken: Providers = { tvmaze: fakeTvmaze() };

test("a clear search result is matched with high confidence", async () => {
  const result = await identify(parsePath("/M/Inception (2010).mkv"), providers(), {});
  expect(result).toMatchObject({ status: "matched", via: "search", confidence: "high", ref: { id: 27205 } });
});

test("a match the user picked wins without searching", async () => {
  let searched = false;
  const tmdb = fakeTmdb({ search: async () => ((searched = true), []) });
  const result = await identify(parsePath("/M/Some Name.mkv"), providers(tmdb), {
    remembered: { provider: "tmdb", kind: "movie", id: 27205 },
  });
  expect(result).toMatchObject({ status: "matched", via: "remembered match" });
  expect(searched).toBeFalse();
});

test("a renamed file is recognised from the TMDB id a previous save embedded", async () => {
  const calls: unknown[][] = [];
  const tmdb = fakeTmdb({ episode: async (...args: unknown[]) => (calls.push(args), breakingBadEpisode()) });
  const embedded = parseTmdbTag(tmdbTag(breakingBadEpisode()));
  const result = await identify(parsePath("/TV/renamed S01E02.mkv"), providers(tmdb), { embedded });
  expect(result).toMatchObject({ status: "matched", via: "embedded id" });
  // The embedded tag names the show; season and episode come from the file name.
  expect(calls).toEqual([[1396, 1, [2]]]);
});

test("an IMDb id in the file name is resolved through TMDB", async () => {
  const tmdb = fakeTmdb({ find: async () => ({ movie: 27205 }) });
  const result = await identify(parsePath("/M/Whatever {imdb-tt1375666}.mkv"), providers(tmdb), {});
  expect(result).toMatchObject({ status: "matched", via: "id in filename", ref: { id: 27205 } });
});

test("TV episodes fall back to TVmaze without a token, or when TMDB finds nothing", async () => {
  const path = parsePath("/TV/Breaking.Bad.S01E02.mkv");
  const noToken = await identify(path, withoutToken, {});
  expect(noToken).toMatchObject({ status: "matched", ref: { provider: "tvmaze", id: 169 } });
  const noResults = await identify(path, providers(fakeTmdb({ search: async () => [] })), {});
  expect(noResults).toMatchObject({ status: "matched", ref: { provider: "tvmaze" } });
});

test("movies without a token ask for one", async () => {
  await expect(identify(parsePath("/M/Inception.mkv"), withoutToken, {})).rejects.toBeInstanceOf(
    NeedsTokenError,
  );
});

test("a wrong year in the file name doesn't hide the right title", async () => {
  const years: (number | undefined)[] = [];
  const tmdb = fakeTmdb({
    search: async (_kind: Kind, _title: string, year?: number) => {
      years.push(year);
      return year ? [] : [hit("tmdb", "movie", 27205, "Inception", 2010)];
    },
  });
  const result = await identify(parsePath("/M/Inception (2011).mkv"), providers(tmdb), {});
  expect(years).toEqual([2011, undefined]);
  expect(result).toMatchObject({ status: "matched", ref: { id: 27205 } });
});

test("nothing found is reported as unmatched", async () => {
  const result = await identify(parsePath("/M/Zzzz (1999).mkv"), providers(fakeTmdb({ search: async () => [] })), {});
  expect(result).toMatchObject({ status: "unmatched", candidates: [] });
});

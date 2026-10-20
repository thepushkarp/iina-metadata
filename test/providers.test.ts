import { expect, test } from "bun:test";
import { HttpError } from "../src/http";
import { Tmdb, toMovieMetadata } from "../src/tmdb";
import { Tvmaze } from "../src/tvmaze";
import { breakingBadEpisode, breakingBadFromTvmaze, fixture, inception } from "./helpers";

test("TMDB: the age rating comes from the language's country, skipping blank entries", () => {
  expect(inception().contentRating).toBe("PG-13");
  expect(toMovieMetadata(fixture("tmdb-movie"), "GB").contentRating).toBe("12A");
});

test("TMDB: directors and writers come from the crew, each listed once", () => {
  const meta = inception();
  expect(meta.directors).toEqual(["Christopher Nolan"]);
  expect(meta.writers).toEqual(["Christopher Nolan"]);
});

test("TMDB: an episode uses its season poster and its own cast", () => {
  const meta = breakingBadEpisode();
  expect(meta.poster?.standard).toEndWith("/season1.jpg");
  expect(meta.cast.map((member) => member.name)).toEqual(["Bryan Cranston", "Aaron Paul"]);
  expect(meta.show).toMatchObject({ title: "Breaking Bad", network: "AMC", contentRating: "TV-MA" });
});

test("TMDB: show search reads TV field names", async () => {
  const get = async () => ({ results: [{ id: 1396, name: "Breaking Bad", first_air_date: "2008-01-20" }] });
  const [show] = await new Tmdb(get, "token", "en-US").search("episode", "breaking bad");
  expect(show).toMatchObject({ kind: "episode", id: 1396, title: "Breaking Bad", year: 2008 });
});

test("TVmaze: summaries lose their HTML and artwork is full size", () => {
  const meta = breakingBadFromTvmaze();
  expect(meta.overview).toStartWith("After the accident in the desert");
  expect(meta.overview).not.toContain("<");
  expect(meta.still?.standard).toContain("original_untouched");
});

test("TVmaze: an unknown id is undefined, other failures are errors", async () => {
  const failing = (status: number) =>
    new Tvmaze(async () => {
      throw new HttpError(status, `HTTP ${status}`);
    });
  expect(await failing(404).lookup("imdb", "tt0000000")).toBeUndefined();
  await expect(failing(500).lookup("imdb", "tt0903747")).rejects.toThrow("HTTP 500");
});

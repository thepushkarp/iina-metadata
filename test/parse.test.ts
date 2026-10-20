import { describe, expect, test } from "bun:test";
import { parsePath } from "../src/parse";

describe("parsePath", () => {
  test.each([
    ["/Movies/Pulp Fiction (1994).mkv", "Pulp Fiction", 1994],
    ["/Movies/The.Matrix.1999.REMASTERED.1080p.BluRay.x264-GRP.mkv", "The Matrix", 1999],
    ["/Movies/Captain-America-The-Winter-Soldier-2014.mp4", "Captain America The Winter Soldier", 2014],
    ["/Movies/Inception.avi", "Inception", undefined],
    ["/Movies/Blade Runner 2049 (2017).mkv", "Blade Runner 2049", 2017],
    ["/Movies/Inception (2010)/movie.mkv", "Inception", 2010],
  ])("movie %s", (path, title, year) => {
    const parsed = parsePath(path);
    expect(parsed).toMatchObject({ kind: "movie", title, episodes: [] });
    expect(parsed.year).toBe(year);
  });

  test("scene-style episode", () => {
    expect(parsePath("/TV/Breaking.Bad.S01E02.720p.BluRay.x264-DEMAND.mkv")).toMatchObject({
      kind: "episode",
      title: "Breaking Bad",
      season: 1,
      episodes: [2],
    });
  });

  test("NxNN episode and separators", () => {
    expect(parsePath("/TV/show-name_1x02.mkv")).toMatchObject({ kind: "episode", season: 1, episodes: [2] });
    expect(parsePath("/TV/Lost.S00.E01.mkv")).toMatchObject({ title: "Lost", season: 0, episodes: [1] });
  });

  test("multi-episode file", () => {
    expect(parsePath("/TV/Show.S01E01E02.mkv")).toMatchObject({ season: 1, episodes: [1, 2] });
  });

  test("year in show title is split off", () => {
    expect(parsePath("/TV/Doctor Who (2005) S01E01 Rose.mkv")).toMatchObject({
      title: "Doctor Who",
      year: 2005,
    });
  });

  test("show/season folder layout with bare episode number", () => {
    expect(parsePath("/TV/The Office (2005)/Season 2/01 - The Dundies.mkv")).toEqual({
      kind: "episode",
      title: "The Office",
      year: 2005,
      season: 2,
      episodes: [1],
      ids: {},
      showDir: "/TV/The Office (2005)",
      seasonDir: "/TV/The Office (2005)/Season 2",
    });
  });

  test("episode without show title takes it from folders", () => {
    expect(parsePath("/TV/Breaking Bad/Season 1/S01E02.mkv")).toMatchObject({
      title: "Breaking Bad",
      season: 1,
      episodes: [2],
      showDir: "/TV/Breaking Bad",
    });
    expect(parsePath("/TV/Breaking Bad/Specials/S00E01.mkv")).toMatchObject({ title: "Breaking Bad", season: 0 });
  });

  test("a bare year is not mistaken for season/episode", () => {
    expect(parsePath("/Movies/Inception 2010.mkv")).toMatchObject({ kind: "movie", title: "Inception", year: 2010 });
  });

  test("id tags in file and folder names", () => {
    expect(parsePath("/Movies/Inception {tmdb-27205}.mkv")).toMatchObject({ title: "Inception", ids: { tmdb: 27205 } });
    expect(parsePath("/Movies/Inception {imdb-tt1375666}.mkv").ids).toEqual({ imdb: "tt1375666" });
    expect(parsePath("/Movies/Avatar (2009) [tmdbid-19995]/Avatar.mkv")).toMatchObject({
      title: "Avatar",
      ids: { tmdb: 19995 },
    });
    expect(parsePath("/TV/Show [tvdbid-81189]/Season 1/Show S01E01.mkv").ids).toEqual({ tvdb: 81189 });
  });
});

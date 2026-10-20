import { describe, expect, test } from "bun:test";
import { matroskaTags } from "../src/writers/mkv";
import { atomicParsleyArgs } from "../src/writers/mp4";
import { episodeNfo, movieNfo, showNfo } from "../src/writers/nfo";
import { planSidecars } from "../src/writers/sidecars";
import { breakingBadEpisode, breakingBadFromTvmaze, inception, prefs, tool } from "./helpers";

describe("sidecar file names", () => {
  const paths = (...args: Parameters<typeof planSidecars>) => planSidecars(...args).map((sidecar) => sidecar.path);
  const movie = "/Movies/Inception (2010)/Inception (2010).mkv";
  const episode = "/TV/Breaking Bad/Season 1/Breaking Bad S01E02.mkv";
  const layout = { showDir: "/TV/Breaking Bad", seasonDir: "/TV/Breaking Bad/Season 1" };

  test("movies: Infuse and Kodi naming", () => {
    expect(paths(movie, inception(), {}, prefs())).toEqual([
      "/Movies/Inception (2010)/Inception (2010).nfo",
      "/Movies/Inception (2010)/Inception (2010).jpg",
      "/Movies/Inception (2010)/Inception (2010)-fanart.jpg",
    ]);
    expect(paths(movie, inception(), {}, prefs({ sidecar_style: "kodi" }))).toContain(
      "/Movies/Inception (2010)/Inception (2010)-poster.jpg",
    );
  });

  test("episodes in Show/Season folders also get show and season files", () => {
    expect(paths(episode, breakingBadEpisode(), layout, prefs())).toEqual([
      "/TV/Breaking Bad/Season 1/Breaking Bad S01E02.nfo",
      "/TV/Breaking Bad/Season 1/Breaking Bad S01E02.jpg",
      "/TV/Breaking Bad/tvshow.nfo",
      "/TV/Breaking Bad/poster.jpg",
      "/TV/Breaking Bad/Season 1-poster.jpg",
      "/TV/Breaking Bad/fanart.jpg",
    ]);
    expect(paths(episode, breakingBadEpisode(), layout, prefs({ sidecar_style: "kodi" }))).toContain(
      "/TV/Breaking Bad/season01-poster.jpg",
    );
  });

  test("loose episodes get only their own files, and switched-off outputs are skipped", () => {
    const loose = "/Downloads/Breaking.Bad.S01E02.mkv";
    expect(paths(loose, breakingBadEpisode(), {}, prefs())).toEqual([
      "/Downloads/Breaking.Bad.S01E02.nfo",
      "/Downloads/Breaking.Bad.S01E02.jpg",
    ]);
    expect(paths(loose, breakingBadEpisode(), {}, prefs({ sidecar_nfo: false, sidecar_episode_thumb: false }))).toEqual([]);
  });
});

describe("embedded tags follow the settings", () => {
  const off = prefs({ embed_people: false, embed_ids: false, embed_content_rating: false });

  test("Matroska: people, ids and rating can be left out", () => {
    const tags = matroskaTags(inception(), off);
    for (const name of ["ACTOR", "DIRECTOR", "TMDB", "IMDB", "LAW_RATING"]) expect(tags).not.toContain(name);
    expect(tags).toContain("DESCRIPTION");
  });

  test("Matroska: no TargetType names, which Infuse would skip the tags for", () => {
    expect(matroskaTags(breakingBadEpisode(), prefs())).not.toContain("<TargetType>");
  });

  test("TVmaze matches don't claim a TMDB id", () => {
    expect(matroskaTags(breakingBadFromTvmaze(), prefs())).not.toContain("TMDB");
    expect(atomicParsleyArgs("/a.mp4", breakingBadFromTvmaze(), prefs(), undefined)).not.toContain("name=TMDB");
  });

  test("MP4: the short description fits 255 bytes, even with multi-byte text", () => {
    const args = atomicParsleyArgs("/a.mp4", { ...inception(), overview: "é".repeat(300) }, prefs(), undefined);
    const description = args[args.indexOf("--description") + 1];
    expect(new TextEncoder().encode(description).length).toBeLessThanOrEqual(255);
    expect(args[args.indexOf("--longdesc") + 1]).toBe("é".repeat(300));
  });

  test("MP4: ratings AtomicParsley doesn't know are skipped instead of failing the write", () => {
    const args = atomicParsleyArgs("/a.mp4", { ...inception(), contentRating: "12A" }, prefs(), undefined);
    expect(args).not.toContain("--contentRating");
  });
});

const xmllint = tool("xmllint");

describe.skipIf(!xmllint)("NFO files", () => {
  // Reads a value back with an XML parser, so escaping and structure are checked by a real reader.
  const read = (xml: string, xpath: string) => {
    const result = Bun.spawnSync([xmllint!, "--xpath", `string(${xpath})`, "-"], { stdin: Buffer.from(xml) });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };

  test("special characters survive a round trip", () => {
    expect(read(movieNfo({ ...inception(), title: "Tom & Jerry <3>" }), "/movie/title")).toBe("Tom & Jerry <3>");
  });

  test("Kodi readers find the ids, episode numbers and show details", () => {
    const movie = movieNfo(inception());
    expect(read(movie, '/movie/uniqueid[@type="tmdb"]')).toBe("27205");
    expect(read(movie, '/movie/actor[1]/role')).toBe("Dom Cobb");
    const episode = episodeNfo(breakingBadEpisode());
    expect(read(episode, "/episodedetails/season")).toBe("1");
    expect(read(episode, "/episodedetails/episode")).toBe("2");
    expect(read(showNfo(breakingBadEpisode().show), '/tvshow/uniqueid[@type="tvdb"]')).toBe("81189");
  });
});

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EpisodeMetadata, MovieMetadata } from "../src/model";
import { defaultPrefs, type Prefs } from "../src/prefs";
import { toEpisodeMetadata, toMovieMetadata } from "../src/tmdb";
import { toEpisodeMetadata as tvmazeEpisode } from "../src/tvmaze";

export const fixture = (name: string) => require(`./fixtures/${name}.json`);

export const inception = (): MovieMetadata => toMovieMetadata(fixture("tmdb-movie"), "US");

export const breakingBadEpisode = (): EpisodeMetadata =>
  toEpisodeMetadata(fixture("tmdb-show"), fixture("tmdb-episode"), [2], "US");

/** TVmaze fixtures come from the live API, so their artwork URLs are real. */
export const breakingBadFromTvmaze = (): EpisodeMetadata =>
  tvmazeEpisode(fixture("tvmaze-show"), fixture("tvmaze-episode"), fixture("tvmaze-seasons"), [2]);

export const prefs = (overrides: Partial<Prefs> = {}): Prefs => ({ ...defaultPrefs, ...overrides });

export const tempDir = () => mkdtempSync(join(tmpdir(), "iina-metadata-"));

/** Absolute path of a command-line tool, or undefined when it isn't installed. */
export function tool(name: string): string | undefined {
  return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map((dir) => `${dir}/${name}`).find(existsSync);
}

export function sh(args: string[]): { status: number; out: string } {
  const result = Bun.spawnSync(args);
  return { status: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
}

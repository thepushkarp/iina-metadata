type Provider = "tmdb" | "tvmaze";
export type Kind = "movie" | "episode";

/** One artwork at two sizes; which one is downloaded depends on the `artwork_size` preference. */
export interface Image {
  standard: string;
  original: string;
}

export interface CastMember {
  name: string;
  character?: string;
}

export interface Ids {
  tmdb?: number;
  imdb?: string;
  tvdb?: number;
  tvmaze?: number;
}

interface CommonMetadata {
  provider: Provider;
  title: string;
  originalTitle?: string;
  year?: number;
  /** YYYY-MM-DD */
  releaseDate?: string;
  overview?: string;
  tagline?: string;
  genres: string[];
  /** 0–10 */
  rating?: number;
  /** Certification such as "PG-13" or "TV-MA". */
  contentRating?: string;
  runtimeMinutes?: number;
  directors: string[];
  writers: string[];
  cast: CastMember[];
  studios: string[];
  ids: Ids;
  poster?: Image;
  backdrop?: Image;
}

export interface MovieMetadata extends CommonMetadata {
  kind: "movie";
}

export interface ShowMetadata {
  title: string;
  originalTitle?: string;
  year?: number;
  premiered?: string;
  overview?: string;
  genres: string[];
  rating?: number;
  contentRating?: string;
  network?: string;
  cast: CastMember[];
  ids: Ids;
  poster?: Image;
  backdrop?: Image;
}

/**
 * Fields inherited from CommonMetadata describe the episode itself (title is the episode title,
 * ids are episode ids); `show` holds series-level data.
 */
export interface EpisodeMetadata extends CommonMetadata {
  kind: "episode";
  show: ShowMetadata;
  season: number;
  /** First entry is the episode that was looked up; more than one for multi-episode files. */
  episodes: number[];
  seasonPoster?: Image;
  still?: Image;
}

export type Metadata = MovieMetadata | EpisodeMetadata;

/** A search hit shown in the "Fix match" list. */
export interface Candidate {
  provider: Provider;
  kind: Kind;
  id: number;
  title: string;
  originalTitle?: string;
  year?: number;
  overview?: string;
  poster?: string;
  popularity?: number;
}

/** What the plugin remembers or embeds to re-identify a file without searching. */
export interface MatchRef {
  provider: Provider;
  kind: Kind;
  /** Movie id, or show id for episodes. */
  id: number;
  season?: number;
  episodes?: number[];
}

export function displayTitle(meta: Metadata): string {
  if (meta.kind === "movie") return meta.year ? `${meta.title} (${meta.year})` : meta.title;
  return `${meta.show.title} – ${episodeCode(meta.season, meta.episodes)} – ${meta.title}`;
}

export function episodeCode(season: number, episodes: number[]): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `S${pad(season)}` + episodes.map((e) => `E${pad(e)}`).join("");
}

/**
 * The TMDB id embedded in saved files, in the Matroska `TMDB` tag format ("movie/27205",
 * "tv/1396"). MP4 files carry the same value in a custom atom, so both re-identify alike.
 */
export function tmdbTag(meta: Metadata): string | undefined {
  if (meta.provider !== "tmdb") return undefined;
  return meta.kind === "movie" ? `movie/${meta.ids.tmdb}` : `tv/${meta.show.ids.tmdb}`;
}

export function parseTmdbTag(value: string | undefined | null): MatchRef | undefined {
  const match = /^(movie|tv)\/(\d+)$/.exec((value ?? "").trim());
  if (!match) return undefined;
  return { provider: "tmdb", kind: match[1] === "movie" ? "movie" : "episode", id: Number(match[2]) };
}

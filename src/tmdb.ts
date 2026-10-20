import type { GetJson } from "./http";
import type { Candidate, CastMember, EpisodeMetadata, Image, Kind, MovieMetadata, ShowMetadata } from "./model";
import { nonEmpty, yearOf } from "./util";

const API = "https://api.themoviedb.org/3";
const IMAGES = "https://image.tmdb.org/t/p/";
const CAST_LIMIT = 15;

export class Tmdb {
  constructor(
    private readonly get: GetJson,
    private readonly token: string,
    /** TMDB language code such as "en-US"; its region also picks the certification country. */
    private readonly language: string,
  ) {}

  private request(path: string, params: Record<string, string> = {}): Promise<any> {
    return this.get(
      API + path,
      { language: this.language, ...params },
      { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
    );
  }

  /** Movies, or TV shows for `kind: "episode"`; TMDB names the same fields differently for each. */
  async search(kind: Kind, title: string, year?: number): Promise<Candidate[]> {
    const movie = kind === "movie";
    const params: Record<string, string> = { query: title, include_adult: "false" };
    if (year) params[movie ? "year" : "first_air_date_year"] = String(year);
    const body = await this.request(movie ? "/search/movie" : "/search/tv", params);
    return (body.results ?? []).map(
      (result: any): Candidate => ({
        provider: "tmdb",
        kind,
        id: result.id,
        title: movie ? result.title : result.name,
        originalTitle: movie ? result.original_title : result.original_name,
        year: yearOf(movie ? result.release_date : result.first_air_date),
        overview: nonEmpty(result.overview),
        poster: image(result.poster_path, "w185")?.standard,
        popularity: result.popularity,
      }),
    );
  }

  /** Resolves an IMDb or TVDB id to a TMDB movie or show id. */
  async find(
    source: "imdb_id" | "tvdb_id",
    externalId: string,
  ): Promise<{ movie?: number; show?: number }> {
    const body = await this.request(`/find/${encodeURIComponent(externalId)}`, { external_source: source });
    return { movie: body.movie_results?.[0]?.id, show: body.tv_results?.[0]?.id };
  }

  async movie(id: number): Promise<MovieMetadata> {
    const body = await this.request(`/movie/${id}`, {
      append_to_response: "credits,release_dates,external_ids",
    });
    return toMovieMetadata(body, this.country());
  }

  async episode(showId: number, season: number, episodes: number[]): Promise<EpisodeMetadata> {
    const [show, episode] = await Promise.all([
      this.request(`/tv/${showId}`, { append_to_response: "credits,content_ratings,external_ids" }),
      this.request(`/tv/${showId}/season/${season}/episode/${episodes[0]}`, {
        append_to_response: "credits,external_ids",
      }),
    ]);
    return toEpisodeMetadata(show, episode, episodes, this.country());
  }

  private country(): string {
    return /-([A-Z]{2})$/.exec(this.language)?.[1] ?? "US";
  }
}

function image(path: string | null | undefined, standardSize: string): Image | undefined {
  if (!path) return undefined;
  return { standard: `${IMAGES}${standardSize}${path}`, original: `${IMAGES}original${path}` };
}

function castOf(credits: any): CastMember[] {
  return (credits?.cast ?? [])
    .slice(0, CAST_LIMIT)
    .map((person: any) => ({ name: person.name, character: nonEmpty(person.character) }));
}

function crewNames(crew: any[] | undefined, match: (member: any) => boolean): string[] {
  const names = (crew ?? []).filter(match).map((member) => member.name as string);
  return [...new Set(names)];
}

const isDirector = (member: any) => member.job === "Director";
const isWriter = (member: any) => member.department === "Writing";

export function toMovieMetadata(body: any, country: string): MovieMetadata {
  const releases: any[] = body.release_dates?.results ?? [];
  const certification = releases
    .find((entry) => entry.iso_3166_1 === country)
    ?.release_dates?.map((release: any) => release.certification)
    .find((value: string) => value);
  return {
    kind: "movie",
    provider: "tmdb",
    title: body.title,
    originalTitle: body.original_title !== body.title ? body.original_title : undefined,
    year: yearOf(body.release_date),
    releaseDate: nonEmpty(body.release_date),
    overview: nonEmpty(body.overview),
    tagline: nonEmpty(body.tagline),
    genres: (body.genres ?? []).map((genre: any) => genre.name),
    rating: body.vote_count ? body.vote_average : undefined,
    contentRating: certification,
    runtimeMinutes: body.runtime || undefined,
    directors: crewNames(body.credits?.crew, isDirector),
    writers: crewNames(body.credits?.crew, isWriter),
    cast: castOf(body.credits),
    studios: (body.production_companies ?? []).map((company: any) => company.name),
    ids: {
      tmdb: body.id,
      imdb: nonEmpty(body.imdb_id ?? body.external_ids?.imdb_id),
    },
    poster: image(body.poster_path, "w780"),
    backdrop: image(body.backdrop_path, "w1280"),
  };
}

export function toEpisodeMetadata(
  showBody: any,
  episodeBody: any,
  episodes: number[],
  country: string,
): EpisodeMetadata {
  const show: ShowMetadata = {
    title: showBody.name,
    originalTitle: showBody.original_name !== showBody.name ? showBody.original_name : undefined,
    year: yearOf(showBody.first_air_date),
    premiered: nonEmpty(showBody.first_air_date),
    overview: nonEmpty(showBody.overview),
    genres: (showBody.genres ?? []).map((genre: any) => genre.name),
    rating: showBody.vote_count ? showBody.vote_average : undefined,
    contentRating: (showBody.content_ratings?.results ?? []).find((entry: any) => entry.iso_3166_1 === country)
      ?.rating,
    network: showBody.networks?.[0]?.name,
    cast: castOf(showBody.credits),
    ids: {
      tmdb: showBody.id,
      imdb: nonEmpty(showBody.external_ids?.imdb_id),
      tvdb: showBody.external_ids?.tvdb_id ?? undefined,
    },
    poster: image(showBody.poster_path, "w780"),
    backdrop: image(showBody.backdrop_path, "w1280"),
  };
  const season = episodeBody.season_number;
  const seasonPoster = image(
    (showBody.seasons ?? []).find((entry: any) => entry.season_number === season)?.poster_path,
    "w780",
  );
  const crew = [...(episodeBody.crew ?? []), ...(episodeBody.credits?.crew ?? [])];
  const episodeCast = castOf(episodeBody.credits);
  return {
    kind: "episode",
    provider: "tmdb",
    title: nonEmpty(episodeBody.name) ?? `Episode ${episodeBody.episode_number}`,
    year: yearOf(episodeBody.air_date),
    releaseDate: nonEmpty(episodeBody.air_date),
    overview: nonEmpty(episodeBody.overview),
    genres: show.genres,
    rating: episodeBody.vote_count ? episodeBody.vote_average : undefined,
    contentRating: show.contentRating,
    runtimeMinutes: episodeBody.runtime || undefined,
    directors: crewNames(crew, isDirector),
    writers: crewNames(crew, isWriter),
    cast: episodeCast.length > 0 ? episodeCast : show.cast,
    studios: show.network ? [show.network] : [],
    ids: {
      tmdb: episodeBody.id,
      imdb: nonEmpty(episodeBody.external_ids?.imdb_id),
      tvdb: episodeBody.external_ids?.tvdb_id ?? undefined,
    },
    poster: seasonPoster ?? show.poster,
    backdrop: show.backdrop,
    show,
    season,
    episodes,
    seasonPoster,
    still: image(episodeBody.still_path, "original"),
  };
}

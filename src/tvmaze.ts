import { type GetJson, isNotFound } from "./http";
import type { Candidate, EpisodeMetadata, Image, ShowMetadata } from "./model";
import { nonEmpty, yearOf } from "./util";

const API = "https://api.tvmaze.com";

/** Keyless TV-only fallback, used when no TMDB token is set or TMDB has no match. */
export class Tvmaze {
  constructor(private readonly get: GetJson) {}

  async searchShows(title: string): Promise<Candidate[]> {
    const body: any[] = await this.get(`${API}/search/shows`, { q: title });
    return body.map(({ show }) => ({
      provider: "tvmaze",
      kind: "episode",
      id: show.id,
      title: show.name,
      year: yearOf(show.premiered),
      overview: stripHtml(show.summary),
      poster: show.image?.medium ?? undefined,
      popularity: show.weight,
    }));
  }

  /** Resolves an IMDb or TVDB id to a TVmaze show id; undefined when TVmaze doesn't know it. */
  async lookup(source: "imdb" | "thetvdb", externalId: string): Promise<number | undefined> {
    try {
      const show = await this.get(`${API}/lookup/shows`, { [source]: externalId });
      return show.id;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async episode(showId: number, season: number, episodes: number[]): Promise<EpisodeMetadata> {
    const [show, episode, seasons] = await Promise.all([
      this.get(`${API}/shows/${showId}`, { embed: "cast" }),
      this.get(`${API}/shows/${showId}/episodebynumber`, {
        season: String(season),
        number: String(episodes[0]),
      }),
      this.get(`${API}/shows/${showId}/seasons`),
    ]);
    return toEpisodeMetadata(show, episode, seasons, episodes);
  }
}

/** TVmaze summaries are HTML snippets such as "<p><b>Show</b> follows…</p>". */
function stripHtml(html: string | null | undefined): string | undefined {
  if (!html) return undefined;
  return nonEmpty(
    html
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">"),
  );
}

// TVmaze's "medium" images are thumbnails (~210px), too small for sidecars or embedded covers.
function image(value: { original?: string } | null | undefined): Image | undefined {
  return value?.original ? { standard: value.original, original: value.original } : undefined;
}

export function toEpisodeMetadata(
  showBody: any,
  episodeBody: any,
  seasonsBody: any[],
  episodes: number[],
): EpisodeMetadata {
  const network = showBody.network?.name ?? showBody.webChannel?.name;
  const show: ShowMetadata = {
    title: showBody.name,
    year: yearOf(showBody.premiered),
    premiered: showBody.premiered ?? undefined,
    overview: stripHtml(showBody.summary),
    genres: showBody.genres ?? [],
    rating: showBody.rating?.average ?? undefined,
    network,
    cast: (showBody._embedded?.cast ?? []).map((entry: any) => ({
      name: entry.person.name,
      character: entry.character?.name,
    })),
    ids: {
      tvmaze: showBody.id,
      imdb: showBody.externals?.imdb ?? undefined,
      tvdb: showBody.externals?.thetvdb ?? undefined,
    },
    poster: image(showBody.image),
  };
  const seasonPoster = image(seasonsBody.find((entry) => entry.number === episodeBody.season)?.image);
  return {
    kind: "episode",
    provider: "tvmaze",
    title: episodeBody.name || `Episode ${episodeBody.number}`,
    year: yearOf(episodeBody.airdate),
    releaseDate: episodeBody.airdate || undefined,
    overview: stripHtml(episodeBody.summary),
    genres: show.genres,
    rating: episodeBody.rating?.average ?? undefined,
    runtimeMinutes: episodeBody.runtime ?? undefined,
    directors: [],
    writers: [],
    cast: show.cast,
    studios: network ? [network] : [],
    ids: { tvmaze: episodeBody.id },
    poster: seasonPoster ?? show.poster,
    show,
    season: episodeBody.season,
    episodes,
    seasonPoster,
    still: image(episodeBody.image),
  };
}

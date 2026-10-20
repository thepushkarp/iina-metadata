import type { Candidate } from "./model";

export type Confidence = "high" | "low";

interface Ranked {
  candidate: Candidate;
  score: number;
}

// A match is auto-accepted only when it scores well on its own and clearly beats the runner-up;
// e.g. "Dune" without a year scores the 1984 and 2021 films equally, so the user must pick.
const HIGH_SCORE = 0.85;
const HIGH_MARGIN = 0.08;

export function rank(query: { title: string; year?: number }, candidates: Candidate[]): Ranked[] {
  return candidates
    .map((candidate) => ({ candidate, score: score(query, candidate) }))
    .sort((a, b) => b.score - a.score);
}

export function confidenceOf(ranked: Ranked[]): Confidence | undefined {
  const [best, second] = ranked;
  if (!best) return undefined;
  const clear = !second || best.score - second.score >= HIGH_MARGIN;
  return best.score >= HIGH_SCORE && clear ? "high" : "low";
}

function score(query: { title: string; year?: number }, candidate: Candidate): number {
  const titleScore = Math.max(
    similarity(query.title, candidate.title),
    candidate.originalTitle ? similarity(query.title, candidate.originalTitle) : 0,
  );
  let yearScore = 0.5;
  if (query.year && candidate.year) {
    const diff = Math.abs(query.year - candidate.year);
    yearScore = diff === 0 ? 1 : diff === 1 ? 0.6 : 0;
  }
  // Breaks ties between equally named titles without outweighing a title or year difference.
  const popularity = Math.min(Math.log10(1 + (candidate.popularity ?? 0)) / 3, 1) * 0.03;
  return titleScore * 0.75 + yearScore * 0.25 + popularity;
}

function normalizeTitle(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^(the|a|an) /, "")
    .trim();
}

/** Dice coefficient over character bigrams of the normalized titles (1 = identical). */
function similarity(a: string, b: string): number {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const gram = x.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const gram = y.slice(i, i + 2);
    const count = grams.get(gram) ?? 0;
    if (count > 0) {
      grams.set(gram, count - 1);
      shared++;
    }
  }
  return (2 * shared) / (x.length - 1 + (y.length - 1));
}

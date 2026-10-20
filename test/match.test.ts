import { expect, test } from "bun:test";
import { confidenceOf, rank } from "../src/match";
import type { Candidate } from "../src/model";

const movie = (id: number, title: string, year: number, extra: Partial<Candidate> = {}): Candidate => ({
  provider: "tmdb",
  kind: "movie",
  id,
  title,
  year,
  ...extra,
});

const best = (query: { title: string; year?: number }, candidates: Candidate[]) => {
  const ranked = rank(query, candidates);
  return { id: ranked[0]?.candidate.id, confidence: confidenceOf(ranked) };
};

const dunes = [
  movie(841, "Dune", 1984, { popularity: 20 }),
  movie(438631, "Dune", 2021, { popularity: 90 }),
  movie(693134, "Dune: Part Two", 2024, { popularity: 80 }),
];

test("the year picks between films with the same title", () => {
  expect(best({ title: "Dune", year: 1984 }, dunes)).toEqual({ id: 841, confidence: "high" });
  expect(best({ title: "Dune", year: 2021 }, dunes)).toEqual({ id: 438631, confidence: "high" });
});

test("the same title without a year is left for the user to confirm", () => {
  expect(best({ title: "Dune" }, dunes).confidence).toBe("low");
});

test("a unique title is confident even without a year", () => {
  const candidates = [movie(27205, "Inception", 2010), movie(64956, "Inception: The Cobol Job", 2010)];
  expect(best({ title: "Inception" }, candidates)).toEqual({ id: 27205, confidence: "high" });
});

test("case, accents, punctuation, '&' and leading articles don't matter", () => {
  const candidates = [movie(1, "The Matrix", 1999), movie(2, "Matrix Reloaded", 2003)];
  expect(best({ title: "matrix", year: 1999 }, candidates)).toEqual({ id: 1, confidence: "high" });
  expect(best({ title: "Amelie", year: 2001 }, [movie(194, "Amélie", 2001)]).confidence).toBe("high");
  expect(best({ title: "Tom and Jerry", year: 2021 }, [movie(3, "Tom & Jerry", 2021)]).confidence).toBe("high");
});

test("a file named with the original title matches", () => {
  const candidates = [
    movie(194, "Amélie", 2001, { originalTitle: "Le Fabuleux Destin d'Amélie Poulain" }),
    movie(2, "Fabulous", 2001),
  ];
  expect(best({ title: "Le fabuleux destin d'Amelie Poulain", year: 2001 }, candidates)).toEqual({
    id: 194,
    confidence: "high",
  });
});

test("no candidates means no match", () => {
  const result = best({ title: "Anything" }, []);
  expect(result.id).toBeUndefined();
  expect(result.confidence).toBeUndefined();
});

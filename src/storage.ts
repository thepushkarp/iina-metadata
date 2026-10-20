import type { GetJson } from "./http";
import type { MatchRef } from "./model";

// TMDB's terms cap caching at six months; a week keeps data fresh while avoiding refetches when the
// same file or show is reopened.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MATCHES = "@data/matches.json";

/** IINA creates @data lazily and file.write doesn't create directories. */
export async function ensureDataDirs(): Promise<void> {
  const dirs = ["@data/cache", "@data/backups"].map((dir) => iina.utils.resolvePath(dir));
  const result = await iina.utils.exec("/bin/mkdir", ["-p", ...dirs]);
  if (result.status !== 0) throw new Error(`Creating ${dirs.join(", ")} failed: ${result.stderr}`);
}

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function cachedGetJson(get: GetJson): GetJson {
  return async (url, params = {}, headers) => {
    const key = url + "?" + Object.keys(params).sort().map((name) => `${name}=${params[name]}`).join("&");
    const path = `@data/cache/${fnv1a(key)}.json`;
    if (iina.file.exists(path)) {
      const entry = JSON.parse(iina.file.read(path) ?? "null");
      if (entry && entry.key === key && Date.now() - entry.savedAt < CACHE_TTL_MS) return entry.body;
    }
    const body = await get(url, params, headers);
    iina.file.write(path, JSON.stringify({ key, savedAt: Date.now(), body }));
    return body;
  };
}

function readMatches(): Record<string, MatchRef> {
  if (!iina.file.exists(MATCHES)) return {};
  return JSON.parse(iina.file.read(MATCHES) ?? "{}");
}

export function rememberedMatch(path: string): MatchRef | undefined {
  return readMatches()[path];
}

/** Records a user-confirmed match so reopening the file skips the search. */
export function rememberMatch(path: string, ref: MatchRef): void {
  const matches = readMatches();
  matches[path] = ref;
  iina.file.write(MATCHES, JSON.stringify(matches, null, 1));
}

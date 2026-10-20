// Plugin entry point. IINA runs one instance of this script per player window; it connects the
// player's events and the sidebar to the identify and save flows.
import { iinaGetJson } from "./http";
import { fetchMetadata, identify, type Providers, search } from "./identify";
import { type Confidence, rank } from "./match";
import { type Candidate, displayTitle, type MatchRef, type Metadata, parseTmdbTag } from "./model";
import { type ParsedQuery, parsePath } from "./parse";
import { readPrefs, tmdbLanguage } from "./prefs";
import { buildPlan, executePlan } from "./save";
import { cachedGetJson, ensureDataDirs, rememberedMatch, rememberMatch } from "./storage";
import { Tmdb } from "./tmdb";
import { Tvmaze } from "./tvmaze";
import { errorText, fileName } from "./util";
import type { ChooseRequest, SearchRequest, SearchResponse, TokenResponse, ViewState } from "./view";

const { console, core, event, menu, mpv, sidebar, utils } = iina;

// keychainWrite prefixes the service with the plugin identifier.
const KEYCHAIN_SERVICE = "tmdb";
const KEYCHAIN_ACCOUNT = "api-read-access-token";

let state: ViewState = { phase: "idle", candidates: [], hasToken: false, plan: [], saving: false };
let current: { path: string; query: ParsedQuery; ref?: MatchRef; metadata?: Metadata } | undefined;
// Bumped for every new file or lookup so that late results from an earlier one are dropped.
let generation = 0;
let token = readToken();

function readToken(): string | undefined {
  const stored = utils.keychainRead(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  return typeof stored === "string" && stored ? stored : undefined;
}

function providers(): Providers {
  const get = cachedGetJson(iinaGetJson);
  const language = tmdbLanguage(readPrefs().language, utils.preferredLocalizations());
  return { tmdb: token ? new Tmdb(get, token, language) : undefined, tvmaze: new Tvmaze(get) };
}

// --- Sidebar state ---------------------------------------------------------------------------

/**
 * IINA hands object payloads to the webview inside a JS template literal (String.raw`<json>`), so
 * a backtick or "${" in any TMDB text would break that script and silently drop the message.
 * URI-encoded JSON contains neither; the sidebar decodes it.
 */
function send(name: string, data: unknown): void {
  sidebar.postMessage(name, encodeURIComponent(JSON.stringify(data)));
}

function publish(patch: Partial<ViewState>): void {
  state = { ...state, ...patch, hasToken: Boolean(token) };
  state.plan =
    current?.metadata && state.phase === "matched"
      ? buildPlan(current.path, current.metadata, current.query, readPrefs()).items
      : [];
  send("state", state);
}

function osd(message: string): void {
  if (readPrefs().show_osd) core.osd(message);
}

// --- Flows -----------------------------------------------------------------------------------

function fileLoaded(url: string): void {
  generation++;
  // force-media-title persists across files in mpv, so clear the previous file's title.
  mpv.set("force-media-title", "");
  const reset = { metadata: undefined, confidence: undefined, via: undefined, candidates: [], message: undefined, results: undefined };
  if (core.status.isNetworkResource) {
    current = undefined;
    publish({ ...reset, phase: "unsupported", fileName: undefined, message: "Metadata lookup works for local files only." });
    return;
  }
  const path = url.startsWith("file://") ? decodeURIComponent(url.slice("file://".length)) : url;
  current = { path, query: parsePath(path) };
  publish({ ...reset, phase: "idle", fileName: fileName(path), query: current.query });
  if (readPrefs().auto_identify) void runIdentify();
}

function showMatch(metadata: Metadata, ref: MatchRef, confidence: Confidence, via: string, candidates: Candidate[]) {
  current = { ...current!, metadata, ref };
  if (readPrefs().set_media_title) mpv.set("force-media-title", displayTitle(metadata));
  publish({ phase: "matched", metadata, confidence, via, candidates });
}

async function runIdentify(): Promise<void> {
  if (!current) return;
  const gen = ++generation;
  const { path, query } = current;
  publish({ phase: "identifying", metadata: undefined, results: undefined, message: undefined });
  try {
    const result = await identify(query, providers(), { remembered: rememberedMatch(path), embedded: embeddedRef() });
    if (gen !== generation) return;
    if (result.status === "unmatched") {
      publish({ phase: "unmatched", message: result.reason, candidates: result.candidates });
      osd("No metadata match — search in the Metadata sidebar");
      return;
    }
    showMatch(result.metadata, result.ref, result.confidence, result.via, result.candidates);
    const title = displayTitle(result.metadata);
    osd(result.confidence === "high" ? `${title} — save it from the Metadata sidebar` : `Possible match: ${title} — please confirm`);
  } catch (error) {
    if (gen !== generation) return;
    console.error(`Identifying ${path} failed: ${errorText(error)}`);
    publish({ phase: "error", message: errorText(error) });
  }
}

/** The TMDB id a previous save embedded; mpv exposes container tags under `metadata`. */
function embeddedRef(): MatchRef | undefined {
  try {
    return parseTmdbTag(mpv.getString("metadata/by-key/TMDB"));
  } catch {
    return undefined;
  }
}

async function choose({ candidate, season, episode }: ChooseRequest): Promise<void> {
  if (!current) return;
  const gen = ++generation;
  const { path, query } = current;
  const ref: MatchRef = { provider: candidate.provider, kind: candidate.kind, id: candidate.id };
  if (candidate.kind === "episode") {
    ref.season = season ?? query.season;
    ref.episodes = episode !== undefined ? [episode] : query.episodes;
    if (ref.season === undefined || ref.episodes.length === 0) {
      publish({ phase: "error", message: "Enter the season and episode number for this file." });
      return;
    }
  }
  publish({ phase: "identifying", results: undefined, message: undefined });
  try {
    const metadata = await fetchMetadata(ref, providers());
    if (gen !== generation) return;
    rememberMatch(path, ref);
    showMatch(metadata, ref, "high", "your choice", state.candidates);
  } catch (error) {
    if (gen !== generation) return;
    publish({ phase: "error", message: errorText(error) });
  }
}

async function save(): Promise<void> {
  if (!current?.metadata || !current.ref || state.saving) return;
  const { path, query, metadata, ref } = current;
  publish({ saving: true, results: undefined });
  try {
    const prefs = readPrefs();
    const results = await executePlan(buildPlan(path, metadata, query, prefs), path, metadata, prefs);
    rememberMatch(path, ref);
    publish({ saving: false, results });
    const failed = results.filter((result) => !result.ok).length;
    osd(failed ? `Metadata saved with ${failed} problem(s) — see the sidebar` : "Metadata saved");
  } catch (error) {
    console.error(`Saving metadata for ${path} failed: ${errorText(error)}`);
    publish({ saving: false, results: [{ label: "Save", target: fileName(path), ok: false, message: errorText(error) }] });
  }
}

async function setToken(value: string): Promise<TokenResponse> {
  try {
    // Checks the token before storing it; TMDB answers 401 for invalid ones.
    await iinaGetJson("https://api.themoviedb.org/3/authentication", {}, { Authorization: `Bearer ${value}` });
    if (!utils.keychainWrite(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, value)) {
      throw new Error("Saving the token to the Keychain failed.");
    }
    token = value;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

// --- Wiring ----------------------------------------------------------------------------------

function setUpSidebar(): void {
  sidebar.loadFile("dist/ui/sidebar/index.html");
  // loadFile clears every sidebar.onMessage listener, so handlers must be registered after it.
  sidebar.onMessage("ready", () => publish({}));
  sidebar.onMessage("identify", () => void runIdentify());
  sidebar.onMessage("save", () => void save());
  sidebar.onMessage("choose", (request: ChooseRequest) => void choose(request));
  sidebar.onMessage("open", ({ url }: { url: string }) => utils.open(url));
  sidebar.onMessage("search", async (request: SearchRequest) => {
    let response: SearchResponse;
    try {
      const found = await search(request.kind, request.title, request.year, providers());
      response = { candidates: rank(request, found).map((entry) => entry.candidate) };
    } catch (error) {
      response = { candidates: [], error: errorText(error) };
    }
    send("search-results", response);
  });
  sidebar.onMessage("set-token", async ({ token: value }: { token: string }) => {
    const response = await setToken(value.trim());
    send("token-result", response);
    if (response.ok) void runIdentify();
    else publish({});
  });
  sidebar.onMessage("forget-token", () => {
    // Plugins have no Keychain delete API; an empty value reads as "no token".
    utils.keychainWrite(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, "");
    token = undefined;
    publish({});
  });
}

event.on("iina.window-loaded", setUpSidebar);
event.on("iina.file-loaded", fileLoaded);

menu.addItem(menu.item("Show Metadata", () => sidebar.show()));
menu.addItem(menu.item("Identify Again", () => void runIdentify()));
menu.addItem(menu.item("Save Metadata to File", () => void save()));

ensureDataDirs().catch((error) => console.error(errorText(error)));

// When the plugin is enabled or reloaded mid-playback, the window and file are already loaded and
// their events won't fire again.
if (core.window.loaded) setUpSidebar();
if (!core.status.idle && core.status.url) fileLoaded(core.status.url);

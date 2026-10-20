import { type Candidate, episodeCode, type Metadata } from "../../src/model";
import type { ChooseRequest, PlanItem, SaveResult, SearchResponse, TokenResponse, ViewState } from "../../src/view";

// Injected by IINA into plugin webviews.
declare const iina: {
  postMessage(name: string, data?: unknown): void;
  onMessage(name: string, callback: (data: any) => void): void;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const main = $<HTMLElement>("main");
const fix = $<HTMLElement>("fix");
const searchForm = $<HTMLFormElement>("search-form");
const searchTitle = $<HTMLInputElement>("search-title");
const searchYear = $<HTMLInputElement>("search-year");
const searchKind = $<HTMLSelectElement>("search-kind");
const searchSeason = $<HTMLInputElement>("search-season");
const searchEpisode = $<HTMLInputElement>("search-episode");
const searchStatus = $<HTMLElement>("search-status");
const candidateList = $<HTMLUListElement>("candidates");
const tokenDetails = $<HTMLDetailsElement>("token-details");
const tokenStatus = $<HTMLElement>("token-status");

let state: ViewState | undefined;
let shownCandidates: Candidate[] = [];

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function sourceLink(meta: Metadata): { url: string; name: string } | undefined {
  if (meta.provider === "tvmaze") {
    return meta.kind === "episode" && meta.show.ids.tvmaze
      ? { url: `https://www.tvmaze.com/shows/${meta.show.ids.tvmaze}`, name: "TVmaze" }
      : undefined;
  }
  if (meta.kind === "movie") return { url: `https://www.themoviedb.org/movie/${meta.ids.tmdb}`, name: "TMDB" };
  return {
    url: `https://www.themoviedb.org/tv/${meta.show.ids.tmdb}/season/${meta.season}/episode/${meta.episodes[0]}`,
    name: "TMDB",
  };
}

function statusLine(view: ViewState): string {
  switch (view.phase) {
    case "idle":
      return view.fileName ? "Not looked up yet" : "Open a video to look up its metadata";
    case "unsupported":
      return esc(view.message);
    case "identifying":
      return "Looking up…";
    case "unmatched":
      return "No match found";
    case "error":
      return "Lookup failed";
    case "matched": {
      const badge = view.confidence === "high" ? "Confident match" : "Possible match — please check";
      return `<span class="badge ${esc(view.confidence)}">${badge}</span><span>via ${esc(view.via)}</span>`;
    }
  }
}

function details(meta: Metadata): string {
  const facts: string[] = [];
  let heading: string;
  if (meta.kind === "movie") {
    heading = `<h1>${esc(meta.title)}</h1>`;
    if (meta.year) facts.push(String(meta.year));
  } else {
    heading = `<div class="muted">${esc(meta.show.title)}</div><h1>${esc(meta.title)}</h1>`;
    facts.push(episodeCode(meta.season, meta.episodes));
    if (meta.releaseDate) facts.push(meta.releaseDate);
  }
  if (meta.runtimeMinutes) facts.push(`${meta.runtimeMinutes} min`);
  if (meta.rating) facts.push(`★ ${meta.rating.toFixed(1)}`);
  if (meta.contentRating) facts.push(meta.contentRating);

  const backdrop = (meta.kind === "episode" ? meta.still : undefined) ?? meta.backdrop;
  const link = sourceLink(meta);
  const cast = meta.cast
    .slice(0, 8)
    .map((member) => `<li>${esc(member.name)}${member.character ? ` <span class="muted">as ${esc(member.character)}</span>` : ""}</li>`)
    .join("");
  return `
    ${backdrop ? `<img class="backdrop" src="${esc(backdrop.standard)}" alt="" />` : ""}
    <div class="heading">
      ${meta.poster ? `<img class="poster" src="${esc(meta.poster.standard)}" alt="" />` : ""}
      <div>
        ${heading}
        <div class="facts">${facts.map(esc).join(" · ")}</div>
        ${link ? `<a href="#" data-link="${esc(link.url)}" class="small">View on ${esc(link.name)}</a>` : ""}
      </div>
    </div>
    ${meta.tagline ? `<p class="tagline">${esc(meta.tagline)}</p>` : ""}
    ${meta.overview ? `<p>${esc(meta.overview)}</p>` : ""}
    ${meta.genres.length ? `<div class="chips">${meta.genres.map((g) => `<span class="chip">${esc(g)}</span>`).join("")}</div>` : ""}
    ${meta.directors.length ? `<p class="small"><span class="muted">Directed by</span> ${esc(meta.directors.join(", "))}</p>` : ""}
    ${meta.writers.length ? `<p class="small"><span class="muted">Written by</span> ${esc(meta.writers.join(", "))}</p>` : ""}
    ${cast ? `<h2>Cast</h2><ul class="people small">${cast}</ul>` : ""}
  `;
}

const PLAN_ICONS: Record<PlanItem["action"], string> = { write: "＋", replace: "↻", skip: "–", unavailable: "⚠" };

function plan(items: PlanItem[]): string {
  if (items.length === 0) {
    return `<h2>Will write</h2><p class="small muted">Everything is turned off in the plugin settings.</p>`;
  }
  const rows = items
    .map(
      (item) => `
      <li class="${item.action}">
        <span class="icon">${PLAN_ICONS[item.action]}</span>
        <span>${esc(item.label)}</span>
        <span class="target">${esc(item.target)}</span>
        ${item.detail ? `<span class="small muted">${esc(item.detail)}</span>` : ""}
      </li>`,
    )
    .join("");
  return `<h2>Will write</h2><ul class="plan">${rows}</ul>`;
}

function results(items: SaveResult[]): string {
  const rows = items
    .map(
      (item) => `
      <li class="${item.ok ? "ok" : "failed"}">
        <span class="icon">${item.ok ? "✓" : "✕"}</span>
        <span>${esc(item.label)}</span>
        <span class="target">${esc(item.target)}</span>
        <span class="small ${item.ok ? "muted" : "message error"}">${esc(item.message)}</span>
      </li>`,
    )
    .join("");
  return `<h2>Saved</h2><ul class="results">${rows}</ul>`;
}

function render(view: ViewState): void {
  const parts = [`<div class="status small">${statusLine(view)}</div>`];
  if (view.fileName) parts.push(`<div class="target">${esc(view.fileName)}</div>`);
  if (view.phase === "matched" && view.metadata) {
    parts.push(details(view.metadata));
    parts.push(`
      <div class="actions">
        <button class="primary" data-action="save" ${view.saving ? "disabled" : ""}>
          ${view.saving ? "Saving…" : "Save to file"}
        </button>
        <button class="plain" data-action="open-fix">Not right? Fix match</button>
      </div>`);
    if (view.results) parts.push(results(view.results));
    else parts.push(plan(view.plan));
  } else if (view.phase === "unmatched" || view.phase === "error") {
    parts.push(`<p class="message ${view.phase === "error" ? "error" : ""}">${esc(view.message)}</p>`);
    parts.push(`
      <div class="actions">
        <button data-action="identify">Try again</button>
        <button class="plain" data-action="open-fix">Search manually</button>
      </div>`);
  } else if (view.phase === "idle" && view.fileName) {
    parts.push(`<div class="actions"><button data-action="identify">Look up</button></div>`);
  }
  main.innerHTML = parts.join("");

  $<HTMLElement>("token-missing").hidden = view.hasToken;
  $<HTMLElement>("token-present").hidden = !view.hasToken;
  $<HTMLElement>("token-summary").textContent = view.hasToken ? "TMDB token ✓" : "TMDB token — not set";
  // Point people at the token form when a lookup failed for lack of one.
  if (!view.hasToken && view.phase === "error") tokenDetails.open = true;

  if (view.phase === "unmatched" && fix.hidden) openFix(view.candidates);
}

function renderCandidates(candidates: Candidate[]): void {
  shownCandidates = candidates;
  candidateList.innerHTML = candidates
    .map(
      (candidate, index) => `
      <li data-candidate="${index}">
        ${candidate.poster ? `<img src="${esc(candidate.poster)}" alt="" />` : `<span class="no-poster"></span>`}
        <div>
          <div><strong>${esc(candidate.title)}</strong>${candidate.year ? ` <span class="muted">(${esc(candidate.year)})</span>` : ""}</div>
          <div class="small muted">${candidate.provider === "tmdb" ? "TMDB" : "TVmaze"} · ${candidate.kind === "movie" ? "Movie" : "TV"}</div>
          ${candidate.overview ? `<div class="small overview">${esc(candidate.overview)}</div>` : ""}
        </div>
      </li>`,
    )
    .join("");
}

function syncKind(): void {
  const tv = searchKind.value === "episode";
  document.querySelectorAll<HTMLElement>(".tv-only").forEach((el) => (el.hidden = !tv));
}

function openFix(candidates: Candidate[]): void {
  const query = state?.query;
  if (query) {
    searchTitle.value = query.title;
    searchYear.value = query.year ? String(query.year) : "";
    searchKind.value = query.kind;
    searchSeason.value = query.season !== undefined ? String(query.season) : "";
    searchEpisode.value = query.episodes[0] !== undefined ? String(query.episodes[0]) : "";
  }
  syncKind();
  searchStatus.textContent = candidates.length ? "Other matches for this file:" : "";
  renderCandidates(candidates);
  fix.hidden = false;
  fix.scrollIntoView({ behavior: "smooth" });
}

const numberOrUndefined = (input: HTMLInputElement) => (input.value === "" ? undefined : Number(input.value));

searchKind.addEventListener("change", syncKind);

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  searchStatus.textContent = "Searching…";
  candidateList.innerHTML = "";
  iina.postMessage("search", {
    kind: searchKind.value,
    title: searchTitle.value.trim(),
    year: numberOrUndefined(searchYear),
  });
});

candidateList.addEventListener("click", (event) => {
  const row = (event.target as HTMLElement).closest<HTMLElement>("[data-candidate]");
  if (!row) return;
  const candidate = shownCandidates[Number(row.dataset.candidate)];
  const request: ChooseRequest = {
    candidate,
    season: numberOrUndefined(searchSeason),
    episode: numberOrUndefined(searchEpisode),
  };
  iina.postMessage("choose", request);
  fix.hidden = true;
});

$<HTMLFormElement>("token-form").addEventListener("submit", (event) => {
  event.preventDefault();
  tokenStatus.textContent = "Checking the token with TMDB…";
  iina.postMessage("set-token", { token: $<HTMLInputElement>("token-input").value });
  clearTimeout(tokenCheckTimer);
  tokenCheckTimer = window.setTimeout(() => {
    tokenStatus.textContent = "No answer from the plugin. Check Window › Log Viewer in IINA, then try again.";
  }, 30000);
});

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const link = target.closest<HTMLElement>("[data-link]");
  if (link) {
    event.preventDefault();
    iina.postMessage("open", { url: link.dataset.link });
    return;
  }
  const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
  if (action === "open-fix") openFix(state?.candidates ?? []);
  else if (action === "close-fix") fix.hidden = true;
  else if (action === "forget-token") iina.postMessage("forget-token");
  else if (action) iina.postMessage(action);
});

/** The plugin sends URI-encoded JSON; see `send` in src/index.ts. */
function on<T>(name: string, callback: (data: T) => void): void {
  iina.onMessage(name, (encoded: string) => callback(JSON.parse(decodeURIComponent(encoded))));
}

on<ViewState>("state", (view) => {
  state = view;
  render(view);
});

on<SearchResponse>("search-results", (response) => {
  searchStatus.textContent = response.error ?? (response.candidates.length ? "" : "Nothing found.");
  renderCandidates(response.candidates);
});

let tokenCheckTimer: number | undefined;

on<TokenResponse>("token-result", (response) => {
  clearTimeout(tokenCheckTimer);
  tokenStatus.textContent = response.ok ? "Saved." : `Not saved: ${response.error}`;
  if (response.ok) {
    $<HTMLInputElement>("token-input").value = "";
    tokenDetails.open = false;
  }
});

iina.postMessage("ready");

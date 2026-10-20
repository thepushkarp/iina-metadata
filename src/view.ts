// Messages exchanged between the plugin (src/index.ts) and the sidebar webview (ui/sidebar).
// Everything here must stay JSON-serializable.
import type { Confidence } from "./match";
import type { Candidate, Kind, Metadata } from "./model";
import type { ParsedQuery } from "./parse";

type Phase = "idle" | "unsupported" | "identifying" | "matched" | "unmatched" | "error";

type PlanAction = "write" | "replace" | "skip" | "unavailable";

export interface PlanItem {
  label: string;
  target: string;
  action: PlanAction;
  detail?: string;
}

export interface SaveResult {
  label: string;
  target: string;
  ok: boolean;
  message: string;
}

export interface ViewState {
  phase: Phase;
  fileName?: string;
  query?: ParsedQuery;
  metadata?: Metadata;
  confidence?: Confidence;
  via?: string;
  candidates: Candidate[];
  message?: string;
  hasToken: boolean;
  plan: PlanItem[];
  saving: boolean;
  results?: SaveResult[];
}

export interface SearchRequest {
  kind: Kind;
  title: string;
  year?: number;
}

export interface ChooseRequest {
  candidate: Candidate;
  season?: number;
  episode?: number;
}

export interface SearchResponse {
  candidates: Candidate[];
  error?: string;
}

export interface TokenResponse {
  ok: boolean;
  error?: string;
}

/** "2010-07-15" → 2010. */
export function yearOf(date: string | null | undefined): number | undefined {
  const year = date ? Number(date.slice(0, 4)) : NaN;
  return Number.isFinite(year) ? year : undefined;
}

/** Trimmed text, or undefined for null/blank values so optional fields stay absent. */
export function nonEmpty(text: string | null | undefined): string | undefined {
  return text?.trim() || undefined;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Plain string helpers: the plugin runs in JavaScriptCore, which has no `path` module.
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function dirName(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

export function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

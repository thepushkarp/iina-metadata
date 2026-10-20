import manifest from "../Info.json";

/**
 * The plugin's settings, keyed exactly as in pref.html. `preferenceDefaults` in Info.json is the
 * single list of keys and defaults: add a setting there, then bind it in pref.html.
 */
export type Prefs = typeof manifest.preferenceDefaults;

export const defaultPrefs: Prefs = manifest.preferenceDefaults;

export function readPrefs(): Prefs {
  const prefs = { ...defaultPrefs } as Record<string, unknown>;
  for (const key of Object.keys(defaultPrefs)) {
    const value = iina.preferences.get(key);
    if (value !== undefined && value !== null) prefs[key] = value;
  }
  return prefs as Prefs;
}

/** TMDB wants e.g. "en-US"; macOS localizations look like "en", "en-GB" or "zh-Hans". */
export function tmdbLanguage(preference: string, systemLocalizations: string[]): string {
  if (preference.trim()) return preference.trim();
  const system = systemLocalizations[0] ?? "en-US";
  return system.replace(/^zh-Hans$/, "zh-CN").replace(/^zh-Hant$/, "zh-TW");
}

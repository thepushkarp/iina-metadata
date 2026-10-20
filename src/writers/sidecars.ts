import type { Image, Metadata } from "../model";
import type { Prefs } from "../prefs";
import { dirName, fileName, stripExtension } from "../util";
import { episodeNfo, movieNfo, showNfo } from "./nfo";

export type Sidecar = { path: string; label: string } & (
  | { type: "text"; content: string }
  | { type: "image"; image: Image }
);

/**
 * Lists the files to write next to the video. Infuse and Kodi/Jellyfin agree on NFO and fanart
 * names but differ for movie posters (`<name>.jpg` vs `<name>-poster.jpg`), episode thumbnails
 * (`<name>.jpg` vs `<name>-thumb.jpg`) and season posters (`Season 1-poster.jpg` vs
 * `season01-poster.jpg`). Show-level files need a `Show/Season N/` layout to know where to go.
 */
export function planSidecars(
  videoPath: string,
  meta: Metadata,
  layout: { showDir?: string; seasonDir?: string },
  prefs: Prefs,
): Sidecar[] {
  const base = `${dirName(videoPath)}/${stripExtension(fileName(videoPath))}`;
  const kodi = prefs.sidecar_style === "kodi";
  const result: Sidecar[] = [];
  const addText = (enabled: boolean, label: string, path: string, content: () => string) => {
    if (enabled) result.push({ type: "text", label, path, content: content() });
  };
  const addImage = (enabled: boolean, label: string, pathWithoutExt: string, image: Image | undefined) => {
    if (enabled && image) result.push({ type: "image", label, path: pathWithoutExt + extensionOf(image), image });
  };

  if (meta.kind === "movie") {
    addText(prefs.sidecar_nfo, "Movie NFO", `${base}.nfo`, () => movieNfo(meta));
    addImage(prefs.sidecar_poster, "Poster", kodi ? `${base}-poster` : base, meta.poster);
    addImage(prefs.sidecar_fanart, "Fanart", `${base}-fanart`, meta.backdrop);
    return result;
  }

  addText(prefs.sidecar_nfo, "Episode NFO", `${base}.nfo`, () => episodeNfo(meta));
  addImage(prefs.sidecar_episode_thumb, "Episode thumbnail", kodi ? `${base}-thumb` : base, meta.still);

  const { showDir, seasonDir } = layout;
  if (!prefs.sidecar_show_level || !showDir || !seasonDir) return result;
  const seasonName = !kodi
    ? fileName(seasonDir)
    : meta.season === 0
      ? "season-specials"
      : `season${String(meta.season).padStart(2, "0")}`;
  addText(prefs.sidecar_nfo, "Show NFO", `${showDir}/tvshow.nfo`, () => showNfo(meta.show));
  addImage(prefs.sidecar_poster, "Show poster", `${showDir}/poster`, meta.show.poster);
  addImage(prefs.sidecar_poster, "Season poster", `${showDir}/${seasonName}-poster`, meta.seasonPoster);
  addImage(prefs.sidecar_fanart, "Show fanart", `${showDir}/fanart`, meta.show.backdrop);
  return result;
}

export function extensionOf(image: Image): string {
  return /\.png$/i.test(image.original) ? ".png" : ".jpg";
}

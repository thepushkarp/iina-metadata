import { displayTitle, type Image, type Metadata } from "./model";
import type { ParsedQuery } from "./parse";
import type { Prefs } from "./prefs";
import { fnv1a } from "./storage";
import { findTools, INSTALL_HINT, run, tail, type ToolSet } from "./tools";
import { dirName, errorText, extension, fileName } from "./util";
import type { PlanItem, SaveResult } from "./view";
import { type Attachment, matroskaTags, mkvpropeditArgs, parseMkvmergeIdentify } from "./writers/mkv";
import { atomicParsleyArgs } from "./writers/mp4";
import { extensionOf, planSidecars, type Sidecar } from "./writers/sidecars";

const MKV_EXTENSIONS = new Set(["mkv", "mka", "mk3d", "webm"]);
const MP4_EXTENSIONS = new Set(["mp4", "m4v"]);

interface EmbedJob {
  container: "mkv" | "mp4";
  tools: ToolSet;
  cover?: Image;
  landscapeCover?: Image;
  item: PlanItem;
}

/** What a save will do; `items` is shown in the sidebar before anything is written. */
export interface SavePlan {
  items: PlanItem[];
  embed?: EmbedJob;
  sidecars: { sidecar: Sidecar; item: PlanItem }[];
}

/** Downloads an artwork image (once) and returns its local path. */
type Download = (image: Image) => Promise<string>;

export function buildPlan(videoPath: string, meta: Metadata, query: ParsedQuery, prefs: Prefs): SavePlan {
  const items: PlanItem[] = [];
  let embed: EmbedJob | undefined;
  if (prefs.embed_enabled) {
    const planned = planEmbed(videoPath, meta, prefs);
    items.push(planned.item);
    embed = planned.job;
  }

  const sidecars: SavePlan["sidecars"] = [];
  if (prefs.sidecar_enabled) {
    const videoDir = dirName(videoPath);
    for (const sidecar of planSidecars(videoPath, meta, query, prefs)) {
      const exists = iina.file.exists(sidecar.path);
      const item: PlanItem = { label: sidecar.label, target: relativePath(videoDir, sidecar.path), action: "write" };
      if (exists && prefs.existing_files === "skip") {
        item.action = "skip";
        item.detail = "Already exists; kept because of your settings.";
      } else if (exists) {
        item.action = "replace";
        item.detail = "The current file goes to the Trash.";
      }
      sidecars.push({ sidecar, item });
      items.push(item);
    }
  }
  return { items, embed, sidecars };
}

function planEmbed(videoPath: string, meta: Metadata, prefs: Prefs): { item: PlanItem; job?: EmbedJob } {
  const target = fileName(videoPath);
  const type = extension(target);
  const container = MKV_EXTENSIONS.has(type) ? "mkv" : MP4_EXTENSIONS.has(type) ? "mp4" : undefined;
  const unavailable = (detail: string) => ({
    item: { label: "Embed in file", target, action: "unavailable", detail } satisfies PlanItem,
  });
  if (!container) return unavailable(`Tags can't be embedded in .${type} files; sidecar files still work.`);

  const tools = findTools(prefs.mkvtoolnix_dir.trim(), prefs.atomicparsley_path.trim());
  const ready = container === "mkv" ? tools.mkvpropedit && tools.mkvmerge && tools.mkvextract : tools.atomicParsley;
  if (!ready) return unavailable(container === "mkv" ? INSTALL_HINT.mkvtoolnix : INSTALL_HINT.atomicParsley);

  const cover = prefs.embed_cover ? meta.poster : undefined;
  // Matroska only: episodes use their still as the landscape cover, falling back to the backdrop.
  const landscapeCover =
    container === "mkv" && prefs.embed_landscape_cover
      ? (meta.kind === "episode" ? meta.still : undefined) ?? meta.backdrop
      : undefined;
  const item: PlanItem = {
    label: "Embed in file",
    target,
    action: "write",
    detail: embedSummary(container, meta, prefs, Boolean(cover), Boolean(landscapeCover)),
  };
  return { item, job: { container, tools, cover, landscapeCover, item } };
}

function embedSummary(
  container: "mkv" | "mp4",
  meta: Metadata,
  prefs: Prefs,
  cover: boolean,
  landscapeCover: boolean,
): string {
  const parts = ["title", "overview", "release date", "genres"];
  if (meta.kind === "episode") parts.push("show, season & episode");
  if (prefs.embed_people) parts.push("cast & crew");
  if (prefs.embed_ids) parts.push("database ids");
  if (prefs.embed_content_rating && meta.contentRating) parts.push("content rating");
  if (cover) parts.push("cover");
  if (landscapeCover) parts.push("landscape cover");
  const tool = container === "mkv" ? "mkvpropedit, in place" : "AtomicParsley";
  return `${parts.join(", ")} (${tool})`;
}

/** Paths as shown in the sidebar: relative to the video's folder, or its parent for show files. */
function relativePath(dir: string, path: string): string {
  if (path.startsWith(dir + "/")) return path.slice(dir.length + 1);
  const parent = dirName(dir);
  if (parent && path.startsWith(parent + "/")) return "../" + path.slice(parent.length + 1);
  return path;
}

/** Runs every planned output, each independently so one failure doesn't block the rest. */
export async function executePlan(
  plan: SavePlan,
  videoPath: string,
  meta: Metadata,
  prefs: Prefs,
): Promise<SaveResult[]> {
  const results: SaveResult[] = [];
  const attempt = async (item: PlanItem, write: () => Promise<string>) => {
    try {
      results.push({ label: item.label, target: item.target, ok: true, message: await write() });
    } catch (error) {
      results.push({ label: item.label, target: item.target, ok: false, message: errorText(error) });
    }
  };
  const download = downloader(prefs);

  const job = plan.embed;
  if (job) {
    await attempt(job.item, () =>
      job.container === "mkv" ? embedMkv(videoPath, meta, job, prefs, download) : embedMp4(videoPath, meta, job, prefs, download),
    );
  }
  for (const { sidecar, item } of plan.sidecars) {
    await attempt(item, () => writeSidecar(sidecar, prefs, download));
  }
  return results;
}

function downloader(prefs: Prefs): Download {
  const done = new Map<string, string>();
  return async (image) => {
    const url = prefs.artwork_size === "original" ? image.original : image.standard;
    const cached = done.get(url);
    if (cached) return cached;
    const tmp = `@tmp/img-${fnv1a(url)}${extensionOf(image)}`;
    await iina.http.download(url, tmp);
    // http.download resolves even when writing the file failed.
    if (!iina.file.exists(tmp)) throw new Error(`Downloading ${url} failed`);
    const path = iina.utils.resolvePath(tmp);
    done.set(url, path);
    return path;
  };
}

async function embedMkv(videoPath: string, meta: Metadata, job: EmbedJob, prefs: Prefs, download: Download) {
  const { mkvmerge, mkvextract, mkvpropedit } = job.tools as Required<ToolSet>;
  const identified = await run(mkvmerge, ["-J", videoPath]);
  if (identified.status !== 0) throw new Error(`mkvmerge couldn't read the file: ${tail(identified)}`);
  const info = parseMkvmergeIdentify(identified.stdout);

  // `--tags global:` replaces every global tag, so the file's original tags are kept once.
  // Restore them with `mkvpropedit <file> --tags global:<backup>`.
  const notes: string[] = [];
  const backup = `@data/backups/${fnv1a(videoPath)}.xml`;
  if (info.hasGlobalTags && !iina.file.exists(backup)) {
    const extracted = await run(mkvextract, [videoPath, "tags", iina.utils.resolvePath(backup)]);
    if (extracted.status > 1) throw new Error(`Backing up existing tags failed: ${tail(extracted)}`);
    notes.push(`previous tags backed up to ${iina.utils.resolvePath(backup)}`);
  }

  const tagsPath = `@tmp/tags-${fnv1a(videoPath)}.xml`;
  iina.file.write(tagsPath, matroskaTags(meta, prefs));
  const attachments: Attachment[] = [];
  for (const [name, image] of [["cover", job.cover], ["cover_land", job.landscapeCover]] as const) {
    if (!image) continue;
    const type = extensionOf(image);
    attachments.push({ name: name + type, path: await download(image), mimeType: type === ".png" ? "image/png" : "image/jpeg" });
  }

  const edited = await run(
    mkvpropedit,
    mkvpropeditArgs(videoPath, displayTitle(meta), iina.utils.resolvePath(tagsPath), attachments, info.attachmentNames),
  );
  // mkvpropedit exits with 0 on success, 1 on success with warnings, 2 on error.
  if (edited.status > 1) throw new Error(`mkvpropedit failed: ${tail(edited)}`);
  if (edited.status === 1) notes.push(`warnings: ${tail(edited)}`);
  return ["Tags and covers written", ...notes].join("; ");
}

async function embedMp4(videoPath: string, meta: Metadata, job: EmbedJob, prefs: Prefs, download: Download) {
  const coverPath = job.cover ? await download(job.cover) : undefined;
  const result = await run(job.tools.atomicParsley!, atomicParsleyArgs(videoPath, meta, prefs, coverPath));
  if (result.status !== 0 || /AtomicParsley error/i.test(result.stdout + result.stderr)) {
    throw new Error(`AtomicParsley failed: ${tail(result)}`);
  }
  return "Tags and cover written";
}

async function writeSidecar(sidecar: Sidecar, prefs: Prefs, download: Download) {
  const exists = iina.file.exists(sidecar.path);
  if (exists && prefs.existing_files === "skip") return "Kept the existing file";
  // IINA doesn't let plugins overwrite files outside their own folders; trashing first also keeps
  // the previous version recoverable.
  if (exists) iina.file.trash(sidecar.path);
  if (sidecar.type === "text") {
    iina.file.write(sidecar.path, sidecar.content);
  } else {
    const copied = await run("/bin/cp", [await download(sidecar.image), sidecar.path]);
    if (copied.status !== 0) throw new Error(`Copying artwork failed: ${tail(copied)}`);
  }
  if (!iina.file.exists(sidecar.path)) throw new Error(`${sidecar.path} wasn't created`);
  return exists ? "Replaced (previous version in Trash)" : "Written";
}

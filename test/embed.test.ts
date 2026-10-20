// Writes tags with the real tools and reads them back the way players do (FFmpeg, which mpv and
// IINA use). Skipped unless ffmpeg, MKVToolNix and AtomicParsley are installed.
import { beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { matroskaTags, mkvpropeditArgs, parseMkvmergeIdentify } from "../src/writers/mkv";
import { atomicParsleyArgs } from "../src/writers/mp4";
import { inception, prefs, sh, tempDir, tool } from "./helpers";

const ffmpeg = tool("ffmpeg");
const ffprobe = tool("ffprobe");
const mkvpropedit = tool("mkvpropedit");
const mkvmerge = tool("mkvmerge");
const atomicParsley = tool("AtomicParsley");
const ready = Boolean(ffmpeg && ffprobe && mkvpropedit && mkvmerge && atomicParsley);

let dir = "";
const meta = inception();

/** Container tags as FFmpeg reports them, with lower-cased keys (MKV uses TITLE, MP4 title). */
function readTags(file: string): Record<string, string> {
  const { out } = sh([ffprobe!, "-v", "error", "-show_entries", "format_tags", "-of", "json", file]);
  const tags: Record<string, string> = JSON.parse(out).format?.tags ?? {};
  return Object.fromEntries(Object.entries(tags).map(([key, value]) => [key.toLowerCase(), value]));
}

function makeVideo(name: string, ...extra: string[]): string {
  const file = `${dir}/${name}`;
  const source = ["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=1"];
  expect(sh([ffmpeg!, "-v", "error", "-y", ...source, "-c:v", "libx264", ...extra, file]).status).toBe(0);
  return file;
}

beforeAll(() => {
  if (!ready) return;
  dir = tempDir();
  sh([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=100x150", "-frames:v", "1", `${dir}/cover.jpg`]);
  writeFileSync(`${dir}/font.ttf`, "not really a font");
});

describe.skipIf(!ready)("writing tags into files", () => {
  test("MKV: tags are readable, covers are replaced on re-save, other attachments stay", () => {
    const file = makeVideo(
      "movie.mkv",
      "-attach", `${dir}/font.ttf`, "-metadata:s:t", "mimetype=application/x-truetype-font",
    );
    writeFileSync(`${dir}/tags.xml`, matroskaTags(meta, prefs()));
    const cover = { name: "cover.jpg", path: `${dir}/cover.jpg`, mimeType: "image/jpeg" };

    for (let save = 0; save < 2; save++) {
      const existing = parseMkvmergeIdentify(sh([mkvmerge!, "-J", file]).out).attachmentNames;
      const args = mkvpropeditArgs(file, "Inception (2010)", `${dir}/tags.xml`, [cover], existing);
      expect(sh([mkvpropedit!, ...args]).status).toBe(0);
    }

    expect(readTags(file)).toMatchObject({ title: "Inception", tmdb: "movie/27205", imdb: "tt1375666" });
    expect(readTags(file).description).toStartWith("Cobb, a skilled thief");
    expect(parseMkvmergeIdentify(sh([mkvmerge!, "-J", file]).out).attachmentNames.sort()).toEqual([
      "cover.jpg",
      "font.ttf",
    ]);
  });

  test("MP4: tags are readable and the cover is replaced on re-save", () => {
    const file = makeVideo("movie.mp4");
    // A rating AtomicParsley doesn't accept must not break the write.
    const withUnknownRating = { ...meta, contentRating: "12A" };
    for (let save = 0; save < 2; save++) {
      const args = atomicParsleyArgs(file, withUnknownRating, prefs(), `${dir}/cover.jpg`);
      expect(sh([atomicParsley!, ...args]).status).toBe(0);
    }

    expect(readTags(file)).toMatchObject({ title: "Inception", tmdb: "movie/27205", genre: "Action" });
    expect(sh([atomicParsley!, file, "-t"]).out).toContain('Atom "covr" contains: 1 piece of artwork');
  });
});

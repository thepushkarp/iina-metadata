// The save flow against a stand-in for IINA's file, download and exec APIs. An AVI file is used
// because it can't take embedded tags, so only sidecars are written and no tools are needed.
import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parsePath } from "../src/parse";
import type { Prefs } from "../src/prefs";
import { buildPlan, executePlan } from "../src/save";
import { inception, prefs, tempDir } from "./helpers";

let dir = "";
let video = "";
const meta = inception();

beforeEach(() => {
  dir = tempDir();
  mkdirSync(`${dir}/data`);
  mkdirSync(`${dir}/tmp`);
  mkdirSync(`${dir}/Trash`);
  video = `${dir}/Inception (2010).avi`;
  writeFileSync(video, "video");
  const resolve = (path: string) => path.replace(/^@data/, `${dir}/data`).replace(/^@tmp/, `${dir}/tmp`);
  (globalThis as any).iina = {
    file: {
      exists: (path: string) => existsSync(resolve(path)),
      write: (path: string, content: string) => {
        // Like IINA: files outside the plugin's own folders can't be overwritten.
        if (!path.startsWith("@") && existsSync(path)) throw new Error(`Cannot overwrite ${path}`);
        writeFileSync(resolve(path), content);
      },
      trash: (path: string) => renameSync(path, `${dir}/Trash/${Date.now()}-${basename(path)}`),
    },
    utils: {
      resolvePath: resolve,
      exec: async (file: string, args: string[]) => {
        const result = Bun.spawnSync([file, ...args]);
        return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
      },
    },
    http: { download: async (url: string, dest: string) => writeFileSync(resolve(dest), `image from ${url}`) },
  };
});

async function save(settings: Prefs = prefs()) {
  const plan = buildPlan(video, meta, parsePath(video), settings);
  return { plan, results: await executePlan(plan, video, meta, settings) };
}

const nfo = () => readFileSync(`${dir}/Inception (2010).nfo`, "utf8");

test("a first save writes the sidecars; AVI files can't take embedded tags", async () => {
  const { plan, results } = await save();
  expect(plan.items.map((item) => [item.label, item.action])).toEqual([
    ["Embed in file", "unavailable"],
    ["Movie NFO", "write"],
    ["Poster", "write"],
    ["Fanart", "write"],
  ]);
  expect(results.every((result) => result.ok)).toBeTrue();
  expect(nfo()).toContain("<title>Inception</title>");
  expect(readFileSync(`${dir}/Inception (2010).jpg`, "utf8")).toBe(`image from ${meta.poster!.standard}`);
  expect(readFileSync(video, "utf8")).toBe("video");
});

test("saving again replaces sidecars and moves the old ones to the Trash", async () => {
  await save();
  writeFileSync(`${dir}/Inception (2010).nfo`, "edited by hand");
  const { plan, results } = await save();
  expect(plan.items.find((item) => item.label === "Movie NFO")?.action).toBe("replace");
  expect(results.every((result) => result.ok)).toBeTrue();
  expect(nfo()).toContain("<title>Inception</title>");
  const trashed = readdirSync(`${dir}/Trash`).filter((name) => name.endsWith(".nfo"));
  expect(trashed.map((name) => readFileSync(`${dir}/Trash/${name}`, "utf8"))).toEqual(["edited by hand"]);
});

test("with 'keep existing files', sidecars that exist are left alone", async () => {
  await save();
  writeFileSync(`${dir}/Inception (2010).nfo`, "edited by hand");
  const { plan } = await save(prefs({ existing_files: "skip" }));
  expect(plan.items.find((item) => item.label === "Movie NFO")?.action).toBe("skip");
  expect(nfo()).toBe("edited by hand");
  expect(readdirSync(`${dir}/Trash`)).toEqual([]);
});

test("the original artwork size can be chosen", async () => {
  await save(prefs({ artwork_size: "original" }));
  expect(readFileSync(`${dir}/Inception (2010).jpg`, "utf8")).toBe(`image from ${meta.poster!.original}`);
});

// Builds an installable .iinaplgz containing only what IINA loads at runtime. `iina-plugin pack`
// zips a whole folder, so the runtime files are staged first instead of packing the repository.
import { $ } from "bun";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../Info.json";

const RUNTIME_FILES = ["Info.json", "pref.html", "dist", "README.md", "LICENSE"];
const CLI = "/Applications/IINA.app/Contents/MacOS/iina-plugin";

const stage = await mkdtemp(join(tmpdir(), "iina-metadata-pack-"));
const pluginDir = join(stage, "iina-metadata");
try {
  for (const file of RUNTIME_FILES) await cp(file, join(pluginDir, file), { recursive: true });
  // The CLI only accepts the folder as a path relative to the working directory.
  await $`${CLI} pack iina-metadata`.cwd(stage).quiet();
  const packed = `iina-metadata-${manifest.version}.iinaplgz`;
  await cp(join(stage, packed), packed);
  console.log(`Packed ${packed}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}

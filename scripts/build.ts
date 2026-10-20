// Bundles the plugin entry and the sidebar into dist/. Both are IIFE scripts: IINA evaluates the
// entry as a classic script in JavaScriptCore, where ES module syntax isn't reliably supported.
import { cp, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

const builds = [
  { entrypoints: ["src/index.ts"], outdir: "dist" },
  { entrypoints: ["ui/sidebar/sidebar.ts"], outdir: "dist/ui/sidebar" },
];
for (const options of builds) {
  const result = await Bun.build({ ...options, target: "browser", format: "iife", minify: false });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Bundling ${options.entrypoints.join(", ")} failed`);
  }
}
for (const file of ["index.html", "sidebar.css"]) {
  await cp(`ui/sidebar/${file}`, `dist/ui/sidebar/${file}`);
}
console.log("Built dist/index.js and dist/ui/sidebar/");

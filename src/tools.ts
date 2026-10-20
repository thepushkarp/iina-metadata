// IINA runs tools with an empty PATH and its GUI environment never sees Homebrew's, so every
// binary is resolved to an absolute path.
const HOMEBREW_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

export interface ToolSet {
  mkvpropedit?: string;
  mkvmerge?: string;
  mkvextract?: string;
  atomicParsley?: string;
}

export const INSTALL_HINT = {
  mkvtoolnix: "Install MKVToolNix with `brew install mkvtoolnix`, or set its folder in the plugin settings.",
  atomicParsley: "Install AtomicParsley with `brew install atomicparsley`, or set its path in the plugin settings.",
};

export function findTools(mkvtoolnixDir: string, atomicParsleyPath: string): ToolSet {
  const inDirs = (dirs: string[], name: string) =>
    dirs.map((dir) => `${dir.replace(/\/$/, "")}/${name}`).find((path) => iina.file.exists(path));
  const mkvDirs = mkvtoolnixDir ? [mkvtoolnixDir] : HOMEBREW_DIRS;
  return {
    mkvpropedit: inDirs(mkvDirs, "mkvpropedit"),
    mkvmerge: inDirs(mkvDirs, "mkvmerge"),
    mkvextract: inDirs(mkvDirs, "mkvextract"),
    atomicParsley: atomicParsleyPath
      ? iina.file.exists(atomicParsleyPath)
        ? atomicParsleyPath
        : undefined
      : inDirs(HOMEBREW_DIRS, "AtomicParsley"),
  };
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export async function run(path: string, args: string[]): Promise<RunResult> {
  try {
    return await iina.utils.exec(path, args);
  } catch (error) {
    // utils.exec rejects with (code, message) or a message string when the process can't start.
    throw new Error(`Couldn't start ${path}: ${String(error)}`);
  }
}

/** Last meaningful output lines, for error messages shown in the sidebar. */
export function tail(result: RunResult, lines = 3): string {
  return (result.stderr + "\n" + result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(" · ");
}

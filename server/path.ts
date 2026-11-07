import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, join } from "node:path";
import { onStart } from "./lifecycle";
import { runFile } from "./run";

/**
 * A GUI-launched daemon inherits a minimal PATH, not the user's login PATH, so
 * tools installed in /opt/homebrew/bin, ~/.local/bin etc. look "missing". The
 * login shell's PATH is asked for once, in the background after start-up; a
 * slow shell rc can take seconds and must not stall anything. Until it
 * answers, lookups use the inherited PATH plus the usual install directories.
 */

const EXTRAS = () => [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];

let resolved: string[] | null = null;
let resolving: Promise<string[]> | null = null;

function withExtras(raw: string): string[] {
  return [...new Set(raw.split(delimiter).concat(EXTRAS()).filter(Boolean))];
}

/** The login shell's PATH, asked once per plugin process; concurrent callers share the one ask. */
export function resolveSearchPath(): Promise<string[]> {
  if (resolved) return Promise.resolve(resolved);
  if (resolving) return resolving;
  const shell = process.env.SHELL || "/bin/sh";
  resolving = runFile(shell, ["-lc", 'printf %s "$PATH"'], { timeoutMs: 5000, maxBytes: 64 * 1024 })
    .then((result) => {
      const raw = result.code === 0 && result.stdout.trim() ? result.stdout.trim() : process.env.PATH ?? "";
      resolved = withExtras(raw);
      return resolved;
    })
    .catch(() => {
      resolved = withExtras(process.env.PATH ?? "");
      return resolved;
    })
    .finally(() => {
      resolving = null;
    });
  return resolving;
}

/**
 * The login PATH if it is known or already being asked for; otherwise the
 * inherited one. Never starts the shell, so a pass started from a panel read
 * starts no process.
 */
export function settledSearchPath(): Promise<string[]> {
  if (resolved) return Promise.resolve(resolved);
  return resolving ?? Promise.resolve(searchPath());
}

/** The directories to look in now: the login PATH once known, the inherited one until then. */
export function searchPath(): string[] {
  return resolved ?? withExtras(process.env.PATH ?? "");
}

/** Absolute path of an executable on the search path, or "". */
export function findOnPath(name: string): string {
  for (const directory of searchPath()) {
    for (const suffix of executableSuffixes(name)) {
      const candidate = join(directory, name + suffix);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

/**
 * Windows runs only files with a PATHEXT extension; an extensionless npm shim
 * (a sh script beside `codex.cmd`) is not executable there.
 */
function executableSuffixes(name: string): string[] {
  if (process.platform !== "win32" || extname(name)) return [""];
  return (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
}

export function binaryOnPath(command: string): boolean {
  // Windows absolute paths use backslashes (`D:\Apps\tool.exe`).
  if (command.includes("/") || command.includes("\\")) return executableSuffixes(command).some((suffix) => existsSync(command + suffix));
  return findOnPath(command) !== "";
}

/** For tests: forget the resolved PATH. */
export function resetSearchPath(): void {
  resolved = null;
  resolving = null;
}

onStart(() => void resolveSearchPath());

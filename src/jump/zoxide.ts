import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { validPath } from "./store.ts";

const run = promisify(execFile);
export interface Directory { path: string; rank: number }
export function zoxideBinary(): string { return process.env.JOXIDE_ZOXIDE ?? "zoxide"; }

export async function zoxide(args: string[]): Promise<string> {
  try {
    return (await run(zoxideBinary(), args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" })).stdout;
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") throw new Error("zoxide is not installed. Install it with brew install zoxide, or set JOXIDE_ZOXIDE.");
    if (args[0] === "query" && /no match|no results/i.test(e.stderr ?? "")) return "";
    throw new Error(`zoxide ${args[0]} failed: ${(e.stderr ?? e.message).trim().slice(0, 200)}`);
  }
}

export function parseDirectories(output: string): Directory[] {
  const entries = new Map<string, Directory>();
  for (const line of output.split("\n")) {
    const match = /^\s*([\d.eE+-]+)\s+(\/.*)$/.exec(line);
    if (!match) continue;
    const rank = Number(match[1]);
    const path = match[2]!;
    if (Number.isFinite(rank) && rank >= 0 && validPath(path)) entries.set(path, { path, rank });
  }
  return [...entries.values()];
}

export async function directories(words: string[] = []): Promise<Directory[]> {
  const parsed = parseDirectories(await zoxide(["query", "--list", "--score", "--", ...words]));
  const canonical = await Promise.all(parsed.map(async entry => {
    try { return { ...entry, path: await realpath(entry.path) }; } catch { return undefined; }
  }));
  const unique = new Map<string, Directory>();
  for (const entry of canonical) {
    if (!entry || !validPath(entry.path)) continue;
    const previous = unique.get(entry.path);
    if (!previous || entry.rank > previous.rank) unique.set(entry.path, entry);
  }
  return [...unique.values()].sort((a, b) => b.rank - a.rank);
}

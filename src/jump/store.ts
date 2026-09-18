import { appendFile, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function dataDirectory(): string {
  return resolve(process.env.JOXIDE_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "joxide"));
}

export function validPath(path: string): boolean {
  return path.startsWith("/") && path.length <= 4096 && !/[\x00-\x1f\x7f-\x9f]/u.test(path);
}

export interface Visit { path: string; at: number }
export interface Note { path: string; description: string }

async function tail(path: string): Promise<string> {
  let file;
  try {
    file = await open(path, "r");
    const { size } = await file.stat();
    const start = Math.max(0, size - 2 * 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return start ? text.slice(text.indexOf("\n") + 1) : text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  } finally { await file?.close(); }
}

export async function readVisits(directory = dataDirectory()): Promise<Visit[]> {
  return (await tail(join(directory, "visits.tsv"))).split("\n").flatMap(line => {
    const [time, path] = line.split("\t");
    const at = Number(time) * 1000;
    return path && validPath(path) && Number.isFinite(at) && at > 0 ? [{ path, at }] : [];
  });
}

export async function readNotes(directory = dataDirectory()): Promise<Map<string, string>> {
  const notes = new Map<string, string>();
  for (const line of (await tail(join(directory, "notes.tsv"))).split("\n")) {
    const [path, description] = line.split("\t");
    if (path && validPath(path) && description !== undefined) notes.set(path, description);
  }
  return notes;
}

export async function describe(path: string, description: string, directory = dataDirectory()): Promise<void> {
  if (!validPath(path) || description.length > 1000 || /[\x00-\x1f\x7f-\x9f]/u.test(description)) throw new Error("Use a single-line description of at most 1000 characters.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Append-only records avoid lost updates from multiple terminal sessions.
  await appendFile(join(directory, "notes.tsv"), `${path}\t${description}\n`, { mode: 0o600 });
}

export function dateFilter(query: string, now = new Date()): { query: string; start?: number; end?: number; label?: string } {
  const match = /\b(yesterday|today|last week)\b/i.exec(query);
  if (!match) return { query };
  const label = match[1]!.toLowerCase();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(midnight);
  const end = new Date(midnight);
  if (label === "yesterday") start.setDate(start.getDate() - 1);
  else if (label === "today") end.setDate(end.getDate() + 1);
  else start.setDate(start.getDate() - 7);
  const remainder = query.replace(match[0], " ").replace(/\b(the|a|an|project|repo|repository|directory|folder|i|was|in|used|visited|worked|on|from|that)\b/gi, " ").replace(/\s+/g, " ").trim();
  return { query: remainder, start: start.getTime(), end: end.getTime(), label };
}

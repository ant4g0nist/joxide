import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, basename } from "node:path";
import { directories, type Directory } from "./zoxide.ts";
import { dateFilter, readNotes, readVisits, validPath } from "./store.ts";
import { metadata, type Project } from "./metadata.ts";
import { buildJumpRequest, readRanking, shortlist, type JumpRequest, type Result } from "./rank.ts";

export type Evaluate = (request: JumpRequest) => Promise<{ answers: Record<string, unknown>; model?: string; usage?: unknown }>;
export interface Options { cwd: string; semantic?: boolean; local?: boolean; model?: string; dryRun?: boolean; now?: Date }

export async function isDirectory(path: string): Promise<boolean> {
  if (!validPath(path)) return false;
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

export function localResult(entries: Project[], source: Result["source"]): Result {
  return { status: entries.length === 1 ? "selected" : entries.length ? "choose" : "none", source,
    candidates: entries.slice(0, 10).map(entry => ({ ...entry, relevance: 1 })),
    ...(!entries.length ? { reason: "No matching directories." } : {}),
  };
}

function project(entry: Directory): Project { return { ...entry, name: basename(entry.path), description: "", technologies: [] }; }

export async function navigate(rawQuery: string, options: Options, evaluate: Evaluate): Promise<Result | JumpRequest> {
  const started = performance.now();
  const query = rawQuery.trim();
  if (!query || query.length > 500 || /[\x00-\x1f\x7f-\x9f]/u.test(query)) throw new Error("Enter a single-line directory name or description, up to 500 characters.");
  const expanded = query === "~" ? homedir() : query.startsWith("~/") ? homedir() + query.slice(1) : query;
  const direct = resolve(options.cwd, expanded);
  if (!options.semantic && !options.dryRun && await isDirectory(direct)) return localResult([project({ path: direct, rank: 1 })], "path");
  const period = dateFilter(query, options.now);
  if (!options.semantic && !options.dryRun && !period.label) {
    const matches = await directories(query.split(/\s+/));
    const valid = (await Promise.all(matches.map(async entry => await isDirectory(entry.path) ? project(entry) : undefined))).filter((entry): entry is Project => !!entry);
    if (valid.length) {
      const exact = valid.filter(entry => basename(entry.path).toLowerCase() === query.toLowerCase());
      return localResult(exact.length === 1 ? exact : valid, "zoxide");
    }
  }
  const [index, visits, notes] = await Promise.all([directories(), readVisits(), readNotes()]);
  const latest = new Map<string, number>();
  const withinPeriod = new Map<string, number>();
  for (const visit of visits) {
    latest.set(visit.path, Math.max(latest.get(visit.path) ?? 0, visit.at));
    if (period.start !== undefined && visit.at >= period.start && visit.at < period.end!) withinPeriod.set(visit.path, Math.max(withinPeriod.get(visit.path) ?? 0, visit.at));
  }
  let entries = index.filter(entry => !period.label || withinPeriod.has(entry.path));
  if (period.label) entries.sort((a, b) => withinPeriod.get(b.path)! - withinPeriod.get(a.path)!);
  entries = (await Promise.all(entries.slice(0, 500).map(async entry => await isDirectory(entry.path) ? entry : undefined))).filter((entry): entry is Directory => !!entry);
  if (!entries.length) return { status: "none", source: period.label ? "dates" : "zoxide", candidates: [], reason: period.label
    ? `No recorded visits for ${period.label}. Visit tracking starts when joxide is loaded; old zoxide history has no imported visit timestamps.`
    : "No indexed directories. Visit some projects, or run jctl index /path/to/projects." };
  if (period.label && !period.query) return localResult(entries.map(entry => ({ ...project(entry), lastVisit: withinPeriod.get(entry.path) })), "dates");
  if (options.local) return { status: "none", source: "zoxide", candidates: [], reason: "No local name match. Omit --local to search project descriptions with Jev." };
  // Batch filesystem work to avoid exhausting descriptors on a large index.
  const projects: Project[] = [];
  for (let i = 0; i < entries.length; i += 20) {
    projects.push(...await Promise.all(entries.slice(i, i + 20).map(entry => metadata(entry, notes.get(entry.path), latest.get(entry.path)))));
  }
  const selected = shortlist(projects, period.query || query);
  const request = buildJumpRequest(selected, period.query || query, options.cwd, options.model ?? "jev-latest");
  if (options.dryRun) return request;
  const result = readRanking(selected, await evaluate(request));
  // A directory may have disappeared while the API request was running.
  const first = result.candidates[0]?.path;
  result.candidates = (await Promise.all(result.candidates.map(async candidate => await isDirectory(candidate.path) ? candidate : undefined))).filter((entry): entry is Result["candidates"][number] => !!entry);
  if (!result.candidates.length) { result.status = "none"; result.reason ??= "Matching directories no longer exist."; }
  else if (result.status === "selected" && result.candidates[0]!.path !== first) result.status = "choose";
  result.elapsedMs = Math.round(performance.now() - started);
  return result;
}

#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readdir, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { dataDirectory, describe, readNotes, readVisits } from "./store.ts";
import { directories, zoxide, zoxideBinary } from "./zoxide.ts";
import { navigate, isDirectory } from "./navigate.ts";
import { displayPath, type Result } from "./rank.ts";

const HELP = `joxide — find a project by what it does

  j api                         Jump by directory name, locally
  j auth backend                Search known projects by purpose
  j --semantic cloudflare demo   Force semantic ranking
  j yesterday                   Pick a directory visited yesterday
  j --list auth backend         Show matches without jumping
  j --json auth backend         Inspect ranking and token usage
  j --dry-run auth backend      Inspect the API request without sending it
  j --local api                 Never call the API
  j -                           Return to the previous directory

  jctl add /path/to/project      Add a known directory to zoxide
  jctl index /path/to/projects   Add the root and its immediate visible subdirectories
  jctl describe "auth backend"   Describe the current directory for semantic matching
  jctl list                     List the zoxide directory index
  jctl doctor                   Check runtime, index, and API-key availability

Jev ranks existing paths. The shell performs cd; no generated commands are run.
Semantic queries use TYPESAFE_API_KEY. Name and date matches work offline.
`;

function controlText(text: string): string { return text.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").slice(0, 500); }

async function control(args: string[]) {
  const [action, ...rest] = args;
  if (!action || action === "help" || action === "--help") { console.log(HELP); return; }
  if (action === "doctor") {
    const version = (await zoxide(["--version"])).trim();
    const [index, visits] = await Promise.all([directories(), readVisits()]);
    console.log(`${version} (${zoxideBinary()})\nNode ${process.version}\n${index.length} indexed directories\n${visits.length} recorded visits\nData: ${dataDirectory()}\nTypeSafe API key: ${process.env.TYPESAFE_API_KEY ? "set" : "not set (local navigation still works)"}`);
    return;
  }
  if (action === "list") {
    const [index, notes] = await Promise.all([directories(), readNotes()]);
    for (const entry of index) console.log(`${displayPath(entry.path)}${notes.get(entry.path) ? "  — " + controlText(notes.get(entry.path)!) : ""}`);
    return;
  }
  if (action === "describe") {
    if (!rest.length) throw new Error("Use jctl describe followed by a short description of this project.");
    const path = await realpath(process.cwd());
    await zoxide(["add", "--", path]);
    await describe(path, rest.join(" "));
    console.log(`Described ${displayPath(path)}.`);
    return;
  }
  if (action === "add" || action === "index") {
    const root = await realpath(resolve(rest.join(" ") || process.cwd()));
    if (!await isDirectory(root)) throw new Error("Provide an existing directory.");
    const paths = [root];
    if (action === "index") {
      const children = await readdir(root, { withFileTypes: true });
      paths.push(...children.filter(entry => entry.isDirectory() && !entry.name.startsWith(".") && !["node_modules", "vendor"].includes(entry.name)).slice(0, 500).map(entry => join(root, entry.name)));
    }
    for (let i = 0; i < paths.length; i += 50) await zoxide(["add", "--", ...paths.slice(i, i + 50)]);
    console.log(`Added ${paths.length} director${paths.length === 1 ? "y" : "ies"}. No files were sent to Jev.`);
    return;
  }
  throw new Error(`Unknown jctl action: ${action}. Run jctl --help.`);
}

async function main() {
  if (process.argv[2] === "control") { await control(process.argv.slice(3)); return; }
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, shell: { type: "boolean" }, json: { type: "boolean" }, list: { type: "boolean" },
    "dry-run": { type: "boolean" }, semantic: { type: "boolean" }, local: { type: "boolean" }, model: { type: "string" },
  } });
  if (values.help) { console.log(HELP); return; }
  if (values.semantic && values.local) throw new Error("Choose either --semantic or --local.");
  const output = await navigate(positionals.join(" "), {
    cwd: process.cwd(), semantic: values.semantic, local: values.local, dryRun: values["dry-run"], model: values.model ?? process.env.JOXIDE_MODEL,
  }, async request => {
    if (!process.env.TYPESAFE_API_KEY) throw new Error("Set TYPESAFE_API_KEY for semantic search. Use j --local for directory-name matching.");
    const client = new TypeSafeClient({ logLevel: "off" });
    return client.systemOne(request, { timeout: 8000, signal: AbortSignal.timeout(10_000), retry: { maxRetries: 1, maxRetryAfterMs: 1000 } });
  });
  if (!("status" in output)) { console.log(JSON.stringify(output, null, 2)); return; }
  const result: Result = output;
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else if (values.shell) {
    console.log(result.status);
    for (const candidate of result.candidates) console.log(candidate.path);
    if (result.status === "choose") {
      console.error("Several places could fit:");
      result.candidates.forEach((candidate, i) => console.error(`  ${i + 1}. ${displayPath(candidate.path)}${candidate.description ? " — " + controlText(candidate.description) : ""}`));
    }
  } else {
    for (const candidate of result.candidates) console.log(`${displayPath(candidate.path)}${values.list && candidate.description ? " — " + controlText(candidate.description) : ""}`);
  }
  if (result.status === "none") { if (!values.json) console.error(`joxide: ${result.reason}`); process.exitCode = 2; }
}

main().catch(error => {
  const message = error && typeof error === "object" && "status" in error ? `TypeSafe HTTP ${error.status}. Check your key or quota, or try again later.` : error instanceof Error ? error.message : "Request failed.";
  console.error(`joxide: ${controlText(message)}`);
  process.exitCode = 1;
});

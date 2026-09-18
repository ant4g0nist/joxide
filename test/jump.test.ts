import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { dateFilter, describe, readNotes, readVisits, validPath } from "../src/jump/store.ts";
import { metadata, type Project } from "../src/jump/metadata.ts";
import { parseDirectories, zoxide } from "../src/jump/zoxide.ts";
import { navigate } from "../src/jump/navigate.ts";
import { buildJumpRequest, readRanking, shortlist, type JumpRequest, type Result } from "../src/jump/rank.ts";

const makeProject = (path: string, description = ""): Project => ({ path, name: path.split("/").at(-1)!, rank: 1, description, technologies: [] });
function response(request: JumpRequest, scores: number[]) {
  return { model: "test-jev", usage: { input_tokens: 100, output_tokens: 10 }, answers: Object.fromEntries(Object.keys(request.questions).map((id, i) => [id, { type: "noul", noul: scores[i] ?? 0.01 }])) };
}

async function fixture(fn: (root: string, paths: string[]) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joxide-test-")));
  const keys = ["_ZO_DATA_DIR", "JOXIDE_DATA_DIR", "_ZO_EXCLUDE_DIRS"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env._ZO_DATA_DIR = join(root, "zoxide-data");
  process.env.JOXIDE_DATA_DIR = join(root, "jump-data");
  process.env._ZO_EXCLUDE_DIRS = "";
  const paths = ["identity-service", "workers playground", "billing-api"].map(name => join(root, name));
  try {
    for (const path of paths) await mkdir(path);
    await zoxide(["add", "--", ...paths]);
    await fn(root, paths);
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(root, { recursive: true, force: true });
  }
}

test("zoxide parser preserves spaces and drops invalid paths/scores", () => {
  assert.deepEqual(parseDirectories("  42.5 /projects/one two\nNaN /bad\n12 relative\n0 /project/zero\n"), [{ path: "/projects/one two", rank: 42.5 }, { path: "/project/zero", rank: 0 }]);
  assert.equal(validPath("/tmp/a\nb"), false);
});

test("date queries use local calendar boundaries rather than model arithmetic", () => {
  const now = new Date(2026, 8, 18, 16, 0);
  const period = dateFilter("the project I used yesterday", now);
  assert.equal(period.query, "");
  assert.equal(period.start, new Date(2026, 8, 17).getTime());
  assert.equal(period.end, new Date(2026, 8, 18).getTime());
  assert.equal(dateFilter("auth project yesterday", now).query, "auth");
});

test("metadata describes projects without reading source or executing manifests", async () => fixture(async (_, paths) => {
  const path = paths[0]!;
  await writeFile(join(path, "package.json"), JSON.stringify({ name: "identity", description: "Authentication backend and session management", scripts: { postinstall: "DO_NOT_EXECUTE" }, dependencies: { hono: "1", pg: "2" } }));
  await writeFile(join(path, "tsconfig.json"), "{}");
  await writeFile(join(path, ".env"), "PRIVATE_CREDENTIAL=value");
  const item = await metadata({ path, rank: 1 });
  assert.equal(item.name, "identity");
  assert.match(item.description, /Authentication/);
  assert.ok(item.technologies.includes("TypeScript"));
  assert.ok(!JSON.stringify(item).includes("PRIVATE_CREDENTIAL"));
  assert.ok(!JSON.stringify(item).includes("DO_NOT_EXECUTE"));
}));

test("README provides bounded fallback prose; symlinked metadata is ignored", async () => fixture(async (_, paths) => {
  await writeFile(join(paths[0]!, "README.md"), "# Playground\n\n![badge](url)\n\nA Cloudflare Workers experiment for a chat application.\n\n```sh\nDO_NOT_RUN\n```\n");
  assert.match((await metadata({ path: paths[0]!, rank: 1 })).description, /Cloudflare Workers/);
  await symlink(join(paths[0]!, "README.md"), join(paths[1]!, "README.md"));
  assert.equal((await metadata({ path: paths[1]!, rank: 1 })).description, "");
}));

test("user descriptions override guessed metadata and concurrent notes remain readable", async () => fixture(async (_, paths) => {
  await Promise.all(paths.map((path, i) => describe(path, `project ${i}`)));
  await describe(paths[0]!, "the auth backend");
  const notes = await readNotes();
  assert.equal(notes.size, 3);
  assert.equal(notes.get(paths[0]!), "the auth backend");
  assert.equal((await metadata({ path: paths[0]!, rank: 1 }, notes.get(paths[0]!))).description, "the auth backend");
}));

test("existing paths and zoxide name matches never call Jev", async () => fixture(async (root, paths) => {
  for (const query of [paths[1]!, "identity"]) {
    const result = await navigate(query, { cwd: root }, async () => { throw new Error("Must be local"); }) as Result;
    assert.equal(result.status, "selected");
    assert.ok(paths.includes(result.candidates[0]!.path));
  }
}));

test("ambiguous local matches produce a picker, not a forced jump", async () => fixture(async (root, paths) => {
  const second = join(root, "billing-api-copy");
  await mkdir(second);
  await zoxide(["add", "--", second]);
  const result = await navigate("billing", { cwd: root }, async () => { throw new Error("Must be local"); }) as Result;
  assert.equal(result.status, "choose");
  assert.deepEqual(new Set(result.candidates.map(c => c.path)), new Set([paths[2], second]));
}));

test("semantic queries rank existing paths using evidence in one batched request", async () => fixture(async (root, paths) => {
  await describe(paths[0]!, "Authentication backend; OAuth sessions and identity API");
  let calls = 0;
  const result = await navigate("auth backend", { cwd: root }, async request => {
    calls++;
    const items = request.state.directories as Array<Record<string, unknown>>;
    assert.equal(items.length, 3);
    return response(request, items.map(item => String(item.description).includes("Authentication") ? 0.98 : 0.04));
  }) as Result;
  assert.equal(calls, 1);
  assert.equal(result.status, "selected");
  assert.equal(result.candidates[0]?.path, paths[0]);
  assert.equal(result.source, "semantic");
}));

test("low relevance abstains and close scores require a choice", () => {
  const projects = [makeProject("/one"), makeProject("/two")];
  const req = buildJumpRequest(projects, "query", "/here", "jev-latest");
  assert.equal(readRanking(projects, response(req, [0.1, 0.2])).status, "none");
  assert.equal(readRanking(projects, response(req, [0.92, 0.88])).status, "choose");
  assert.equal(readRanking(projects, response(req, [0.65, 0.05])).status, "choose");
});

test("model output cannot invent a path and malformed scores are rejected", () => {
  const projects = [makeProject("/known")];
  const result = readRanking(projects, { answers: { d0: { type: "noul", noul: 0.99, path: "/invented" } } });
  assert.equal(result.candidates[0]?.path, "/known");
  for (const noul of [NaN, -1, 2, "0.99"]) assert.throws(() => readRanking(projects, { answers: { d0: { type: "noul", noul } } }), /invalid/);
});

test("date navigation requires recorded visits and ignores directories visited on other days", async () => fixture(async (root, paths) => {
  const data = process.env.JOXIDE_DATA_DIR!;
  await mkdir(data);
  const yesterday = new Date(2026, 8, 17, 15).getTime();
  const today = new Date(2026, 8, 18, 14).getTime();
  await writeFile(join(data, "visits.tsv"), `${yesterday / 1000}\t${paths[0]}\n${today / 1000}\t${paths[1]}\n`);
  assert.equal((await readVisits()).length, 2);
  const result = await navigate("project I used yesterday", { cwd: root, now: new Date(2026, 8, 18, 16) }, async () => { throw new Error("Dates are local"); }) as Result;
  assert.equal(result.source, "dates");
  assert.equal(result.candidates[0]?.path, paths[0]);
  const empty = await navigate("yesterday", { cwd: root, now: new Date(2026, 9, 1) }, async () => { throw new Error("No evidence"); }) as Result;
  assert.equal(empty.status, "none");
}));

test("deleted directories cannot become jump destinations after an API call", async () => fixture(async (root, paths) => {
  const result = await navigate("authentication backend", { cwd: root }, async request => {
    await Promise.all(paths.map(path => rm(path, { recursive: true })));
    return response(request, [0.99, 0.9, 0.02]);
  }) as Result;
  assert.equal(result.status, "none");
  assert.deepEqual(result.candidates, []);
}));

test("shortlisting uses project descriptions, with a bounded candidate count", () => {
  const projects = Array.from({ length: 100 }, (_, i) => makeProject(`/p${i}`, i === 99 ? "OAuth authentication backend" : "unrelated"));
  const result = shortlist(projects, "authentication backend");
  assert.equal(result.length, 64);
  assert.equal(result[0]?.path, "/p99");
});

test("dry-run exposes exact semantic state without an API key", async () => fixture(async (root) => {
  const result = await navigate("some project", { cwd: root, dryRun: true }, async () => { throw new Error("No request"); });
  assert.ok("questions" in result);
}));

test("official SDK transport produces the expected typed ranking", async () => {
  const projects = [makeProject("/identity", "Authentication backend")];
  const request = buildJumpRequest(projects, "auth backend", "/work", "jev-latest");
  const client = new TypeSafeClient({ apiKey: "test-only", fetch: async (url, init) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.deepEqual(JSON.parse(String(init?.body)), request);
    return new Response(JSON.stringify(response(request, [0.97])), { headers: { "Content-Type": "application/json" } });
  } });
  assert.equal(readRanking(projects, await client.systemOne(request)).status, "selected");
});

test("CLI can index project roots, describe a project, and report configuration", async () => fixture(async (root, paths) => {
  const cli = resolve("src/jump/cli.ts");
  for (const args of [["control", "index", root], ["control", "describe", "identity and sessions"], ["control", "doctor"], ["--json", "identity"]]) {
    const output = spawnSync(process.execPath, [cli, ...args], { cwd: paths[0], encoding: "utf8", env: { ...process.env, TYPESAFE_API_KEY: "" }, timeout: 15000 });
    assert.equal(output.status, 0, output.stderr);
    if (args.includes("doctor")) assert.match(output.stdout, /not set/);
    if (args.includes("--json")) assert.equal(JSON.parse(output.stdout).status, "selected");
  }
  assert.match(await readFile(join(process.env.JOXIDE_DATA_DIR!, "notes.tsv"), "utf8"), /identity and sessions/);
}));

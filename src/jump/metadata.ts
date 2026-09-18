import { lstat, open, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Directory } from "./zoxide.ts";

export interface Project extends Directory {
  name: string;
  description: string;
  technologies: string[];
  lastVisit?: number;
}

function safeText(value: unknown, limit = 500): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

async function snippet(path: string, limit = 8192): Promise<string> {
  let file;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return "";
    file = await open(path, "r");
    const buffer = Buffer.alloc(Math.min(limit, stat.size));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch { return ""; } finally { await file?.close(); }
}

export async function metadata(entry: Directory, note = "", lastVisit?: number): Promise<Project> {
  const project: Project = { ...entry, name: basename(entry.path), description: safeText(note), technologies: [], lastVisit };
  try {
    const files = await readdir(entry.path);
    const markers: Record<string, string> = { "package.json": "JavaScript", "tsconfig.json": "TypeScript", "Cargo.toml": "Rust", "go.mod": "Go", "pyproject.toml": "Python", "requirements.txt": "Python", "Gemfile": "Ruby", "Dockerfile": "Docker", "wrangler.toml": "Cloudflare Workers", "wrangler.json": "Cloudflare Workers", "wrangler.jsonc": "Cloudflare Workers" };
    project.technologies = [...new Set(files.flatMap(name => markers[name] ? [markers[name]!] : []))];
    if (files.includes("package.json")) {
      try {
        const pkg = JSON.parse(await snippet(join(entry.path, "package.json"), 65536));
        project.name = safeText(pkg.name, 100) || project.name;
        if (!project.description) project.description = safeText(pkg.description);
        for (const field of [pkg.dependencies, pkg.devDependencies]) {
          if (field && typeof field === "object" && !Array.isArray(field)) project.technologies.push(...Object.keys(field).slice(0, 20).map(name => safeText(name, 80)));
        }
      } catch { /* A partial or invalid manifest is not executable configuration. */ }
    }
    if (!project.description) {
      const readme = files.find(name => /^readme(?:\.md|\.txt)?$/i.test(name));
      if (readme) {
        const prose = (await snippet(join(entry.path, readme))).replace(/```[\s\S]*?(?:```|$)/g, "").split(/\n\s*\n/)
          .map(part => part.trim()).find(part => part && !/^(?:#|!|<|\[|\|)/.test(part));
        project.description = safeText(prose);
      }
    }
  } catch { /* Unreadable metadata should not prevent navigating an existing path. */ }
  project.technologies = [...new Set(project.technologies)].slice(0, 24);
  return project;
}

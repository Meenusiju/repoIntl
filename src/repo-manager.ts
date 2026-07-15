import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import AdmZip from "adm-zip";
import { RepoMetadata } from "./types";
import {
  isSupabaseConfigured,
  saveRepoMetadata,
  getRepoMetadata,
  getAllRepoIds,
  saveIntakeReportToSupabase,
  getIntakeReportFromSupabase,
} from "./storage/supabase-client";

// Vercel serverless functions have a read-only filesystem except for /tmp,
// which is writable but ephemeral (reset between invocations/cold starts).
// Locally (and on traditional Node hosting) we keep using ./repos so cloned
// repos and the local vector store persist across restarts.
const REPOS_ROOT = process.env.VERCEL
  ? path.join("/tmp", "repos")
  : path.join(process.cwd(), "repos");

/**
 * Generates a unique, filesystem-safe repo ID from a GitHub URL.
 * e.g. https://github.com/user/repo.git -> user__repo
 */
export function generateRepoId(repoUrl: string): string {
  const cleaned = repoUrl.trim().replace(/\.git$/, "").replace(/\/$/, "");
  const match = cleaned.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  if (!match) {
    throw new Error(
      `Invalid GitHub URL: "${repoUrl}". Expected format https://github.com/user/repo`
    );
  }
  const [, owner, repo] = match;
  return `${owner}__${repo}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

export function validateGithubUrl(repoUrl: string): void {
  if (!repoUrl || typeof repoUrl !== "string") {
    throw new Error("repoUrl is required");
  }
  const githubPattern = /^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+\/?$/i;
  if (!githubPattern.test(repoUrl.trim().replace(/\.git$/, ""))) {
    throw new Error(
      `Invalid GitHub URL: "${repoUrl}". Only public GitHub repo URLs are supported in Phase 1.`
    );
  }
}

export function getRepoPaths(repoId: string) {
  const repoRoot = path.join(REPOS_ROOT, repoId);
  return {
    repoRoot,
    sourceDir: path.join(repoRoot, "source"),
    intakeMdPath: path.join(repoRoot, "intake.md"),
    metadataPath: path.join(repoRoot, "metadata.json"),
  };
}

/**
 * Downloads a public GitHub repo's default-branch snapshot via the GitHub
 * REST API (a zipball, no `git` binary required — Vercel serverless
 * functions don't ship one) and extracts it into /repos/{repoId}/source.
 * Throws descriptive errors for common failure modes.
 */
export async function cloneRepo(repoUrl: string, repoId: string): Promise<string> {
  const { repoRoot, sourceDir } = getRepoPaths(repoId);

  if (fs.existsSync(sourceDir)) {
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
  fs.mkdirSync(repoRoot, { recursive: true });

  const cleaned = repoUrl.trim().replace(/\.git$/, "").replace(/\/$/, "");
  const match = cleaned.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  if (!match) {
    throw new Error(`Invalid GitHub URL: "${repoUrl}"`);
  }
  const [, owner, repo] = match;

  const authHeaders: Record<string, string> = process.env.GITHUB_TOKEN
    ? { Authorization: `token ${process.env.GITHUB_TOKEN}` }
    : {};

  // Try common default branches in order; GitHub's zipball endpoint 404s if
  // the ref doesn't exist, so we fall back until one succeeds.
  const branchesToTry = ["main", "master"];
  let lastError = "";

  for (const branch of branchesToTry) {
    const zipUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/${branch}`;
    let response;
    try {
      response = await fetch(zipUrl, {
        headers: { ...authHeaders, "User-Agent": "RepoIntel" },
        timeout: 5 * 60 * 1000,
      });
    } catch (err: any) {
      lastError = err.message || String(err);
      continue;
    }

    if (response.status === 404) {
      lastError = `404 for branch "${branch}"`;
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "Private repo detected or access denied. Phase 1 supports public repos only."
      );
    }
    if (!response.ok) {
      lastError = `GitHub API returned ${response.status} ${response.statusText}`;
      continue;
    }

    const buffer = await response.buffer();
    let zip: AdmZip;
    try {
      zip = new AdmZip(buffer);
    } catch (err: any) {
      throw new Error(`Failed to read repo archive: ${err.message}`);
    }

    zip.extractAllTo(sourceDir, true);

    // GitHub's zipball wraps everything in a single "owner-repo-<sha>/"
    // folder. Flatten it so sourceDir directly contains the repo's files.
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    const wrapperDirs = entries.filter((e) => e.isDirectory());
    if (wrapperDirs.length === 1 && entries.length === 1) {
      const wrapperPath = path.join(sourceDir, wrapperDirs[0].name);
      for (const item of fs.readdirSync(wrapperPath)) {
        fs.renameSync(path.join(wrapperPath, item), path.join(sourceDir, item));
      }
      fs.rmSync(wrapperPath, { recursive: true, force: true });
    }

    validateRepoStructure(sourceDir);
    return sourceDir;
  }

  if (/404/.test(lastError)) {
    throw new Error(`Repo not found (404): ${repoUrl}`);
  }
  if (/timeout|timed out/i.test(lastError)) {
    throw new Error(`Repo download timed out for ${repoUrl}`);
  }
  throw new Error(`Failed to download repo: ${lastError || "unknown error"}`);
}

export function validateRepoStructure(sourceDir: string): void {
  if (!fs.existsSync(sourceDir)) {
    throw new Error("Downloaded repo directory does not exist.");
  }
  const files = listFiles(sourceDir);
  const codeFiles = files.filter((f) => {
    const base = path.basename(f);
    if (/\.(js|ts|jsx|tsx|py|java|go|rb|php|cs|cpp|c|rs|kt|swift|md|json|yml|yaml|txt|toml|cfg|ini)$/i.test(f)) {
      return true;
    }
    // Extension-less common files (README, LICENSE, Dockerfile, Makefile, etc.)
    return /^(README|LICENSE|LICENCE|CHANGELOG|Dockerfile|Makefile|Procfile|CONTRIBUTING|AUTHORS|NOTICE)$/i.test(
      base
    );
  });
  if (files.length === 0) {
    throw new Error("Repo has no files detected.");
  }
  if (codeFiles.length === 0) {
    throw new Error("Repo has no code files detected.");
  }
}

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "coverage",
]);

/**
 * Recursively lists files (relative paths) in a repo, skipping common ignore dirs.
 */
export function listFiles(rootDir: string, maxFiles = 2000): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    if (results.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else {
        const rel = path.relative(rootDir, path.join(dir, entry.name));
        results.push(rel.replace(/\\/g, "/"));
      }
    }
  }

  walk(rootDir);
  return results;
}

/**
 * Reads a file relative to the repo source dir. Returns null if missing/unreadable.
 */
export function readRepoFile(
  sourceDir: string,
  relativePath: string,
  maxChars = 20000
): string | null {
  try {
    const fullPath = path.join(sourceDir, relativePath);
    if (!fullPath.startsWith(sourceDir)) return null; // guard path traversal
    if (!fs.existsSync(fullPath)) return null;
    const content = fs.readFileSync(fullPath, "utf-8");
    return content.length > maxChars ? content.slice(0, maxChars) : content;
  } catch {
    return null;
  }
}

export async function saveMetadata(repoId: string, metadata: RepoMetadata): Promise<void> {
  if (isSupabaseConfigured()) {
    await saveRepoMetadata(repoId, metadata);
    return;
  }
  const { repoRoot, metadataPath } = getRepoPaths(repoId);
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");
}

export async function loadMetadata(repoId: string): Promise<RepoMetadata | null> {
  if (isSupabaseConfigured()) {
    return getRepoMetadata(repoId);
  }
  const { metadataPath } = getRepoPaths(repoId);
  if (!fs.existsSync(metadataPath)) return null;
  return JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
}

export async function saveIntakeReport(repoId: string, markdown: string): Promise<void> {
  if (isSupabaseConfigured()) {
    await saveIntakeReportToSupabase(repoId, markdown);
    return;
  }
  const { repoRoot, intakeMdPath } = getRepoPaths(repoId);
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(intakeMdPath, markdown, "utf-8");
}

export async function loadIntakeReport(repoId: string): Promise<string | null> {
  if (isSupabaseConfigured()) {
    return getIntakeReportFromSupabase(repoId);
  }
  const { intakeMdPath } = getRepoPaths(repoId);
  if (!fs.existsSync(intakeMdPath)) return null;
  return fs.readFileSync(intakeMdPath, "utf-8");
}

/**
 * Lists all repo IDs ever onboarded (i.e. every repo with saved metadata),
 * regardless of current in-memory server state. Used to rehydrate server
 * state after a restart / cold start. Reads from Supabase when configured
 * (survives redeploys), otherwise from metadata.json files on disk.
 */
export async function listAllOnboardedRepoIds(): Promise<string[]> {
  if (isSupabaseConfigured()) {
    return getAllRepoIds();
  }
  if (!fs.existsSync(REPOS_ROOT)) return [];
  return fs
    .readdirSync(REPOS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((repoId) => fs.existsSync(getRepoPaths(repoId).metadataPath));
}


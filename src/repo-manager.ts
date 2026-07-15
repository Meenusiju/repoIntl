import { execSync } from "child_process";
import fs from "fs";
import path from "path";

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
 * Clones a public GitHub repo into /repos/{repoId}/source with a timeout.
 * Throws descriptive errors for common failure modes.
 */
export function cloneRepo(repoUrl: string, repoId: string): string {
  const { repoRoot, sourceDir } = getRepoPaths(repoId);

  if (fs.existsSync(sourceDir)) {
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
  fs.mkdirSync(repoRoot, { recursive: true });

  try {
    execSync(`git clone --depth 1 "${repoUrl}" "${sourceDir}"`, {
      timeout: 5 * 60 * 1000, // 5 minutes
      stdio: "pipe",
    });
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.() || err?.message || "";
    if (/could not read Username|Authentication failed|403/i.test(stderr)) {
      throw new Error(
        "Private repo detected. Phase 1 supports public repos only."
      );
    }
    if (/repository .* not found|404/i.test(stderr)) {
      throw new Error(`Repo not found (404): ${repoUrl}`);
    }
    if (err?.signal === "SIGTERM" || /timed out/i.test(stderr)) {
      throw new Error(`git clone timed out after 5 minutes for ${repoUrl}`);
    }
    throw new Error(`git clone failed: ${stderr || err.message}`);
  }

  validateRepoStructure(sourceDir);
  return sourceDir;
}

export function validateRepoStructure(sourceDir: string): void {
  if (!fs.existsSync(sourceDir)) {
    throw new Error("Cloned repo directory does not exist.");
  }
  const gitDir = path.join(sourceDir, ".git");
  // With --depth 1 clone, .git exists as a directory in normal clones.
  if (!fs.existsSync(gitDir)) {
    throw new Error("Invalid repo structure: .git directory not found.");
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

export function saveMetadata(repoId: string, metadata: object): void {
  const { repoRoot, metadataPath } = getRepoPaths(repoId);
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");
}

export function loadMetadata(repoId: string): any | null {
  const { metadataPath } = getRepoPaths(repoId);
  if (!fs.existsSync(metadataPath)) return null;
  return JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
}

export function saveIntakeReport(repoId: string, markdown: string): void {
  const { repoRoot, intakeMdPath } = getRepoPaths(repoId);
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(intakeMdPath, markdown, "utf-8");
}

export function loadIntakeReport(repoId: string): string | null {
  const { intakeMdPath } = getRepoPaths(repoId);
  if (!fs.existsSync(intakeMdPath)) return null;
  return fs.readFileSync(intakeMdPath, "utf-8");
}

/**
 * Lists all repo IDs that have a metadata.json on disk (i.e. every repo
 * ever onboarded, regardless of current in-memory server state). Used to
 * rehydrate server state after a restart.
 */
export function listAllOnboardedRepoIds(): string[] {
  if (!fs.existsSync(REPOS_ROOT)) return [];
  return fs
    .readdirSync(REPOS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((repoId) => fs.existsSync(getRepoPaths(repoId).metadataPath));
}


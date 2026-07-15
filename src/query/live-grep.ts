import { listFiles, readRepoFile } from "../repo-manager";

export interface GrepMatch {
  filePath: string;
  lineNumber: number;
  context: string;
  matchedTerm: string;
  priority: number;
}

export interface GrepChunk {
  id: string;
  text: string;
  section: string;
  metadata: {
    source_file: string;
    line_number: number;
    search_method: "grep";
    relevance: number;
  };
}

const IGNORE_DIR_PATTERN =
  /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|\.nuxt|__pycache__)(\/|$)/i;
const IGNORE_EXTENSIONS =
  /\.(png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|lock|min\.js|map)$/i;

const STOP_WORDS = new Set([
  "how", "what", "why", "when", "where", "which", "who", "whom",
  "the", "a", "an", "is", "are", "does", "do", "did", "this", "that",
  "these", "those", "with", "for", "and", "or", "of", "to", "in", "on",
  "it", "work", "works", "about", "can", "could", "should", "would",
  "i", "you", "we", "they", "he", "she", "me", "my", "your", "our",
]);

/**
 * Maps common question intents to additional search terms, so questions
 * like "How do I run this project?" also search for related keywords
 * (npm scripts, setup docs, etc.) even though those exact words aren't in
 * the question.
 */
const INTENT_EXPANSIONS: Record<string, string[]> = {
  run: ["start", "npm", "dev", "scripts", "run", "launch"],
  start: ["run", "npm", "dev", "scripts", "launch"],
  install: ["setup", "npm", "install", "requirements", "dependencies"],
  setup: ["install", "setup", "configure", "getting", "started"],
  build: ["build", "compile", "npm", "scripts"],
  deploy: ["deploy", "docker", "production", "hosting"],
  test: ["test", "tests", "spec", "jest", "pytest"],
  auth: ["auth", "login", "session", "token", "authentication"],
  configure: ["config", "env", "setup", "settings"],
};

/**
 * Extracts meaningful search terms from a natural-language question,
 * stripping stop words and expanding common intents (e.g. "run" also
 * pulls in "npm", "scripts", "start") so grep has a better chance of
 * finding relevant files like README.md or package.json.
 */
export function extractSearchTerms(question: string): string[] {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const baseTerms = words.filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const expanded = new Set<string>(baseTerms);
  for (const term of baseTerms) {
    const synonyms = INTENT_EXPANSIONS[term];
    if (synonyms) {
      synonyms.forEach((s) => expanded.add(s));
    }
  }

  // If nothing useful was extracted, fall back to generic "how do I use this" terms.
  if (expanded.size === 0) {
    ["setup", "run", "install", "start"].forEach((t) => expanded.add(t));
  }

  return Array.from(expanded);
}

/**
 * Priority file patterns, checked in order. Files matching an earlier
 * pattern are searched first and scored with a higher relevance.
 */
const PRIORITY_PATTERNS: { pattern: RegExp; priority: number }[] = [
  { pattern: /(^|\/)readme\.md$/i, priority: 10 },
  { pattern: /(^|\/)(contributing|setup|installation)\.md$/i, priority: 9 },
  { pattern: /(^|\/)package\.json$/i, priority: 8 },
  { pattern: /(^|\/)\.env\.example$/i, priority: 7 },
  { pattern: /(^|\/)(dockerfile|docker-compose\.ya?ml)$/i, priority: 6 },
  {
    pattern: /(^|\/)(src\/app\/page\.(tsx|jsx)|src\/app\/layout\.(tsx|jsx)|index\.(js|ts))$/i,
    priority: 5,
  },
  { pattern: /\.(ts|tsx|js|jsx|py)$/i, priority: 2 },
];

function priorityForFile(relFile: string): number {
  for (const { pattern, priority } of PRIORITY_PATTERNS) {
    if (pattern.test(relFile)) return priority;
  }
  return 1;
}

/**
 * Live grep fallback: scans the cloned repo, prioritizing README/setup/
 * package.json/entry-point files, for lines matching any of the extracted
 * search terms. Returns up to maxResults chunk-like objects formatted
 * similarly to vector store chunks so they can feed directly into the LLM
 * prompt alongside (or instead of) vector search results.
 */
export function grepRepository(
  repoPath: string,
  question: string,
  maxResults = 5
): GrepChunk[] {
  const terms = extractSearchTerms(question);
  if (terms.length === 0) return [];

  const termPattern = new RegExp(
    terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "i"
  );

  const MAX_FILES_TO_SCAN = 300; // cap I/O cost for large repos
  const MAX_FILE_READ_CHARS = 50_000;

  const files = listFiles(repoPath)
    .filter((f) => !IGNORE_DIR_PATTERN.test(f) && !IGNORE_EXTENSIONS.test(f))
    .map((f) => ({ file: f, priority: priorityForFile(f) }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, MAX_FILES_TO_SCAN);

  const matches: GrepMatch[] = [];

  for (const { file, priority } of files) {
    if (matches.length >= maxResults * 3) break; // gather a bit extra before trimming

    const content = readRepoFile(repoPath, file, MAX_FILE_READ_CHARS);
    if (content === null) continue;

    // For high-priority files (README, package.json, setup docs), include
    // the file even without an exact term match, since these are almost
    // always relevant to "how do I use/run/install this" questions.
    const isHighPriority = priority >= 6;
    const lines = content.split(/\r?\n/);
    let matchedInFile = false;

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(termPattern);
      if (!match) continue;

      matchedInFile = true;
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length, i + 3);
      matches.push({
        filePath: file,
        lineNumber: i + 1,
        context: lines.slice(start, end).join("\n"),
        matchedTerm: match[0],
        priority,
      });
    }

    if (!matchedInFile && isHighPriority) {
      // Include a leading excerpt of the file itself (e.g. README intro,
      // package.json scripts block) even with no direct keyword hit.
      matches.push({
        filePath: file,
        lineNumber: 1,
        context: lines.slice(0, 40).join("\n"),
        matchedTerm: "(file overview)",
        priority: priority - 1, // slightly lower than an exact match
      });
    }
  }

  matches.sort((a, b) => b.priority - a.priority);
  return formatGrepResults(matches.slice(0, maxResults));
}

/**
 * Converts raw grep matches into chunk-like objects compatible with the
 * shape used by vector search results, so the query handler can treat both
 * sources uniformly when building LLM context.
 */
export function formatGrepResults(matches: GrepMatch[]): GrepChunk[] {
  return matches.map((m) => ({
    id: `grep_${m.filePath.replace(/[\\/]/g, "_")}_${m.lineNumber}`,
    text: `${m.filePath}:\n${m.context}`,
    section: m.filePath,
    metadata: {
      source_file: m.filePath,
      line_number: m.lineNumber,
      search_method: "grep" as const,
      relevance: Math.min(0.6, 0.3 + m.priority / 20),
    },
  }));
}


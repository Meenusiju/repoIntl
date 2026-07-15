export interface WebhookCommit {
  id: string;
  message: string;
  added?: string[];
  removed?: string[];
  modified?: string[];
}

const IGNORE_PATTERNS = [
  /^\.git\//,
  /^node_modules\//,
  /^public\//,
  /^dist\//,
  /^build\//,
];

/**
 * Combines added/removed/modified file lists across all commits in a push
 * payload into a single deduplicated list, filtering out paths we never
 * want to trigger doc analysis for.
 */
export function parseChangedFiles(commits: WebhookCommit[]): string[] {
  const files = new Set<string>();
  for (const commit of commits) {
    for (const f of [...(commit.added || []), ...(commit.removed || []), ...(commit.modified || [])]) {
      if (IGNORE_PATTERNS.some((re) => re.test(f))) continue;
      files.add(f);
    }
  }
  return Array.from(files);
}

export type DocSection =
  | "Architecture"
  | "Standards"
  | "Dependencies"
  | "Security"
  | "Vulnerabilities"
  | "Coverage";

/**
 * Maps a set of changed file paths to the intake-report sections that are
 * likely affected, so we only re-run the relevant specialist agent(s)
 * instead of the full 6-agent onboarding pipeline.
 */
export function determineAffectedSections(changedFiles: string[]): DocSection[] {
  const sections = new Set<DocSection>();

  for (const file of changedFiles) {
    if (/^(package\.json|package-lock\.json|yarn\.lock|requirements\.txt|pom\.xml|go\.mod|Gemfile.*|Cargo\.toml)$/i.test(file)) {
      sections.add("Dependencies");
      sections.add("Vulnerabilities");
      continue;
    }
    if (/\.env(\.|$)|(^|\/)config(\/|$)|(^|\/)security(\/|$)|Dockerfile|docker-compose/i.test(file)) {
      sections.add("Security");
      continue;
    }
    if (/(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\.(ts|js|py)$/i.test(file)) {
      sections.add("Coverage");
      continue;
    }
    if (/\.(eslintrc.*|prettierrc.*)$/i.test(file)) {
      sections.add("Standards");
      continue;
    }
    if (/\.(ts|tsx|js|jsx|py|java|go|rb|php|cs|cpp|c|rs|kt|swift)$/i.test(file)) {
      sections.add("Architecture");
      sections.add("Standards");
    }
  }

  return Array.from(sections);
}

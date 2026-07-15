import { AgentContext } from "../../types";
import { readRepoFile } from "../../repo-manager";

export const AGENT_NAME = "Vulnerability Analyzer";

export function buildPrompt(ctx: AgentContext): {
  systemPrompt: string;
  userPrompt: string;
} {
  const packageLock =
    readRepoFile(ctx.repoPath, "package-lock.json") ||
    readRepoFile(ctx.repoPath, "yarn.lock") ||
    "(not found)";
  const requirementsTxt =
    readRepoFile(ctx.repoPath, "requirements.txt") || "(not found)";
  const packageJson = readRepoFile(ctx.repoPath, "package.json") || "(not found)";

  const systemPrompt = `You are the Vulnerability Analyzer Agent in RepoIntel.
Your job: review dependency manifests and flag potentially outdated or commonly
vulnerable dependencies based on general knowledge (you do not have live CVE feed access,
so clearly state this is a best-effort static analysis). Output concise Markdown.`;

  const userPrompt = `Analyze dependencies for potential known vulnerabilities.

## package.json
\`\`\`json
${packageJson.slice(0, 3000)}
\`\`\`

## package-lock.json / yarn.lock (excerpt)
\`\`\`
${packageLock.slice(0, 2000)}
\`\`\`

## requirements.txt
\`\`\`
${requirementsTxt.slice(0, 1500)}
\`\`\`

Produce:
1. Dependencies that appear outdated or historically vulnerability-prone
2. General risk level (low/medium/high) with rationale
3. Recommendation to run \`npm audit\` / \`pip-audit\` for authoritative results
Keep it under 350 words. State clearly this is best-effort, not a live CVE scan.`;

  return { systemPrompt, userPrompt };
}

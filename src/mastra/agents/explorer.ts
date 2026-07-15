import { AgentContext } from "../../types";
import { readRepoFile } from "../../repo-manager";

export const AGENT_NAME = "Explorer Agent";

export function buildPrompt(ctx: AgentContext): {
  systemPrompt: string;
  userPrompt: string;
} {
  const packageJson = readRepoFile(ctx.repoPath, "package.json") || "(not found)";
  const readme =
    readRepoFile(ctx.repoPath, "README.md") ||
    readRepoFile(ctx.repoPath, "readme.md") ||
    "(not found)";
  const fileTree = ctx.fileList.slice(0, 300).join("\n");

  const systemPrompt = `You are the Explorer Agent in RepoIntel, an automated repository intake system.
Your job: analyze the repository's architecture, tech stack, and entry points.
Be concise, factual, and structured. Output valid Markdown with clear sub-headings.
Do not speculate about things you cannot infer from the provided context.`;

  const userPrompt = `Analyze this repository and produce an "Architecture & Tech Stack" overview.

## package.json
\`\`\`json
${packageJson.slice(0, 4000)}
\`\`\`

## README (excerpt)
\`\`\`
${readme.slice(0, 3000)}
\`\`\`

## File tree (partial)
\`\`\`
${fileTree}
\`\`\`

Produce output covering:
1. High-level architecture overview
2. Detected tech stack (languages, frameworks, libraries)
3. Likely entry points (main files, servers, CLIs)
Keep it under 500 words.`;

  return { systemPrompt, userPrompt };
}

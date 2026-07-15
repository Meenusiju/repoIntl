import { AgentContext } from "../../types";
import { readRepoFile } from "../../repo-manager";

export const AGENT_NAME = "Dependency Mapper";

export function buildPrompt(ctx: AgentContext): {
  systemPrompt: string;
  userPrompt: string;
} {
  const packageJson = readRepoFile(ctx.repoPath, "package.json") || "(not found)";
  const envExample =
    readRepoFile(ctx.repoPath, ".env.example") ||
    readRepoFile(ctx.repoPath, ".env.sample") ||
    "(not found)";
  const configFiles = ctx.fileList
    .filter((f) => /config|docker-compose|\.yml$|\.yaml$/i.test(f))
    .slice(0, 40)
    .join("\n");

  const systemPrompt = `You are the Dependency Mapper Agent in RepoIntel.
Your job: extract external APIs, third-party services, and domains this repo depends on.
Output a WAF-ready dependency list (a list suitable for configuring a Web Application Firewall
allow-list). Be concise and structured Markdown. Never include secret values.`;

  const userPrompt = `Analyze this repository's external dependencies and integrations.

## package.json
\`\`\`json
${packageJson.slice(0, 3000)}
\`\`\`

## .env.example (names only, no values matter)
\`\`\`
${envExample.slice(0, 1000)}
\`\`\`

## Config-related files detected
\`\`\`
${configFiles}
\`\`\`

Produce:
1. External APIs / services used (best-effort inference from deps and config)
2. Domains/hosts likely contacted (for WAF allow-listing)
3. Any package registries or CDNs referenced
Keep it under 400 words.`;

  return { systemPrompt, userPrompt };
}

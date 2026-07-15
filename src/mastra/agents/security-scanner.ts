import { AgentContext } from "../../types";
import { readRepoFile } from "../../repo-manager";

export const AGENT_NAME = "Security Scanner";

export function buildPrompt(ctx: AgentContext): {
  systemPrompt: string;
  userPrompt: string;
} {
  const envExample =
    readRepoFile(ctx.repoPath, ".env.example") ||
    readRepoFile(ctx.repoPath, ".env.sample") ||
    "(not found)";
  const dockerfile = readRepoFile(ctx.repoPath, "Dockerfile") || "(not found)";
  const certFiles = ctx.fileList.filter((f) =>
    /\.(pem|crt|key|cert)$/i.test(f)
  );
  const configFiles = ctx.fileList.filter((f) =>
    /docker-compose|\.env$|nginx\.conf/i.test(f)
  );

  const systemPrompt = `You are the Security Scanner Agent in RepoIntel.
Your job: scan .env variable NAMES (never values), certificate file presence, and hosting
configs to detect credential types, hosting configuration, and security concerns.
NEVER echo back any secret values, only variable names and file names. Output concise Markdown.`;

  const userPrompt = `Analyze security-relevant signals in this repository.

## .env.example variable names
\`\`\`
${envExample.slice(0, 1500)}
\`\`\`

## Dockerfile (excerpt)
\`\`\`
${dockerfile.slice(0, 1500)}
\`\`\`

## Certificate-like files detected
${certFiles.length ? certFiles.join("\n") : "(none found)"}

## Other config files detected
${configFiles.length ? configFiles.join("\n") : "(none found)"}

Produce:
1. Credential types referenced (by variable name pattern only, e.g. API_KEY, DB_PASSWORD)
2. Hosting configuration observations (Docker, reverse proxy, etc.)
3. Security concerns or red flags (e.g. checked-in certs/keys, missing .env.example)
Keep it under 400 words.`;

  return { systemPrompt, userPrompt };
}

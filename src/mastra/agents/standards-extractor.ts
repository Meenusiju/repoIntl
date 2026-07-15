import { AgentContext } from "../../types";
import { readRepoFile } from "../../repo-manager";

export const AGENT_NAME = "Standards Extractor";

export function buildPrompt(ctx: AgentContext): {
  systemPrompt: string;
  userPrompt: string;
} {
  const eslintrc =
    readRepoFile(ctx.repoPath, ".eslintrc.json") ||
    readRepoFile(ctx.repoPath, ".eslintrc.js") ||
    readRepoFile(ctx.repoPath, ".eslintrc") ||
    "(not found)";
  const prettierrc = readRepoFile(ctx.repoPath, ".prettierrc") || "(not found)";
  const sampleFile = ctx.fileList.find((f) => /\.(ts|js|py)$/i.test(f));
  const sampleContent = sampleFile
    ? readRepoFile(ctx.repoPath, sampleFile) || ""
    : "(no sample file found)";

  const systemPrompt = `You are the Standards Extractor Agent in RepoIntel.
Your job: analyze lint/format configs and a code sample to detect coding conventions:
indentation style, naming conventions, docstring/comment style. Output concise Markdown.`;

  const userPrompt = `Analyze the coding standards used in this repository.

## .eslintrc
\`\`\`
${eslintrc.slice(0, 1500)}
\`\`\`

## .prettierrc
\`\`\`
${prettierrc.slice(0, 500)}
\`\`\`

## Sample code file: ${sampleFile || "N/A"}
\`\`\`
${sampleContent.slice(0, 2500)}
\`\`\`

Produce:
1. Indentation style (spaces/tabs, width)
2. Naming conventions (camelCase, snake_case, etc.)
3. Docstring/comment style
4. Any other detected conventions (quotes, semicolons, line length)
Keep it under 350 words.`;

  return { systemPrompt, userPrompt };
}

import { AgentContext } from "../../types";
import { readRepoFile } from "../../repo-manager";

export const AGENT_NAME = "Coverage Analyzer";

export function buildPrompt(ctx: AgentContext): {
  systemPrompt: string;
  userPrompt: string;
} {
  const testFiles = ctx.fileList.filter((f) =>
    /(test|spec|__tests__)/i.test(f)
  );
  const coverageFiles = ctx.fileList.filter((f) =>
    /coverage|lcov/i.test(f)
  );
  const sourceFiles = ctx.fileList.filter((f) =>
    /\.(ts|js|py)$/i.test(f) && !/(test|spec|__tests__)/i.test(f)
  );

  const systemPrompt = `You are the Coverage Analyzer Agent in RepoIntel.
Your job: find test files and coverage reports, then infer test coverage gaps and
untested logic areas. Output concise Markdown.`;

  const userPrompt = `Analyze test coverage signals in this repository.

## Test files detected (${testFiles.length})
${testFiles.slice(0, 60).join("\n") || "(none found)"}

## Coverage report files detected
${coverageFiles.slice(0, 20).join("\n") || "(none found)"}

## Total source files (non-test)
${sourceFiles.length}

## Sample of source files without obvious matching test file
${sourceFiles
  .filter(
    (f) =>
      !testFiles.some((t) => t.toLowerCase().includes(
        f.split("/").pop()!.replace(/\.(ts|js|py)$/i, "").toLowerCase()
      ))
  )
  .slice(0, 30)
  .join("\n")}

Produce:
1. Overall test coverage impression (none/light/moderate/heavy)
2. Specific untested or lightly-tested areas
3. Recommendations for improving coverage
Keep it under 350 words.`;

  return { systemPrompt, userPrompt };
}

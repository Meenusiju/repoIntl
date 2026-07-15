import { AgentContext } from "../types";
import { callAgent } from "../mastra/llm-client";
import * as explorer from "../mastra/agents/explorer";
import * as dependencyMapper from "../mastra/agents/dependency-mapper";
import * as standardsExtractor from "../mastra/agents/standards-extractor";
import * as securityScanner from "../mastra/agents/security-scanner";
import * as vulnAnalyzer from "../mastra/agents/vuln-analyzer";
import * as coverageAnalyzer from "../mastra/agents/coverage-analyzer";
import { DocSection } from "../github/git-diff-parser";

type AgentModule = {
  AGENT_NAME: string;
  buildPrompt: (ctx: AgentContext) => { systemPrompt: string; userPrompt: string };
};

// Maps each intake-report section name to the single specialist agent
// responsible for producing it (mirrors the Synthesizer's fixed section
// list in synthesizer.ts).
const SECTION_TO_AGENT: Record<DocSection, AgentModule> = {
  Architecture: explorer,
  Standards: standardsExtractor,
  Dependencies: dependencyMapper,
  Security: securityScanner,
  Vulnerabilities: vulnAnalyzer,
  Coverage: coverageAnalyzer,
};

/**
 * Runs ONLY the specialist agents for the affected sections (not the full
 * 6-agent + synthesizer pipeline), keeping merge-triggered doc updates fast
 * and cheap. Returns a map of section name -> updated Markdown body (no
 * "## Heading" line — that's added by section-updater.ts).
 */
export async function runTargetedAnalysis(
  ctx: AgentContext,
  affectedSections: DocSection[]
): Promise<Record<string, string>> {
  const uniqueSections = Array.from(new Set(affectedSections));

  const results = await Promise.all(
    uniqueSections.map(async (section) => {
      const agent = SECTION_TO_AGENT[section];
      try {
        const { systemPrompt, userPrompt } = agent.buildPrompt(ctx);
        const output = await callAgent({ systemPrompt, userPrompt });
        return [section, output] as const;
      } catch (err: any) {
        throw new Error(`${agent.AGENT_NAME} (targeted update) failed: ${err?.message || err}`);
      }
    })
  );

  const sectionMap: Record<string, string> = {};
  for (const [section, output] of results) {
    sectionMap[section] = output;
  }
  return sectionMap;
}

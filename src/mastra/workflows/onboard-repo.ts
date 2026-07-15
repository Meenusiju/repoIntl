import { AgentContext, AgentResult } from "../../types";
import { callAgent } from "../llm-client";
import * as explorer from "../agents/explorer";
import * as dependencyMapper from "../agents/dependency-mapper";
import * as standardsExtractor from "../agents/standards-extractor";
import * as securityScanner from "../agents/security-scanner";
import * as vulnAnalyzer from "../agents/vuln-analyzer";
import * as coverageAnalyzer from "../agents/coverage-analyzer";
import * as synthesizer from "../agents/synthesizer";

export type ProgressCallback = (agentName: string, status: string) => void;

const PARALLEL_AGENTS = [
  explorer,
  dependencyMapper,
  standardsExtractor,
  securityScanner,
  vulnAnalyzer,
  coverageAnalyzer,
];

/**
 * Runs the 6 specialist agents in TRUE parallel using Promise.all, then
 * feeds their combined outputs into the Synthesizer agent.
 *
 * If any agent fails, the whole workflow rejects (all-or-nothing), and no
 * intake report is produced or indexed.
 */
export async function runOnboardWorkflow(
  repoUrl: string,
  ctx: AgentContext,
  onProgress?: ProgressCallback
): Promise<string> {
  onProgress?.("all", "analyzing:start");

  const agentPromises = PARALLEL_AGENTS.map(async (agentModule) => {
    onProgress?.(agentModule.AGENT_NAME, "running");
    try {
      const { systemPrompt, userPrompt } = agentModule.buildPrompt(ctx);
      const output = await callAgent({ systemPrompt, userPrompt });
      onProgress?.(agentModule.AGENT_NAME, "completed");
      const result: AgentResult = {
        agentName: agentModule.AGENT_NAME,
        output,
      };
      return result;
    } catch (err: any) {
      onProgress?.(agentModule.AGENT_NAME, "failed");
      throw new Error(
        `${agentModule.AGENT_NAME} failed: ${err?.message || err}`
      );
    }
  });

  // True parallel execution - all 6 agents start simultaneously.
  const results: AgentResult[] = await Promise.all(agentPromises);

  onProgress?.("Synthesizer Agent", "running");
  const { systemPrompt, userPrompt } = synthesizer.buildPrompt(
    repoUrl,
    results
  );
  let report: string;
  try {
    report = await callAgent({
      systemPrompt,
      userPrompt,
      maxTokens: 4096,
    });
  } catch (err: any) {
    onProgress?.("Synthesizer Agent", "failed");
    throw new Error(`Synthesizer Agent failed: ${err?.message || err}`);
  }
  onProgress?.("Synthesizer Agent", "completed");

  return report;
}

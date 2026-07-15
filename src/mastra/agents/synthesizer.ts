import { AgentResult } from "../../types";

export const AGENT_NAME = "Synthesizer Agent";

export function buildPrompt(
  repoUrl: string,
  results: AgentResult[]
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `You are the Synthesizer Agent in RepoIntel, the final stage of an automated
repository intake pipeline. You receive outputs from 6 specialist agents and must combine them
into ONE coherent, comprehensive intake report in Markdown.

The report MUST use "##" section headers exactly as follows, in this order:
## Overview
## Architecture
## Dependencies
## Standards
## Security
## Vulnerabilities
## Coverage
## Risk Flags
## Recommended Actions

Write in clear, professional prose suitable for an engineering audience. Aim for a
comprehensive report (target 2000-3000 words total). Do not fabricate information not
present in the specialist outputs; synthesize and organize what was provided.`;

  const combined = results
    .map((r) => `### ${r.agentName} output\n${r.output}`)
    .join("\n\n---\n\n");

  const userPrompt = `Repository: ${repoUrl}

Below are the raw outputs from the 6 specialist agents. Synthesize them into the
full intake report following the required section structure exactly.

${combined}`;

  return { systemPrompt, userPrompt };
}

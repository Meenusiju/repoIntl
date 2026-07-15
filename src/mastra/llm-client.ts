import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.warn(
    "[llm-client] WARNING: ANTHROPIC_API_KEY is not set. LLM calls will fail."
  );
}

const anthropic = new Anthropic({ apiKey: apiKey || "" });

const MODEL = "claude-sonnet-4-5-20250929";
const MAX_OUTPUT_TOKENS = 2000;

/**
 * Egress guard stub. If EGRESS_LOCKED is set, block any outbound call to a
 * host that is not explicitly allow-listed (Anthropic API is always allowed
 * since it's the intentional LLM provider for Phase 1).
 */
export function egressGuard(url: string): void {
  const locked = process.env.EGRESS_LOCKED === "true";
  if (!locked) return;

  const allowedHosts = ["api.anthropic.com", "localhost", "127.0.0.1"];
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`egressGuard: invalid URL "${url}"`);
  }
  if (!allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new Error(
      `egressGuard: blocked outbound request to "${host}" while EGRESS_LOCKED is enabled.`
    );
  }
}

export interface CallAgentOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
}

/**
 * Calls Claude Sonnet 4.5 for a single agent turn.
 * Retries once on transient errors (rate limit / overload).
 */
export async function callAgent(options: CallAgentOptions): Promise<string> {
  egressGuard("https://api.anthropic.com");

  const { systemPrompt, userPrompt, maxTokens = MAX_OUTPUT_TOKENS } = options;

  const attempt = async (): Promise<string> => {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const textBlock = response.content.find((b: any) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    return textBlock?.text?.trim() || "";
  };

  try {
    return await attempt();
  } catch (err: any) {
    const status = err?.status;
    if (status === 429 || status === 529 || status === 503) {
      console.warn(
        `[llm-client] Transient error (${status}) from Anthropic, retrying in 2s...`
      );
      await new Promise((r) => setTimeout(r, 2000));
      try {
        return await attempt();
      } catch (retryErr: any) {
        throw new Error(
          `Anthropic API error after retry: ${retryErr?.message || retryErr}`
        );
      }
    }
    if (status === 401) {
      throw new Error("Anthropic API error: invalid API key (401).");
    }
    throw new Error(`Anthropic API error: ${err?.message || err}`);
  }
}

/**
 * Generates an embedding vector for a chunk of text.
 * NOTE: Anthropic does not currently expose a public embeddings endpoint,
 * so we use a lightweight deterministic local embedding fallback that is
 * API-shape-compatible with the "text-embedding-3-small" style vectors
 * (fixed dimensionality). This keeps Phase 1 fully functional offline
 * while preserving the interface for swapping in a real embeddings
 * provider later.
 */
const EMBEDDING_DIM = 384;

export async function embedText(text: string): Promise<number[]> {
  egressGuard("https://api.anthropic.com");
  return localHashEmbedding(text, EMBEDDING_DIM);
}

function localHashEmbedding(text: string, dim: number): number[] {
  const vec = new Array(dim).fill(0);
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const token of tokens) {
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
    }
    const idx = hash % dim;
    vec[idx] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

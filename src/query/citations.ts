import { VectorSearchResult } from "./vector-search";

export interface Citation {
  chunkId: string;
  section: string;
  similarity: number;
}

const KNOWN_SECTIONS = [
  "Overview",
  "Architecture",
  "Dependencies",
  "Standards",
  "Security",
  "Vulnerabilities",
  "Coverage",
  "Risk Flags",
  "Recommended Actions",
];

/**
 * Parses the LLM's answer text for references to known section names and
 * cross-matches them against the source chunks that were actually provided
 * as context, returning only the chunks the answer appears to reference.
 * Falls back to returning all source chunks if no explicit section mention
 * is detected (best-effort; the LLM doesn't always cite explicitly).
 */
export function extractCitations(
  answer: string,
  sourceChunks: VectorSearchResult[]
): Citation[] {
  const lowerAnswer = answer.toLowerCase();
  const mentionedSections = new Set<string>();

  for (const section of KNOWN_SECTIONS) {
    if (lowerAnswer.includes(section.toLowerCase())) {
      mentionedSections.add(section);
    }
  }

  let matched = sourceChunks.filter((chunk) =>
    mentionedSections.has(chunk.metadata?.section)
  );

  if (matched.length === 0) {
    matched = sourceChunks; // best-effort fallback: cite everything used
  }

  return matched.map((chunk) => ({
    chunkId: chunk.chunkId,
    section: chunk.metadata?.section || "Unknown",
    similarity: chunk.similarity,
  }));
}

/**
 * Lightly formats the raw LLM answer for markdown display: bolds known
 * section names so citations stand out visually on the dashboard.
 */
export function formatAnswer(answer: string): string {
  let formatted = answer;
  for (const section of KNOWN_SECTIONS) {
    const pattern = new RegExp(`\\b(${section})\\b(?!\\*)`, "g");
    formatted = formatted.replace(pattern, "**$1**");
  }
  return formatted;
}

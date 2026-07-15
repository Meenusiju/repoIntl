import { v4 as uuidv4 } from "uuid";
import { Chunk } from "../types";

/**
 * Splits an intake report markdown into chunks by "##" section headers.
 * Each chunk includes its heading text as the section name in metadata.
 */
export function chunkMarkdownBySections(
  markdown: string,
  repoId: string,
  sourceFile = "intake.md"
): Chunk[] {
  const lines = markdown.split(/\r?\n/);
  const chunks: Chunk[] = [];

  let currentSection = "Introduction";
  let currentLines: string[] = [];

  const flush = () => {
    const text = currentLines.join("\n").trim();
    if (text.length > 0) {
      chunks.push({
        id: uuidv4(),
        text,
        metadata: {
          repoId,
          section: currentSection,
          sourceFile,
          chunkType: "markdown_section",
        },
      });
    }
    currentLines = [];
  };

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(.+)$/);
    if (headerMatch) {
      flush();
      currentSection = headerMatch[1].trim();
      currentLines.push(line);
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return chunks;
}

import { embedText } from "../mastra/llm-client";
import { chunkMarkdownBySections } from "./chunking";
import {
  getOrCreateCollection,
  addToCollection,
  collectionNameForRepo,
} from "./client";

export interface IndexResult {
  collectionName: string;
  chunkCount: number;
}

/**
 * Chunks the intake report, embeds each chunk, and stores it in a
 * per-repo Chroma collection (repo_{repoId}).
 */
export async function indexIntakeReport(
  repoId: string,
  markdown: string
): Promise<IndexResult> {
  const chunks = chunkMarkdownBySections(markdown, repoId);
  if (chunks.length === 0) {
    throw new Error("No chunks produced from intake report; nothing to index.");
  }

  const collectionName = collectionNameForRepo(repoId);
  const collection = await getOrCreateCollection(collectionName);

  const embeddings = await Promise.all(
    chunks.map((chunk) => embedText(chunk.text))
  );

  await addToCollection({
    collectionId: collection.id,
    ids: chunks.map((c) => c.id),
    embeddings,
    documents: chunks.map((c) => c.text),
    metadatas: chunks.map((c) => ({
      repo_id: c.metadata.repoId,
      section: c.metadata.section,
      source_file: c.metadata.sourceFile,
      chunk_type: c.metadata.chunkType,
    })),
  });

  return { collectionName, chunkCount: chunks.length };
}

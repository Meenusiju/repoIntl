import {
  readLocalCollection,
  localCollectionExists,
  collectionNameForRepo,
} from "../chroma/client";

export interface VectorSearchResult {
  chunkId: string;
  text: string;
  metadata: Record<string, any>;
  similarity: number;
}

/**
 * Cosine similarity between two equal-length vectors.
 * Returns 0 if either magnitude is 0 (edge case guard).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dotProduct += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }

  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);

  if (magnitudeA === 0 || magnitudeB === 0) return 0;
  return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * Queries the local JSON vector store for the top-K chunks most similar to
 * the given question embedding. Throws if the repo's collection doesn't
 * exist (i.e. the repo was never indexed).
 */
export function queryVectorStore(
  repoId: string,
  questionEmbedding: number[],
  topK = 3
): VectorSearchResult[] {
  const collectionName = collectionNameForRepo(repoId);

  if (!localCollectionExists(collectionName)) {
    throw new Error(
      `No indexed data found for repo "${repoId}". It may not be onboarded yet or is still being analyzed.`
    );
  }

  const collection = readLocalCollection(collectionName);
  if (!collection || collection.items.length === 0) {
    throw new Error(`Vector store for repo "${repoId}" is empty.`);
  }

  const results: VectorSearchResult[] = collection.items.map((item) => ({
    chunkId: item.id,
    text: item.document,
    metadata: item.metadata,
    similarity: cosineSimilarity(questionEmbedding, item.embedding),
  }));

  return results.sort((a, b) => b.similarity - a.similarity).slice(0, topK);
}

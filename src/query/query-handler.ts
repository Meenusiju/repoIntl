import { getRepoPaths, loadMetadata } from "../repo-manager";
import { embedText, callAgent } from "../mastra/llm-client";
import { queryVectorStore, VectorSearchResult } from "./vector-search";
import { grepRepository, GrepChunk } from "./live-grep";
import { extractCitations, formatAnswer } from "./citations";
import { QueryResponse, SearchMethod } from "../types";

const SIMILARITY_THRESHOLD = 0.5;
const MAX_QUESTION_LENGTH = 500;
const QUERY_TIMEOUT_MS = 60_000;

/**
 * Answers a natural-language question about a previously onboarded repo by:
 * 1. Embedding the question
 * 2. Searching the local vector store for relevant intake-report chunks
 * 3. Falling back to a live grep over the cloned source if similarity is low
 * 4. Asking Claude Sonnet to answer using the retrieved context
 * 5. Extracting best-effort citations
 */
export async function handleQuery(
  repoId: string,
  question: string
): Promise<QueryResponse> {
  const start = Date.now();
  try {
    const result = await withTimeout(runQuery(repoId, question), QUERY_TIMEOUT_MS);
    console.log(`[query:${repoId}] Completed in ${Date.now() - start}ms (method: ${result.searchMethod})`);
    return result;
  } catch (err) {
    console.error(`[query:${repoId}] Failed after ${Date.now() - start}ms`);
    throw err;
  }
}

async function runQuery(
  repoId: string,
  question: string
): Promise<QueryResponse> {
  validateInput(repoId, question);

  const { sourceDir } = getRepoPaths(repoId);
  const metadata = loadMetadata(repoId);
  if (!metadata) {
    throw new Error(`Repo "${repoId}" not found.`);
  }
  if (metadata.status !== "completed") {
    throw new Error(
      `Repo is still being analyzed (status: ${metadata.status}). Try again in a moment.`
    );
  }

  let stageStart = Date.now();
  const questionEmbedding = await embedText(question);
  console.log(`[query:${repoId}] Embedded question in ${Date.now() - stageStart}ms`);

  let searchMethod: SearchMethod = "vector";
  let contextChunks: VectorSearchResult[] = [];
  let confidence = 0;

  const NO_ANSWER_MESSAGE =
    "Could not find answer in indexed data or codebase. Try asking about: Architecture, Dependencies, Security, Vulnerabilities, Test Coverage";

  stageStart = Date.now();
  try {
    const vectorResults = queryVectorStore(repoId, questionEmbedding, 3);
    const maxSimilarity = vectorResults.length > 0 ? vectorResults[0].similarity : 0;

    if (maxSimilarity > SIMILARITY_THRESHOLD) {
      contextChunks = vectorResults.slice(0, 3);
      confidence = maxSimilarity;
    } else {
      const grepChunks = fallbackToGrep(sourceDir, question);
      if (grepChunks.length > 0) {
        searchMethod = "grep";
        contextChunks = grepChunks;
        confidence = maxSimilarity; // report the (low) vector confidence that triggered fallback
      } else if (vectorResults.length > 0) {
        // No grep matches either; use whatever vector results we have.
        contextChunks = vectorResults.slice(0, 3);
        confidence = maxSimilarity;
      } else {
        throw new Error(NO_ANSWER_MESSAGE);
      }
    }
  } catch (err: any) {
    if (err.message === NO_ANSWER_MESSAGE) throw err;

    // Vector store missing/empty — fall back straight to grep.
    searchMethod = "grep";
    contextChunks = fallbackToGrep(sourceDir, question);
    confidence = 0;
    if (contextChunks.length === 0) {
      throw new Error(NO_ANSWER_MESSAGE);
    }
  }
  console.log(`[query:${repoId}] Search (${searchMethod}) completed in ${Date.now() - stageStart}ms, ${contextChunks.length} chunks`);

  const contextText = contextChunks
    .map((c, i) => `[Chunk ${i + 1} — ${c.metadata?.section || c.metadata?.filePath || "source"}]\n${c.text}`)
    .join("\n\n---\n\n");

  const systemPrompt = `You are an expert code reviewer. Answer questions about a repository based on the provided context. Always cite which sections or files your answer comes from. If the context doesn't contain enough information, say so explicitly.`;

  const userPrompt = `Context from repository analysis:
${contextText}

Question: ${question}

Answer based on the context above. Reference specific sections (e.g., 'According to the Architecture section...').`;

  let rawAnswer: string;
  stageStart = Date.now();
  try {
    rawAnswer = await callAgent({
      systemPrompt,
      userPrompt,
      maxTokens: 1500,
    });
  } catch (err: any) {
    throw new Error(`Failed to generate answer: ${err.message}`);
  }
  console.log(`[query:${repoId}] LLM answer generated in ${Date.now() - stageStart}ms`);

  const answer = formatAnswer(rawAnswer);
  const citations = extractCitations(rawAnswer, contextChunks);

  return {
    answer,
    sources: citations,
    searchMethod,
    confidence,
  };
}

function fallbackToGrep(sourceDir: string, question: string): VectorSearchResult[] {
  const grepChunks: GrepChunk[] = grepRepository(sourceDir, question, 5);

  return grepChunks.map((g) => ({
    chunkId: g.id,
    text: g.text,
    metadata: {
      section: g.section,
      filePath: g.metadata.source_file,
      lineNumber: g.metadata.line_number,
      search_method: g.metadata.search_method,
    },
    similarity: g.metadata.relevance,
  }));
}

function validateInput(repoId: string, question: string): void {
  if (!repoId || typeof repoId !== "string") {
    throw new Error("repoId is required");
  }
  if (!question || typeof question !== "string" || question.trim().length === 0) {
    throw new Error("question is required");
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new Error(`question must be under ${MAX_QUESTION_LENGTH} characters`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Query took too long (timeout after 30 seconds)."));
    }, ms);
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

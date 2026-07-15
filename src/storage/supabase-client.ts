import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { RepoMetadata } from "../types";

let client: SupabaseClient | null = null;
let configChecked = false;
let configured = false;

/**
 * Returns true if SUPABASE_URL + a key are present in env, meaning we should
 * use Supabase as the persistence layer instead of the local filesystem.
 * This lets RepoIntel keep working with zero external setup for local dev
 * (falls back to ./repos on disk) while surviving Vercel redeploys in
 * production once Supabase is configured.
 */
export function isSupabaseConfigured(): boolean {
  if (!configChecked) {
    configured = Boolean(
      process.env.SUPABASE_URL &&
        (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)
    );
    configChecked = true;
  }
  return configured;
}

function getClient(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new Error(
        "Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)."
      );
    }
    client = createClient(url, key, {
      auth: { persistSession: false },
    });
  }
  return client;
}

// ---------------------------------------------------------------------------
// Repo metadata + intake report (table: repos)
// ---------------------------------------------------------------------------

interface RepoRow {
  repo_id: string;
  repo_url: string;
  status: string;
  created_at: string;
  progress: number | null;
  current_agent: string | null;
  error: string | null;
  last_docs_pr_url: string | null;
  last_docs_pr_at: string | null;
  intake_report: string | null;
}

function rowToMetadata(row: RepoRow): RepoMetadata {
  return {
    repoId: row.repo_id,
    repoUrl: row.repo_url,
    status: row.status as RepoMetadata["status"],
    createdAt: row.created_at,
    progress: row.progress ?? undefined,
    currentAgent: row.current_agent ?? undefined,
    error: row.error ?? undefined,
    lastDocsPrUrl: row.last_docs_pr_url ?? undefined,
    lastDocsPrAt: row.last_docs_pr_at ?? undefined,
  };
}

export async function saveRepoMetadata(repoId: string, metadata: RepoMetadata): Promise<void> {
  const supabase = getClient();
  const { error } = await supabase.from("repos").upsert(
    {
      repo_id: repoId,
      repo_url: metadata.repoUrl,
      status: metadata.status,
      created_at: metadata.createdAt,
      progress: metadata.progress ?? null,
      current_agent: metadata.currentAgent ?? null,
      error: metadata.error ?? null,
      last_docs_pr_url: metadata.lastDocsPrUrl ?? null,
      last_docs_pr_at: metadata.lastDocsPrAt ?? null,
    },
    { onConflict: "repo_id" }
  );
  if (error) throw new Error(`Supabase: failed to save repo metadata: ${error.message}`);
}

export async function getRepoMetadata(repoId: string): Promise<RepoMetadata | null> {
  const supabase = getClient();
  const { data, error } = await supabase
    .from("repos")
    .select("*")
    .eq("repo_id", repoId)
    .maybeSingle();
  if (error) throw new Error(`Supabase: failed to fetch repo metadata: ${error.message}`);
  return data ? rowToMetadata(data as RepoRow) : null;
}

export async function getAllRepoIds(): Promise<string[]> {
  const supabase = getClient();
  const { data, error } = await supabase
    .from("repos")
    .select("repo_id")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Supabase: failed to list repos: ${error.message}`);
  return (data || []).map((r: { repo_id: string }) => r.repo_id);
}

export async function saveIntakeReportToSupabase(repoId: string, markdown: string): Promise<void> {
  const supabase = getClient();
  const { error } = await supabase
    .from("repos")
    .update({ intake_report: markdown })
    .eq("repo_id", repoId);
  if (error) throw new Error(`Supabase: failed to save intake report: ${error.message}`);
}

export async function getIntakeReportFromSupabase(repoId: string): Promise<string | null> {
  const supabase = getClient();
  const { data, error } = await supabase
    .from("repos")
    .select("intake_report")
    .eq("repo_id", repoId)
    .maybeSingle();
  if (error) throw new Error(`Supabase: failed to fetch intake report: ${error.message}`);
  return data?.intake_report ?? null;
}

// ---------------------------------------------------------------------------
// Vector chunks (table: vector_chunks) — one row per chunk, repo_id groups
// them into what the rest of the app treats as a single "collection".
// Embeddings are stored as jsonb (plain float arrays), not pgvector, since
// RepoIntel's local hash-embedding fallback uses 384 dims and similarity
// search is computed client-side in query/vector-search.ts either way.
// ---------------------------------------------------------------------------

export interface StoredChunk {
  id: string;
  embedding: number[];
  document: string;
  metadata: Record<string, any>;
}

export async function saveVectorChunks(repoId: string, chunks: StoredChunk[]): Promise<void> {
  const supabase = getClient();
  const rows = chunks.map((c) => ({
    id: c.id,
    repo_id: repoId,
    chunk_id: c.id,
    text: c.document,
    embedding: c.embedding,
    section: c.metadata?.section ?? null,
    metadata: c.metadata,
  }));
  const { error } = await supabase.from("vector_chunks").upsert(rows, { onConflict: "id" });
  if (error) throw new Error(`Supabase: failed to save vector chunks: ${error.message}`);
}

export async function getVectorChunks(repoId: string): Promise<StoredChunk[]> {
  const supabase = getClient();
  const { data, error } = await supabase
    .from("vector_chunks")
    .select("id, text, embedding, metadata")
    .eq("repo_id", repoId);
  if (error) throw new Error(`Supabase: failed to fetch vector chunks: ${error.message}`);
  return (data || []).map((row: any) => ({
    id: row.id,
    embedding: row.embedding,
    document: row.text,
    metadata: row.metadata || {},
  }));
}

export async function vectorChunksExist(repoId: string): Promise<boolean> {
  const supabase = getClient();
  const { count, error } = await supabase
    .from("vector_chunks")
    .select("id", { count: "exact", head: true })
    .eq("repo_id", repoId);
  if (error) throw new Error(`Supabase: failed to check vector chunks: ${error.message}`);
  return (count ?? 0) > 0;
}

import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const CHROMA_URL = process.env.CHROMA_URL || "http://localhost:8000";
// Vercel serverless functions have a read-only filesystem except for /tmp
// (writable but ephemeral). Locally we keep using ./repos so the local
// vector store persists across restarts, matching REPOS_ROOT in
// repo-manager.ts.
const LOCAL_STORE_ROOT = process.env.VERCEL
  ? path.join("/tmp", "repos", ".chroma-local")
  : path.join(process.cwd(), "repos", ".chroma-local");

export interface ChromaCollection {
  id: string;
  name: string;
}

export interface AddToCollectionParams {
  collectionId: string;
  ids: string[];
  embeddings: number[][];
  documents: string[];
  metadatas: Record<string, any>[];
}

// ---------------------------------------------------------------------------
// Remote Chroma REST client (used when a real Chroma server is reachable at
// CHROMA_URL). Falls back to the local JSON vector store below when the
// server is unreachable, so RepoIntel works out-of-the-box with no external
// service dependency.
// ---------------------------------------------------------------------------

let remoteAvailable: boolean | null = null; // cached after first probe

async function isRemoteAvailable(): Promise<boolean> {
  if (remoteAvailable !== null) return remoteAvailable;
  try {
    const res = await fetch(`${CHROMA_URL}/api/v1/heartbeat`, {
      method: "GET",
    });
    remoteAvailable = res.ok;
  } catch {
    remoteAvailable = false;
  }
  if (!remoteAvailable) {
    console.warn(
      `[chroma] No Chroma server reachable at ${CHROMA_URL}. Falling back to local file-based vector store at ${LOCAL_STORE_ROOT}.`
    );
  }
  return remoteAvailable;
}

async function remoteRequest<T>(
  urlPath: string,
  options: { method?: string; body?: object } = {}
): Promise<T> {
  const url = `${CHROMA_URL}${urlPath}`;
  let res;
  try {
    res = await fetch(url, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (err: any) {
    throw new Error(
      `Chroma not running or unreachable at ${CHROMA_URL} (connection refused): ${err.message}`
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Chroma API error [${res.status}]: ${text}`);
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return (await res.json()) as T;
  }
  return undefined as unknown as T;
}

// ---------------------------------------------------------------------------
// Local file-based vector store fallback (no external service required).
// Stores one JSON file per collection under repos/.chroma-local/{name}.json
// ---------------------------------------------------------------------------

export interface LocalCollectionFile {
  id: string;
  name: string;
  items: {
    id: string;
    embedding: number[];
    document: string;
    metadata: Record<string, any>;
  }[];
}

function localCollectionPath(name: string): string {
  return path.join(LOCAL_STORE_ROOT, `${name}.json`);
}

function localGetOrCreateCollection(name: string): ChromaCollection {
  fs.mkdirSync(LOCAL_STORE_ROOT, { recursive: true });
  const filePath = localCollectionPath(name);
  if (!fs.existsSync(filePath)) {
    const initial: LocalCollectionFile = { id: name, name, items: [] };
    fs.writeFileSync(filePath, JSON.stringify(initial, null, 2), "utf-8");
  }
  return { id: name, name };
}

function localAddToCollection(params: AddToCollectionParams): void {
  const filePath = localCollectionPath(params.collectionId);
  let data: LocalCollectionFile;
  if (fs.existsSync(filePath)) {
    data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } else {
    data = { id: params.collectionId, name: params.collectionId, items: [] };
  }

  for (let i = 0; i < params.ids.length; i++) {
    data.items.push({
      id: params.ids[i],
      embedding: params.embeddings[i],
      document: params.documents[i],
      metadata: params.metadatas[i],
    });
  }

  fs.mkdirSync(LOCAL_STORE_ROOT, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function localListCollections(): ChromaCollection[] {
  if (!fs.existsSync(LOCAL_STORE_ROOT)) return [];
  return fs
    .readdirSync(LOCAL_STORE_ROOT)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const name = f.replace(/\.json$/, "");
      return { id: name, name };
    });
}

/**
 * Cosine similarity search against a local collection. Useful for future
 * query features; not required by Phase 1's write-only indexing flow but
 * included for completeness/parity with a real vector DB.
 */
export function localQueryCollection(
  name: string,
  queryEmbedding: number[],
  topK = 5
): { document: string; metadata: Record<string, any>; score: number }[] {
  const filePath = localCollectionPath(name);
  if (!fs.existsSync(filePath)) return [];
  const data: LocalCollectionFile = JSON.parse(
    fs.readFileSync(filePath, "utf-8")
  );

  const cosine = (a: number[], b: number[]) => {
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / ((Math.sqrt(normA) || 1) * (Math.sqrt(normB) || 1));
  };

  return data.items
    .map((item) => ({
      document: item.document,
      metadata: item.metadata,
      score: cosine(queryEmbedding, item.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ---------------------------------------------------------------------------
// Public API (transparently uses remote Chroma when available, otherwise
// falls back to the local store)
// ---------------------------------------------------------------------------

export async function getOrCreateCollection(
  name: string
): Promise<ChromaCollection> {
  if (await isRemoteAvailable()) {
    try {
      return await remoteRequest<ChromaCollection>(`/api/v1/collections`, {
        method: "POST",
        body: { name, get_or_create: true },
      });
    } catch (err: any) {
      console.warn(
        `[chroma] Remote call failed (${err.message}), falling back to local store.`
      );
      remoteAvailable = false;
    }
  }
  return localGetOrCreateCollection(name);
}

export async function addToCollection(
  params: AddToCollectionParams
): Promise<void> {
  if (await isRemoteAvailable()) {
    try {
      await remoteRequest<void>(
        `/api/v1/collections/${params.collectionId}/add`,
        {
          method: "POST",
          body: {
            ids: params.ids,
            embeddings: params.embeddings,
            documents: params.documents,
            metadatas: params.metadatas,
          },
        }
      );
      return;
    } catch (err: any) {
      console.warn(
        `[chroma] Remote add failed (${err.message}), falling back to local store.`
      );
      remoteAvailable = false;
    }
  }
  localAddToCollection(params);
}

export async function listCollections(): Promise<ChromaCollection[]> {
  if (await isRemoteAvailable()) {
    try {
      return await remoteRequest<ChromaCollection[]>(`/api/v1/collections`);
    } catch {
      remoteAvailable = false;
    }
  }
  return localListCollections();
}

export function collectionNameForRepo(repoId: string): string {
  return `repo_${repoId}`;
}

/**
 * Reads the raw local collection file (chunk id + embedding + document +
 * metadata for every stored chunk). Returns null if the collection doesn't
 * exist locally. Used by the query layer (Phase 2) for vector search that
 * needs chunk IDs, independent of whether a remote Chroma is configured.
 */
export function readLocalCollection(name: string): LocalCollectionFile | null {
  const filePath = localCollectionPath(name);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function localCollectionExists(name: string): boolean {
  return fs.existsSync(localCollectionPath(name));
}


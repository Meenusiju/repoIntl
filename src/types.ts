export interface RepoMetadata {
  repoId: string;
  repoUrl: string;
  createdAt: string;
  status: RepoStatus;
  currentAgent?: string;
  progress?: number;
  error?: string;
  lastDocsPrUrl?: string;
  lastDocsPrAt?: string;
}

export type RepoStatus =
  | "cloning"
  | "analyzing"
  | "synthesizing"
  | "indexing"
  | "completed"
  | "failed";

export interface AgentResult {
  agentName: string;
  output: string;
}

export interface AgentContext {
  repoId: string;
  repoPath: string;
  fileList: string[];
  readFile: (relativePath: string) => string | null;
}

export interface OnboardRequestBody {
  repoUrl: string;
}

export interface OnboardResponse {
  repoId: string;
  status: RepoStatus;
}

export interface StatusResponse {
  repoId: string;
  status: RepoStatus;
  progress: number;
  currentAgent?: string;
  error?: string;
}

export interface RepoDetailResponse {
  repoId: string;
  status: RepoStatus;
  intakeReport?: string;
  metadata: RepoMetadata;
}

export interface ChunkMetadata {
  repoId: string;
  section: string;
  sourceFile: string;
  chunkType: string;
}

export interface Chunk {
  id: string;
  text: string;
  metadata: ChunkMetadata;
}

export interface QueryRequestBody {
  repoId: string;
  question: string;
}

export interface QuerySource {
  chunkId: string;
  section: string;
  similarity: number;
}

export type SearchMethod = "vector" | "grep";

export interface QueryResponse {
  answer: string;
  sources: QuerySource[];
  searchMethod: SearchMethod;
  confidence: number;
}


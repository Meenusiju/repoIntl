# RepoIntel — Phase 1

Repository onboarding with AI-powered intake reports. Clones a public GitHub repo,
runs 6 specialist AI agents in parallel (Claude Sonnet), synthesizes a full intake
report, and indexes it into Chroma for searchable access.

## Prerequisites

- Node.js 18+
- A `.env` file (copy `.env.example` to `.env`) with `ANTHROPIC_API_KEY` set
- Chroma running locally: `pip install chromadb` then `chroma run --port 8000`

## Setup

```powershell
npm install
Copy-Item .env.example .env   # then edit .env and add your ANTHROPIC_API_KEY
```

## Running

Start the dashboard + API server (defaults to port 3010, configurable via `PORT` in `.env`):

```powershell
npm run dev
```

Then open http://localhost:3010 and click **"+ Onboard Repository"**, or use the CLI:

```powershell
npm run onboard -- https://github.com/<user>/<repo>
```

## Project Structure

- `src/repo-manager.ts` — git clone, file listing/reading, repo ID generation
- `src/mastra/llm-client.ts` — Anthropic Claude Sonnet 4.5 wrapper + embeddings + egress guard
- `src/mastra/agents/*` — 6 specialist agents + synthesizer
- `src/mastra/workflows/onboard-repo.ts` — runs the 6 agents in true parallel via `Promise.all`, then synthesizer
- `src/chroma/*` — Chroma REST client, markdown chunking (by `##` headers), embedding + indexing
- `src/api.ts` — Express server (`/api/onboard`, `/api/repos/:id/status`, `/api/repos/:id`)
- `src/index.ts` — CLI entry point for onboarding without the server
- `public/` — dashboard (vanilla HTML/CSS/JS, renders markdown via `marked`)

## API

- `POST /api/onboard { repoUrl }` → `{ repoId, status }` (202, runs in background)
- `GET /api/repos/:repoId/status` → `{ repoId, status, progress, currentAgent?, error? }`
- `GET /api/repos/:repoId` → `{ repoId, status, intakeReport, metadata }`
- `GET /api/repos` → list of all onboarded repos

## Output

Each onboarded repo produces:
- `repos/{repoId}/source/` — cloned repository
- `repos/{repoId}/intake.md` — synthesized markdown intake report
- `repos/{repoId}/metadata.json` — status/progress metadata
- A Chroma collection named `repo_{repoId}` with embedded, chunked report sections

## Notes

- Phase 1 supports **public** GitHub repos only.
- Embeddings use a local deterministic hashing fallback (Anthropic has no public
  embeddings endpoint); swap `embedText` in `src/mastra/llm-client.ts` for a real
  embeddings provider later if needed.
- Set `EGRESS_LOCKED=true` in `.env` to enable the outbound egress guard stub.

import express from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import crypto from "crypto";
import {
  generateRepoId,
  validateGithubUrl,
  cloneRepo,
  listFiles,
  readRepoFile,
  saveMetadata,
  loadMetadata,
  saveIntakeReport,
  loadIntakeReport,
  getRepoPaths,
  listAllOnboardedRepoIds,
} from "./repo-manager";
import { runOnboardWorkflow } from "./mastra/workflows/onboard-repo";
import { indexIntakeReport } from "./chroma/indexing";
import { handleQuery } from "./query/query-handler";
import { parseChangedFiles, determineAffectedSections } from "./github/git-diff-parser";
import { runTargetedAnalysis } from "./merge-analysis/targeted-analysis";
import { updateIntakeReport } from "./merge-analysis/section-updater";
import { computeDocDelta } from "./merge-analysis/doc-delta";
import { createDocsPR } from "./github/pr-creator";
import {
  RepoMetadata,
  OnboardRequestBody,
  OnboardResponse,
  StatusResponse,
  RepoDetailResponse,
  QueryRequestBody,
  QueryResponse,
} from "./types";

dotenv.config();

const app = express();
app.use(cors());
// Capture the raw request body alongside the parsed JSON so the GitHub
// webhook handler can verify the HMAC signature against the exact bytes
// GitHub signed (signature verification fails if you re-serialize JSON).
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 3000;

// In-memory status tracking (backed by metadata.json on disk for durability).
const inMemoryStatus = new Map<string, RepoMetadata>();

/**
 * Rehydrates in-memory repo status from metadata.json files on disk so the
 * repo list and detail views survive server restarts.
 */
async function hydrateStatusFromDisk() {
  const repoIds = await listAllOnboardedRepoIds();
  for (const repoId of repoIds) {
    const meta = await loadMetadata(repoId);
    if (meta) {
      inMemoryStatus.set(repoId, meta);
    }
  }
  console.log(`Rehydrated ${repoIds.length} onboarded repo(s) from disk.`);
}
hydrateStatusFromDisk().catch((err) => {
  console.error("Failed to rehydrate status from storage:", err.message);
});

async function updateStatus(repoId: string, patch: Partial<RepoMetadata>): Promise<void> {
  const current = inMemoryStatus.get(repoId) || ({} as RepoMetadata);
  const updated: RepoMetadata = { ...current, ...patch, repoId };
  inMemoryStatus.set(repoId, updated);
  await saveMetadata(repoId, updated);
}

app.post("/api/onboard", async (req, res) => {
  const body: OnboardRequestBody = req.body;
  let repoId: string;

  try {
    validateGithubUrl(body.repoUrl);
    repoId = generateRepoId(body.repoUrl);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  const initialMeta: RepoMetadata = {
    repoId,
    repoUrl: body.repoUrl,
    createdAt: new Date().toISOString(),
    status: "cloning",
    progress: 0,
  };
  await updateStatus(repoId, initialMeta);

  const response: OnboardResponse = { repoId, status: "cloning" };
  res.status(202).json(response);

  // Run the full onboarding pipeline in the background.
  runOnboardingPipeline(repoId, body.repoUrl).catch((err) => {
    console.error(`[onboard:${repoId}] Pipeline failed:`, err.message);
    updateStatus(repoId, { status: "failed", error: err.message }).catch(() => {});
  });
});

async function runOnboardingPipeline(repoId: string, repoUrl: string) {
  console.log(`[onboard:${repoId}] Cloning ${repoUrl}...`);
  await updateStatus(repoId, { status: "cloning", progress: 5 });
  const sourceDir = await cloneRepo(repoUrl, repoId);

  console.log(`[onboard:${repoId}] Listing files...`);
  const fileList = listFiles(sourceDir);

  console.log(`[onboard:${repoId}] Running 6 agents in parallel...`);
  await updateStatus(repoId, { status: "analyzing", progress: 15 });

  const ctx = {
    repoId,
    repoPath: sourceDir,
    fileList,
    readFile: (rel: string) => readRepoFile(sourceDir, rel),
  };

  let agentsCompleted = 0;
  const report = await runOnboardWorkflow(repoUrl, ctx, (agentName, status) => {
    console.log(`[onboard:${repoId}] ${agentName}: ${status}`);
    if (status === "completed" && agentName !== "Synthesizer Agent") {
      agentsCompleted++;
      const progress = 15 + Math.round((agentsCompleted / 6) * 50);
      updateStatus(repoId, {
        status: "analyzing",
        progress,
        currentAgent: agentName,
      }).catch((err) => console.error(`[onboard:${repoId}] status update failed:`, err.message));
    } else if (agentName === "Synthesizer Agent" && status === "running") {
      updateStatus(repoId, {
        status: "synthesizing",
        progress: 70,
        currentAgent: agentName,
      }).catch((err) => console.error(`[onboard:${repoId}] status update failed:`, err.message));
    }
  });

  console.log(`[onboard:${repoId}] Saving intake report...`);
  await saveIntakeReport(repoId, report);

  console.log(`[onboard:${repoId}] Indexing in Chroma...`);
  await updateStatus(repoId, { status: "indexing", progress: 85 });
  const indexResult = await indexIntakeReport(repoId, report);
  console.log(
    `[onboard:${repoId}] Indexed ${indexResult.chunkCount} chunks into ${indexResult.collectionName}`
  );

  await updateStatus(repoId, {
    status: "completed",
    progress: 100,
    currentAgent: undefined,
    error: undefined,
  });
  console.log(`[onboard:${repoId}] Onboarding complete.`);
}

app.get("/api/repos/:repoId/status", async (req, res) => {
  const { repoId } = req.params;
  const meta = inMemoryStatus.get(repoId) || (await loadMetadata(repoId));
  if (!meta) {
    return res.status(404).json({ error: "Repo not found" });
  }
  const response: StatusResponse = {
    repoId,
    status: meta.status,
    progress: meta.progress || 0,
    currentAgent: meta.currentAgent,
    error: meta.error,
  };
  res.json(response);
});

app.get("/api/repos/:repoId", async (req, res) => {
  const { repoId } = req.params;
  const meta = inMemoryStatus.get(repoId) || (await loadMetadata(repoId));
  if (!meta) {
    return res.status(404).json({ error: "Repo not found" });
  }
  const intakeReport = (await loadIntakeReport(repoId)) || undefined;
  const response: RepoDetailResponse = {
    repoId,
    status: meta.status,
    intakeReport,
    metadata: meta,
  };
  res.json(response);
});

app.get("/api/repos", (req, res) => {
  res.json(Array.from(inMemoryStatus.values()));
});

/**
 * Verifies the `X-Hub-Signature-256` header GitHub sends with every webhook
 * delivery. Returns false (and logs why) if the secret isn't configured,
 * the header is missing, or the computed HMAC doesn't match.
 */
function verifyGithubSignature(rawBody: Buffer | undefined, signatureHeader: string | undefined): boolean {
  // .trim() guards against trailing newlines/whitespace that can sneak in
  // when pasting the secret into the Vercel dashboard or GitHub's webhook
  // secret field (the same class of bug that broke ANTHROPIC_API_KEY earlier).
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.warn("[webhook] GITHUB_WEBHOOK_SECRET is not set — rejecting webhook for safety.");
    return false;
  }
  if (!rawBody || !signatureHeader) {
    console.warn(
      `[webhook] Missing ${!rawBody ? "raw body" : "signature header"} — rejecting webhook.`
    );
    return false;
  }
  const trimmedSignature = signatureHeader.trim();
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(trimmedSignature);
  if (expectedBuf.length !== actualBuf.length) {
    // Never log the actual secret/signature values, but the lengths alone
    // are a very useful diagnostic: if they differ, it's almost always a
    // whitespace/encoding mismatch in the configured secret rather than a
    // "real" attack, since both sides compute a fixed-length hex digest.
    console.warn(
      `[webhook] Signature length mismatch (expected ${expectedBuf.length} chars, got ${actualBuf.length}). ` +
        `Check for extra whitespace/newlines in GITHUB_WEBHOOK_SECRET on both GitHub and Vercel.`
    );
    return false;
  }
  const valid = crypto.timingSafeEqual(expectedBuf, actualBuf);
  if (!valid) {
    console.warn(
      "[webhook] Signature values differ despite matching length — the configured secret likely doesn't match between GitHub and Vercel."
    );
  }
  return valid;
}

/**
 * GitHub webhook receiver. Configure this URL in a GitHub repo's
 * Settings > Webhooks as: https://<your-domain>/api/webhooks/github
 * Content type: application/json, Secret: same value as GITHUB_WEBHOOK_SECRET,
 * Events: just the "push" event is needed (or "Send me everything").
 *
 * On a "push" event for an already-onboarded repo, this re-runs the full
 * onboarding pipeline (re-clone, re-analyze, re-index) in the background so
 * the intake report and vector store stay in sync with the latest commit.
 * Unknown/not-yet-onboarded repos and non-push events are acknowledged but
 * ignored.
 */
app.post("/api/webhooks/github", async (req, res) => {
  const signature = req.header("x-hub-signature-256");
  const event = req.header("x-github-event");
  const delivery = req.header("x-github-delivery");
  const rawBody: Buffer | undefined = (req as any).rawBody;

  if (!verifyGithubSignature(rawBody, signature)) {
    console.warn(`[webhook] Rejected delivery ${delivery || "(unknown)"}: invalid or missing signature`);
    return res.status(401).json({ error: "Invalid signature" });
  }

  // GitHub expects a fast 2xx response; do the actual work in the background.
  res.status(202).json({ received: true, event });

  if (event === "ping") {
    console.log(`[webhook] Received ping delivery ${delivery}`);
    return;
  }

  if (event !== "push") {
    console.log(`[webhook] Ignoring unsupported event "${event}" (delivery ${delivery})`);
    return;
  }

  const payload = req.body || {};
  const repoUrl: string | undefined = payload?.repository?.html_url;
  const ref: string | undefined = payload?.ref;
  const pusher: string | undefined = payload?.pusher?.name;

  if (!repoUrl) {
    console.warn(`[webhook] Push event missing repository.html_url (delivery ${delivery})`);
    return;
  }

  let repoId: string;
  try {
    repoId = generateRepoId(repoUrl);
  } catch (err: any) {
    console.warn(`[webhook] Could not derive repoId from ${repoUrl}: ${err.message}`);
    return;
  }

  const existing = inMemoryStatus.get(repoId) || (await loadMetadata(repoId));
  if (!existing) {
    console.log(`[webhook] Push to ${repoUrl} (${ref}) ignored — repo has not been onboarded yet`);
    return;
  }

  if (existing.status === "cloning" || existing.status === "analyzing" || existing.status === "synthesizing" || existing.status === "indexing") {
    console.log(`[webhook] Push to ${repoUrl} ignored — onboarding already in progress (status: ${existing.status})`);
    return;
  }

  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  console.log(`[webhook] Push to ${repoUrl} (${ref}) by ${pusher || "unknown"} — running targeted doc update for ${repoId}`);
  runMergeAnalysisPipeline(repoId, repoUrl, commits).catch((err) => {
    console.error(`[webhook:${repoId}] Merge-analysis pipeline failed:`, err.message);
  });
});

/**
 * Phase 4: instead of re-running the full 6-agent onboarding pipeline on
 * every push, this only re-analyzes the intake-report sections affected by
 * the files that actually changed, then opens a GitHub PR with the updated
 * docs for human review. Nothing is auto-merged.
 */
async function runMergeAnalysisPipeline(
  repoId: string,
  repoUrl: string,
  commits: Array<{ id: string; message: string; added?: string[]; removed?: string[]; modified?: string[] }>
): Promise<void> {
  if (commits.length === 0) {
    console.log(`[merge-analysis:${repoId}] Push had no commits payload; nothing to analyze.`);
    return;
  }

  const changedFiles = parseChangedFiles(commits);
  if (changedFiles.length === 0) {
    console.log(`[merge-analysis:${repoId}] No relevant changed files after filtering; skipping.`);
    return;
  }

  const affectedSections = determineAffectedSections(changedFiles);
  if (affectedSections.length === 0) {
    console.log(`[merge-analysis:${repoId}] Changed files don't map to any tracked doc section; skipping.`);
    return;
  }

  const oldReport = await loadIntakeReport(repoId);
  if (!oldReport) {
    console.warn(`[merge-analysis:${repoId}] No existing intake report on disk; skipping (run a full onboard first).`);
    return;
  }

  console.log(`[merge-analysis:${repoId}] Affected sections: ${affectedSections.join(", ")}. Re-downloading source for fresh analysis...`);
  const sourceDir = await cloneRepo(repoUrl, repoId);
  const fileList = listFiles(sourceDir);
  const ctx = {
    repoId,
    repoPath: sourceDir,
    fileList,
    readFile: (rel: string) => readRepoFile(sourceDir, rel),
  };

  const newSections = await runTargetedAnalysis(ctx, affectedSections);
  const delta = computeDocDelta(oldReport, newSections);

  if (delta.changeCount === 0) {
    console.log(`[merge-analysis:${repoId}] Re-analysis produced no substantive changes; not opening a PR.`);
    return;
  }

  const updatedReport = updateIntakeReport(oldReport, newSections);
  const commitHash = commits[commits.length - 1].id;

  const pr = await createDocsPR({
    repoUrl,
    updatedReport,
    commitHash,
    changedFiles,
    changedSections: delta.sections,
    summary: delta.summary,
  });

  console.log(`[merge-analysis:${repoId}] Opened docs PR: ${pr.prUrl}`);

  // Re-index the updated report so /api/query reflects the new content too,
  // even before the PR is merged (dashboard chat should stay current).
  await saveIntakeReport(repoId, updatedReport);
  try {
    await indexIntakeReport(repoId, updatedReport);
  } catch (err: any) {
    console.warn(`[merge-analysis:${repoId}] Re-indexing after doc update failed (non-fatal): ${err.message}`);
  }

  await updateStatus(repoId, {
    lastDocsPrUrl: pr.prUrl,
    lastDocsPrAt: new Date().toISOString(),
  });
}

app.post("/api/query", async (req, res) => {
  const body: QueryRequestBody = req.body;

  if (!body || !body.repoId || !body.question) {
    return res.status(400).json({ error: "Missing repoId or question" });
  }

  try {
    const response: QueryResponse = await handleQuery(
      body.repoId,
      body.question
    );
    res.json(response);
  } catch (err: any) {
    console.error(`[query:${body.repoId}] Error:`, err.message);
    const message: string = err?.message || "Failed to answer query";
    let status = 500;
    if (/not found/i.test(message)) status = 404;
    else if (/still being analyzed|not indexed|empty/i.test(message)) status = 202;
    else if (/required|must be under/i.test(message)) status = 400;
    else if (/timeout|too long/i.test(message)) status = 504;
    res.status(status).json({ error: message });
  }
});

// Vercel's @vercel/node runtime imports this module and calls the exported
// Express app directly as a request handler; it does not need (and should
// not use) a listening server. Only bind a real port for local/dev/traditional
// hosting.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`RepoIntel API server running at http://localhost:${PORT}`);
  });
}

export default app;

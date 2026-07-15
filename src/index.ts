import dotenv from "dotenv";
import {
  generateRepoId,
  validateGithubUrl,
  cloneRepo,
  listFiles,
  readRepoFile,
  saveMetadata,
  saveIntakeReport,
} from "./repo-manager";
import { runOnboardWorkflow } from "./mastra/workflows/onboard-repo";
import { indexIntakeReport } from "./chroma/indexing";
import { RepoMetadata } from "./types";

dotenv.config();

/**
 * CLI entry point: onboard a repo directly without the Express server.
 * Usage: npm run onboard -- https://github.com/user/repo
 */
async function main() {
  const repoUrl = process.argv[2];
  if (!repoUrl) {
    console.error("Usage: npm run onboard -- <github-repo-url>");
    process.exit(1);
  }

  try {
    validateGithubUrl(repoUrl);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const repoId = generateRepoId(repoUrl);
  console.log(`Onboarding repo: ${repoUrl} (id: ${repoId})`);

  const meta: RepoMetadata = {
    repoId,
    repoUrl,
    createdAt: new Date().toISOString(),
    status: "cloning",
    progress: 0,
  };
  await saveMetadata(repoId, meta);

  try {
    console.log("Cloning repository...");
    const sourceDir = await cloneRepo(repoUrl, repoId);

    console.log("Listing files...");
    const fileList = listFiles(sourceDir);
    console.log(`Found ${fileList.length} files.`);

    const ctx = {
      repoId,
      repoPath: sourceDir,
      fileList,
      readFile: (rel: string) => readRepoFile(sourceDir, rel),
    };

    console.log("Running 6 agents in parallel + synthesizer...");
    const report = await runOnboardWorkflow(repoUrl, ctx, (agentName, status) => {
      console.log(`  [${agentName}] ${status}`);
    });

    console.log("Saving intake report...");
    await saveIntakeReport(repoId, report);

    console.log("Indexing in Chroma...");
    const indexResult = await indexIntakeReport(repoId, report);
    console.log(
      `Indexed ${indexResult.chunkCount} chunks into collection "${indexResult.collectionName}".`
    );

    await saveMetadata(repoId, { ...meta, status: "completed", progress: 100 });
    console.log(`\nDone! Intake report saved to /repos/${repoId}/intake.md`);
  } catch (err: any) {
    console.error(`\nOnboarding failed: ${err.message}`);
    await saveMetadata(repoId, { ...meta, status: "failed", error: err.message });
    process.exit(1);
  }
}

main();

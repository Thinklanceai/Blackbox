import { blackbox, verify } from "./blackbox";
import fs from "fs/promises";

// ─── Example: agent that reads a config, calls an LLM, writes a result ────────

async function runAgent() {
  const { bb, record } = blackbox({
    agent_id: "deploy-agent@1.0.0",
    tags: ["production", "critical"],
    onEvent: (e) => console.log(`[${e.seq}] ${e.type} → ${e.action}`),
  });

  // 1. Read a file
  const config = await record("file_read", "read_config", { path: "config.json" }, async () => {
    return { db_host: "prod-db", max_retries: 3 }; // simulated
  });

  // 2. Call an LLM
  const decision = await record("llm_call", "analyze_config", { config }, async () => {
    return { action: "deploy", confidence: 0.97 }; // simulated
  });

  // 3. Make a decision
  await record("decision", "should_deploy", { decision }, async () => {
    return decision.confidence > 0.9 ? "proceed" : "abort";
  });

  // 4. Deploy
  await record("deploy", "trigger_deployment", { target: "prod-v2" }, async () => {
    return { status: "success", sha: "abc123" };
  });

  // End run — get the portable artifact
  const artifact = bb.end();

  console.log("\n── Artifact ──────────────────────────────");
  console.log(`run_id     : ${artifact.run_id}`);
  console.log(`events     : ${artifact.event_count}`);
  console.log(`root_hash  : ${artifact.root_hash}`);

  // Verify integrity
  const result = verify(artifact);
  console.log(`integrity  : ${result.valid ? "✓ verified" : "✗ TAMPERED — " + result.reason}`);

  // Save to disk
  await fs.writeFile("run.blackbox", JSON.stringify(artifact, null, 2));
  console.log(`saved      : run.blackbox`);

  return artifact;
}

runAgent().catch(console.error);

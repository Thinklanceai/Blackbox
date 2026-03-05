import { writeFileSync } from "fs";
import { Blackbox, verify, BlackboxArtifact } from "./runtime.js";
import { style, line, eventIcon, formatDuration, c, printLogo } from "./render.js";

// Simulate a realistic agent run: code review bot that reads a PR,
// calls an LLM for analysis, writes a review, and posts a comment.

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export async function cmdDemo(): Promise<void> {
  printLogo();

  process.stdout.write(`${line()}\n`);
  process.stdout.write(`${style.header("  DEMO — code-review-agent")}\n`);
  process.stdout.write(`${line()}\n\n`);
  process.stdout.write(`  ${style.muted("Simulating a realistic agent run...")}\n\n`);

  const bb = new Blackbox({
    agent_id: "code-review-agent@2.1.0",
    tags: ["demo", "github", "production"],
    onEvent: (e) => {
      const icon  = eventIcon(e.type);
      const seq   = String(e.seq).padStart(4, "0");
      const dur   = formatDuration(e.duration_ms);
      const hash  = style.muted(e.hash.slice(0, 12) + "…");
      process.stdout.write(`  ${style.muted(seq)}  ${icon}  ${c.bold}${e.action}${c.reset}  ${dur}  ${hash}\n`);
    }
  });

  // Step 1: fetch PR metadata
  await sleep(40);
  const pr = await bb.record("http_request", "fetch_pr_metadata", { pr: 1337, repo: "org/api" }, async () => {
    await sleep(120);
    return { id: 1337, title: "feat: add rate limiting middleware", files_changed: 8, additions: 247, deletions: 31 };
  });

  // Step 2: fetch changed files
  await sleep(30);
  const files = await bb.record("http_request", "fetch_changed_files", { pr: pr.id }, async () => {
    await sleep(180);
    return [
      { path: "src/middleware/ratelimit.ts", additions: 89, deletions: 0 },
      { path: "src/middleware/ratelimit.test.ts", additions: 134, deletions: 0 },
      { path: "src/app.ts", additions: 12, deletions: 8 },
      { path: "src/config.ts", additions: 12, deletions: 23 },
    ];
  });

  // Step 3: read config
  await sleep(20);
  const config = await bb.record("file_read", "read_review_config", { path: ".reviewrc" }, async () => {
    await sleep(30);
    return { max_file_complexity: 15, require_tests: true, security_scan: true, llm_model: "claude-sonnet-4-20250514" };
  });

  bb.setState({ pr_id: pr.id, files_count: (files as Array<unknown>).length });

  // Step 4: LLM call for code analysis
  await sleep(50);
  const analysis = await bb.record("llm_call", "analyze_pr_changes", { files, config, pr }, async () => {
    await sleep(850); // realistic LLM latency
    return {
      summary: "Rate limiting middleware implementation looks solid. Uses token bucket algorithm correctly.",
      issues: [
        { severity: "warning", file: "src/middleware/ratelimit.ts", line: 47, message: "Redis connection not properly closed on error path" },
        { severity: "info",    file: "src/config.ts", line: 12, message: "Consider extracting magic number 1000 to named constant" },
      ],
      security: { passed: true, notes: "No injection vectors detected. Config values properly validated." },
      test_coverage: { estimated: "94%", adequate: true },
      approve: true,
      confidence: 0.91,
    };
  });

  // Step 5: decision
  await sleep(20);
  const decision = await bb.record("decision", "approve_or_request_changes", { analysis }, async () => {
    const a = analysis as { approve: boolean; confidence: number };
    return a.approve && a.confidence > 0.85 ? "approve" : "request_changes";
  });

  // Step 6: write review to memory
  await sleep(15);
  await bb.record("memory_write", "store_review_draft", { pr_id: pr.id }, async () => {
    return { stored: true, key: `review:${pr.id}` };
  });

  // Step 7: post review comment
  await sleep(30);
  await bb.record("http_request", "post_review_comment", { pr: pr.id, decision }, async () => {
    await sleep(200);
    return { id: "review_abc123", state: decision, posted_at: new Date().toISOString() };
  });

  // Step 8: update metrics
  await sleep(20);
  await bb.record("tool_call", "update_review_metrics", { agent: "code-review-agent", outcome: decision }, async () => {
    await sleep(60);
    return { metric: "reviews_completed", value: 1, labels: { decision, confidence: "high" } };
  });

  const artifact = bb.end();

  // Save to disk
  const filename = `demo-${artifact.run_id.slice(0, 8)}.blackbox`;
  writeFileSync(filename, JSON.stringify(artifact, null, 2));

  // Verify immediately
  const result = verify(artifact);

  process.stdout.write(`\n${line()}\n\n`);
  process.stdout.write(`  ${style.ok("✓ run complete")}  ${artifact.event_count} events  ${formatDuration(artifact.duration_ms)}\n`);
  process.stdout.write(`  ${result.valid ? style.ok("✓ chain verified") : style.err("✗ chain invalid")}\n`);
  process.stdout.write(`  ${style.muted("artifact")}   ${style.accent(filename)}\n`);
  process.stdout.write(`  ${style.muted("root_hash")}  ${style.muted(artifact.root_hash)}\n\n`);

  process.stdout.write(`  ${style.muted("next steps:")}\n`);
  process.stdout.write(`  ${style.muted("  blackbox verify ")}${style.accent(filename)}\n`);
  process.stdout.write(`  ${style.muted("  blackbox inspect ")}${style.accent(filename)}\n`);
  process.stdout.write(`  ${style.muted("  blackbox replay ")}${style.accent(filename)}\n\n`);
}

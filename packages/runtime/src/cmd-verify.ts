import { readFileSync } from "fs";
import { verify, replay, BlackboxArtifact, AgentEvent } from "./runtime.js";
import { style, line, eventIcon, formatDuration, formatTimestamp, badge, c, printLogo, eventColor, truncate } from "./render.js";

function loadArtifact(path: string): BlackboxArtifact {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as BlackboxArtifact;
  } catch (err) {
    console.error(style.err(`✗ Cannot read artifact: ${path}`));
    console.error(style.muted((err as Error).message));
    process.exit(1);
  }
}

function formatInput(val: unknown): string {
  if (val === null || val === undefined) return style.muted("∅");
  const s = JSON.stringify(val);
  return style.muted(truncate(s, 80));
}

function printEventDetail(event: AgentEvent, chainOk: boolean, hashOk: boolean): void {
  const seqStr  = String(event.seq).padStart(4, " ");
  const icon    = eventIcon(event.type);
  const color   = eventColor(event.type);
  const typeStr = `${color}${event.type.padEnd(14)}${c.reset}`;
  const action  = `${c.bold}${event.action}${c.reset}`;
  const dur     = formatDuration(event.duration_ms);
  const ts      = formatTimestamp(event.timestamp);

  const chainBadge = chainOk ? style.muted("⛓") : style.err("⛓✗");
  const hashBadge  = hashOk  ? style.muted("◈") : style.err("◈✗");

  process.stdout.write(`  ${style.muted(seqStr)}  ${icon} ${typeStr}  ${action}  ${dur}  ${ts}  ${chainBadge}${hashBadge}\n`);

  if (!chainOk) {
    process.stdout.write(`         ${style.err("↳ prev_hash mismatch — chain broken here")}\n`);
  }
  if (!hashOk) {
    process.stdout.write(`         ${style.err("↳ hash invalid — event content was altered")}\n`);
  }
  if (event.error) {
    process.stdout.write(`         ${style.err(`↳ ERROR: ${event.error.message}`)}\n`);
  }
}

function printStats(artifact: BlackboxArtifact): void {
  const { stats, duration_ms } = artifact;

  process.stdout.write(`\n${line()}\n`);
  process.stdout.write(`${style.header("  RUN SUMMARY")}\n`);
  process.stdout.write(`${line()}\n\n`);

  const rows: [string, string][] = [
    ["run_id",      style.accent(artifact.run_id)],
    ["agent",       style.accent(artifact.agent_id)],
    ["started",     formatTimestamp(artifact.started_at)],
    ["ended",       formatTimestamp(artifact.ended_at)],
    ["duration",    formatDuration(duration_ms)],
    ["events",      style.ok(String(stats.total_events))],
    ["errors",      stats.errors > 0 ? style.err(String(stats.errors)) : style.ok("0")],
    ["llm_calls",   style.muted(String(stats.llm_calls))],
    ["tool_calls",  style.muted(String(stats.tool_calls))],
    ["deploys",     stats.deploys > 0 ? style.warn(String(stats.deploys)) : style.muted("0")],
    ["execs",       stats.execs   > 0 ? style.warn(String(stats.execs))   : style.muted("0")],
    ["root_hash",   style.muted(artifact.root_hash.slice(0, 24) + "…")],
  ];

  for (const [label, value] of rows) {
    process.stdout.write(`  ${style.muted(label.padEnd(12))}  ${value}\n`);
  }
  process.stdout.write("\n");
}

function printEventBreakdown(artifact: BlackboxArtifact): void {
  const { stats } = artifact;
  process.stdout.write(`${line()}\n`);
  process.stdout.write(`${style.header("  EVENT BREAKDOWN")}\n`);
  process.stdout.write(`${line()}\n\n`);

  for (const [type, count] of Object.entries(stats.by_type)) {
    if (!count) continue;
    const icon = eventIcon(type);
    const bar  = "█".repeat(Math.min(count as number, 30));
    process.stdout.write(`  ${icon} ${type.padEnd(16)}  ${style.accent(bar)} ${style.muted(String(count))}\n`);
  }
  process.stdout.write("\n");
}

export function cmdVerify(filePath: string, opts: { verbose?: boolean; events?: boolean }): void {
  printLogo();
  const artifact = loadArtifact(filePath);

  process.stdout.write(`${line()}\n`);
  process.stdout.write(`${style.header("  INTEGRITY CHECK")}\n`);
  process.stdout.write(`${line()}\n\n`);
  process.stdout.write(`  ${style.muted("file")}      ${style.accent(filePath)}\n`);
  process.stdout.write(`  ${style.muted("events")}    ${artifact.event_count}\n\n`);

  // Run replay (streaming verification)
  let tampered = false;
  let tamperedAt = -1;
  const frames = [...replay(artifact)];

  if (opts.events || opts.verbose) {
    process.stdout.write(`  ${style.muted("seq".padEnd(4))}  ${style.muted("·")} ${style.muted("type".padEnd(14))}  ${style.muted("action")}\n`);
    process.stdout.write(`${line("─", 72)}\n`);

    for (const frame of frames) {
      const ok = frame.chain_valid && frame.state_hash_valid;
      if (!ok && !tampered) { tampered = true; tamperedAt = frame.event.seq; }
      if (opts.verbose || !ok) {
        printEventDetail(frame.event, frame.chain_valid, frame.state_hash_valid);
      } else {
        // compact mode — one dot per event
        const dot = ok ? `${c.green}·${c.reset}` : `${c.red}✗${c.reset}`;
        process.stdout.write(dot);
      }
    }
    if (!opts.verbose) process.stdout.write("\n");
    process.stdout.write("\n");
  } else {
    // Fast mode — just run verify()
    const result = verify(artifact);
    if (!result.valid) {
      tampered = true;
      tamperedAt = result.at_seq;
    }
  }

  // Final verdict
  process.stdout.write(`${line()}\n`);

  if (!tampered) {
    process.stdout.write(`\n  ${style.ok("✓ VERIFIED")}  ${style.muted("chain intact —")} ${artifact.event_count} events checked\n`);
    process.stdout.write(`  ${style.muted("root_hash")}  ${style.muted(artifact.root_hash)}\n\n`);
  } else {
    process.stdout.write(`\n  ${style.err("✗ TAMPERED")}  chain broken at seq ${tamperedAt}\n`);
    process.stdout.write(`  ${style.err("This artifact cannot be trusted.")}\n\n`);
  }

  if (opts.verbose) {
    printStats(artifact);
    printEventBreakdown(artifact);
  }

  process.exit(tampered ? 1 : 0);
}

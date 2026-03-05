import { readFileSync } from "fs";
import { BlackboxArtifact, verify, AgentEvent } from "./runtime.js";
import { style, line, eventIcon, formatDuration, formatTimestamp, c, printLogo, eventColor } from "./render.js";

function loadArtifact(path: string): BlackboxArtifact {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as BlackboxArtifact;
  } catch {
    console.error(style.err(`✗ Cannot read: ${path}`));
    process.exit(1);
  }
}

function printRunHeader(artifact: BlackboxArtifact): void {
  const v = verify(artifact);

  process.stdout.write(`${line()}\n`);
  process.stdout.write(`${style.header("  RUN OVERVIEW")}\n`);
  process.stdout.write(`${line()}\n\n`);

  const integrity = v.valid
    ? style.ok("✓ verified")
    : style.err(`✗ tampered at seq ${"at_seq" in v ? v.at_seq : "?"}`)

  const rows: [string, string][] = [
    ["run_id",     style.accent(artifact.run_id)],
    ["agent",      style.accent(artifact.agent_id)],
    ["integrity",  integrity],
    ["started",    formatTimestamp(artifact.started_at)],
    ["ended",      formatTimestamp(artifact.ended_at)],
    ["duration",   formatDuration(artifact.duration_ms)],
    ["events",     style.ok(String(artifact.event_count))],
    ["errors",     artifact.stats.errors > 0 ? style.err(String(artifact.stats.errors)) : style.ok("0")],
    ["root_hash",  style.muted(artifact.root_hash)],
  ];

  for (const [k, v] of rows) {
    process.stdout.write(`  ${style.muted(k.padEnd(12))}  ${v}\n`);
  }
  process.stdout.write("\n");
}

function printTimeline(events: AgentEvent[]): void {
  process.stdout.write(`${line()}\n`);
  process.stdout.write(`${style.header("  TIMELINE")}\n`);
  process.stdout.write(`${line()}\n\n`);

  // Calculate total duration for bar sizing
  const totalMs = events[events.length - 1]
    ? new Date(events[events.length - 1].timestamp).getTime() - new Date(events[0].timestamp).getTime()
    : 0;

  const BAR_WIDTH = 40;

  for (const event of events) {
    const icon    = eventIcon(event.type);
    const color   = eventColor(event.type);
    const seqStr  = String(event.seq).padStart(4, "0");
    const type    = `${color}${event.type.padEnd(14)}${c.reset}`;
    const action  = `${c.bold}${event.action}${c.reset}`;
    const dur     = event.duration_ms ?? 0;
    const durStr  = formatDuration(event.duration_ms);

    // Duration bar
    const barLen = totalMs > 0 ? Math.round((dur / totalMs) * BAR_WIDTH) : 0;
    const bar    = barLen > 0 ? `${color}${"█".repeat(Math.min(barLen, BAR_WIDTH))}${c.reset}` : "";

    let line_ = `  ${style.muted(seqStr)}  ${icon} ${type}  ${action.padEnd(30)}  ${durStr.padEnd(10)}  ${bar}`;
    if (event.error) line_ += `  ${style.err("⚠ " + event.error.message.slice(0, 40))}`;
    process.stdout.write(line_ + "\n");
  }
  process.stdout.write("\n");
}

function printCriticalPath(events: AgentEvent[]): void {
  const critical = events.filter(e =>
    ["deploy", "exec", "file_write", "llm_call"].includes(e.type)
  );

  if (critical.length === 0) return;

  process.stdout.write(`${line()}\n`);
  process.stdout.write(`${style.header("  CRITICAL PATH")}  ${style.muted("(deploy · exec · file_write · llm_call)")}\n`);
  process.stdout.write(`${line()}\n\n`);

  for (const e of critical) {
    const icon   = eventIcon(e.type);
    const color  = eventColor(e.type);
    const seqStr = String(e.seq).padStart(4, "0");
    const type   = `${color}${e.type.padEnd(14)}${c.reset}`;
    const dur    = formatDuration(e.duration_ms);
    const hash   = style.muted(e.hash.slice(0, 16) + "…");

    process.stdout.write(`  ${style.muted(seqStr)}  ${icon} ${type}  ${c.bold}${e.action}${c.reset}  ${dur}  ${hash}\n`);

    if (e.type === "deploy") {
      process.stdout.write(`  ${style.muted("             output")}  ${style.muted(JSON.stringify(e.output).slice(0, 80))}\n`);
    }
  }
  process.stdout.write("\n");
}

function printErrors(events: AgentEvent[]): void {
  const errors = events.filter(e => e.error);
  if (errors.length === 0) return;

  process.stdout.write(`${line()}\n`);
  process.stdout.write(`${style.header("  ERRORS")}  ${style.err(String(errors.length))}\n`);
  process.stdout.write(`${line()}\n\n`);

  for (const e of errors) {
    process.stdout.write(`  seq ${style.accent(String(e.seq))}  ${eventIcon(e.type)} ${c.bold}${e.action}${c.reset}\n`);
    process.stdout.write(`  ${style.err("↳ " + e.error!.message)}\n`);
    if (e.error!.code) process.stdout.write(`  ${style.muted("code: " + e.error!.code)}\n`);
    process.stdout.write("\n");
  }
}

function printStateChanges(events: AgentEvent[]): void {
  const changed = events.filter(e => e.state_before !== e.state_after);
  if (changed.length === 0) return;

  process.stdout.write(`${line()}\n`);
  process.stdout.write(`${style.header("  STATE CHANGES")}  ${style.muted(`${changed.length} transitions`)}\n`);
  process.stdout.write(`${line()}\n\n`);

  for (const e of changed) {
    process.stdout.write(`  seq ${style.accent(String(e.seq).padStart(4, "0"))}  ${eventIcon(e.type)} ${c.bold}${e.action}${c.reset}\n`);
    process.stdout.write(`  ${style.muted("  before")}  ${style.muted(e.state_before.slice(0, 32) + "…")}\n`);
    process.stdout.write(`  ${style.muted("  after ")}  ${style.muted(e.state_after.slice(0, 32) + "…")}\n\n`);
  }
}

export function cmdInspect(filePath: string, opts: { timeline?: boolean; critical?: boolean; errors?: boolean; state?: boolean; all?: boolean }): void {
  printLogo();
  const artifact = loadArtifact(filePath);

  printRunHeader(artifact);

  const showAll = opts.all || (!opts.timeline && !opts.critical && !opts.errors && !opts.state);

  if (showAll || opts.timeline)  printTimeline(artifact.events);
  if (showAll || opts.critical)  printCriticalPath(artifact.events);
  if (showAll || opts.errors)    printErrors(artifact.events);
  if (showAll || opts.state)     printStateChanges(artifact.events);
}

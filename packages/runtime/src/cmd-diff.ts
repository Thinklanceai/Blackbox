import { readFileSync } from "fs";
import { BlackboxArtifact, diff, AgentEvent } from "./runtime.js";
import { style, line, eventIcon, formatDuration, c, printLogo, eventColor } from "./render.js";

function loadArtifact(path: string): BlackboxArtifact {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as BlackboxArtifact;
  } catch {
    console.error(style.err(`✗ Cannot read: ${path}`));
    process.exit(1);
  }
}

function printEventRow(event: AgentEvent, prefix: string, color: string): void {
  const icon   = eventIcon(event.type);
  const seqStr = String(event.seq).padStart(4, " ");
  const type   = `${eventColor(event.type)}${event.type.padEnd(14)}${c.reset}`;
  const action = `${c.bold}${event.action}${c.reset}`;
  const dur    = formatDuration(event.duration_ms);

  process.stdout.write(`  ${color}${prefix}${c.reset} ${style.muted(seqStr)}  ${icon} ${type}  ${action}  ${dur}\n`);
}

function printFieldDiff(event_a: AgentEvent, event_b: AgentEvent, fields: string[]): void {
  for (const field of fields) {
    const va = JSON.stringify((event_a as Record<string, unknown>)[field]);
    const vb = JSON.stringify((event_b as Record<string, unknown>)[field]);
    process.stdout.write(`       ${style.muted(field.padEnd(14))}\n`);
    process.stdout.write(`       ${c.red}−  ${va?.slice(0, 80) ?? "∅"}${c.reset}\n`);
    process.stdout.write(`       ${c.green}+  ${vb?.slice(0, 80) ?? "∅"}${c.reset}\n`);
  }
}

export function cmdDiff(pathA: string, pathB: string, opts: { fields?: boolean }): void {
  printLogo();

  const a = loadArtifact(pathA);
  const b = loadArtifact(pathB);
  const result = diff(a, b);

  process.stdout.write(`${line()}\n`);
  process.stdout.write(`${style.header("  RUN DIFF")}\n`);
  process.stdout.write(`${line()}\n\n`);

  process.stdout.write(`  ${c.red}−${c.reset}  ${style.muted("run_a")}  ${style.accent(a.run_id)}  ${style.muted(a.agent_id)}\n`);
  process.stdout.write(`  ${c.green}+${c.reset}  ${style.muted("run_b")}  ${style.accent(b.run_id)}  ${style.muted(b.agent_id)}\n\n`);

  if (result.identical) {
    process.stdout.write(`  ${style.ok("✓ runs are identical")}  ${a.event_count} events, same hashes\n\n`);
    return;
  }

  // Divergence point
  if (result.diverges_at !== undefined) {
    process.stdout.write(`  ${style.warn(`⚡ diverges at seq ${result.diverges_at}`)}\n\n`);
  }

  process.stdout.write(`${line()}\n`);
  process.stdout.write(`${style.header("  CHANGES")}\n`);
  process.stdout.write(`${line()}\n\n`);

  // Modified events
  if (result.modified.length > 0) {
    process.stdout.write(`  ${style.warn(`~ ${result.modified.length} modified`)}\n\n`);
    for (const mod of result.modified) {
      const ea = a.events[mod.seq];
      const eb = b.events[mod.seq];
      printEventRow(ea, "−", c.red);
      printEventRow(eb, "+", c.green);
      if (opts.fields && ea && eb) {
        printFieldDiff(ea, eb, mod.fields);
      } else {
        process.stdout.write(`  ${style.muted("  changed: " + mod.fields.join(", "))}\n`);
      }
      process.stdout.write("\n");
    }
  }

  // Removed events
  if (result.removed.length > 0) {
    process.stdout.write(`  ${style.err(`- ${result.removed.length} removed`)}\n\n`);
    for (const e of result.removed) {
      printEventRow(e, "−", c.red);
    }
    process.stdout.write("\n");
  }

  // Added events
  if (result.added.length > 0) {
    process.stdout.write(`  ${style.ok(`+ ${result.added.length} added`)}\n\n`);
    for (const e of result.added) {
      printEventRow(e, "+", c.green);
    }
    process.stdout.write("\n");
  }

  // Summary
  process.stdout.write(`${line()}\n\n`);
  process.stdout.write(`  ${style.muted("modified")}  ${style.warn(String(result.modified.length))}\n`);
  process.stdout.write(`  ${style.muted("removed ")}  ${style.err(String(result.removed.length))}\n`);
  process.stdout.write(`  ${style.muted("added   ")}  ${style.ok(String(result.added.length))}\n\n`);
}

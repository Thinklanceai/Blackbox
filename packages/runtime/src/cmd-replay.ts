import { readFileSync } from "fs";
import { readline } from "readline";
import { BlackboxArtifact, AgentEvent, verify, replay } from "./runtime.js";
import { style, line, eventIcon, formatDuration, formatTimestamp, c, printLogo, eventColor, truncate } from "./render.js";

function loadArtifact(path: string): BlackboxArtifact {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as BlackboxArtifact;
  } catch {
    console.error(style.err(`✗ Cannot read: ${path}`));
    process.exit(1);
  }
}

function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

function printEventFull(event: AgentEvent, total: number): void {
  const color  = eventColor(event.type);
  const icon   = eventIcon(event.type);
  const progress = `${event.seq + 1}/${total}`;

  process.stdout.write(`${line()}\n`);
  process.stdout.write(`  ${icon} ${color}${c.bold}${event.type}${c.reset}  ${c.bold}${event.action}${c.reset}  ${style.muted(progress)}  ${formatDuration(event.duration_ms)}\n`);
  process.stdout.write(`${line()}\n\n`);

  // Header fields
  const fields: [string, string][] = [
    ["seq",        style.accent(String(event.seq))],
    ["id",         style.muted(event.id)],
    ["run_id",     style.muted(event.run_id)],
    ["timestamp",  formatTimestamp(event.timestamp)],
    ["agent",      style.accent(event.agent_id)],
  ];
  if (event.tags.length > 0) fields.push(["tags", style.muted(event.tags.join(", "))]);

  for (const [k, v] of fields) {
    process.stdout.write(`  ${style.muted(k.padEnd(12))}  ${v}\n`);
  }

  // Input / Output
  process.stdout.write(`\n  ${style.label("INPUT")}\n`);
  if (event.input !== null && event.input !== undefined && JSON.stringify(event.input) !== "{}") {
    const lines = JSON.stringify(event.input, null, 2).split("\n");
    for (const l of lines.slice(0, 20)) {
      process.stdout.write(`  ${style.muted(l)}\n`);
    }
    if (lines.length > 20) process.stdout.write(`  ${style.muted(`  … (${lines.length - 20} more lines)`)}\n`);
  } else {
    process.stdout.write(`  ${style.muted("∅")}\n`);
  }

  process.stdout.write(`\n  ${style.label("OUTPUT")}\n`);
  if (event.output !== null && event.output !== undefined && JSON.stringify(event.output) !== "{}") {
    const lines = JSON.stringify(event.output, null, 2).split("\n");
    for (const l of lines.slice(0, 20)) {
      process.stdout.write(`  ${style.muted(l)}\n`);
    }
    if (lines.length > 20) process.stdout.write(`  ${style.muted(`  … (${lines.length - 20} more lines)`)}\n`);
  } else {
    process.stdout.write(`  ${style.muted("∅")}\n`);
  }

  // State
  process.stdout.write(`\n  ${style.label("STATE")}\n`);
  process.stdout.write(`  ${style.muted("before")}  ${style.muted(event.state_before.slice(0, 32) + "…")}\n`);
  process.stdout.write(`  ${style.muted("after ")}  ${style.muted(event.state_after.slice(0, 32) + "…")}\n`);
  const stateChanged = event.state_before !== event.state_after;
  process.stdout.write(`  ${style.muted("changed")} ${stateChanged ? style.warn("yes") : style.muted("no")}\n`);

  // Hash chain
  process.stdout.write(`\n  ${style.label("CHAIN")}\n`);
  process.stdout.write(`  ${style.muted("prev_hash")}  ${style.muted(event.prev_hash.slice(0, 32) + (event.prev_hash === "genesis" ? "" : "…"))}\n`);
  process.stdout.write(`  ${style.muted("hash     ")}  ${style.muted(event.hash.slice(0, 32) + "…")}\n`);

  // Error
  if (event.error) {
    process.stdout.write(`\n  ${style.err("ERROR")}\n`);
    process.stdout.write(`  ${style.err(event.error.message)}\n`);
    if (event.error.code) process.stdout.write(`  ${style.muted("code: " + event.error.code)}\n`);
    if (event.error.stack) {
      const stackLines = event.error.stack.split("\n").slice(1, 4);
      for (const l of stackLines) process.stdout.write(`  ${style.muted(l.trim())}\n`);
    }
  }
  process.stdout.write("\n");
}

function printTimeline(events: AgentEvent[], currentSeq: number): void {
  process.stdout.write(`${line()}\n  `);
  for (const e of events) {
    const icon = eventIcon(e.type);
    if (e.seq === currentSeq) {
      process.stdout.write(`${c.bold}[${icon}]${c.reset}`);
    } else if (e.seq < currentSeq) {
      process.stdout.write(`${c.gray}${icon}${c.reset}`);
    } else {
      process.stdout.write(`${c.gray}·${c.reset}`);
    }
    process.stdout.write(" ");
  }
  process.stdout.write(`\n${line()}\n`);
}

function printControls(seq: number, total: number): void {
  const controls = [
    seq > 0           ? style.muted("[←] prev") : style.muted("    prev"),
    seq < total - 1   ? style.muted("[→] next") : style.muted("    next"),
    style.muted("[q] quit"),
    style.muted("[v] verify"),
  ].join("   ");
  process.stdout.write(`\n  ${controls}\n\n`);
}

export async function cmdReplay(filePath: string, opts: { from?: string; auto?: boolean; speed?: string }): Promise<void> {
  const artifact = loadArtifact(filePath);
  const events = artifact.events;
  const total = events.length;
  let seq = opts.from ? parseInt(opts.from) : 0;

  if (opts.auto) {
    // Auto-play mode — stream events with delay
    const speed = parseInt(opts.speed ?? "300");
    clearScreen();
    printLogo();

    process.stdout.write(`  ${style.muted("auto-replay")}  ${style.accent(filePath)}  ${style.muted(`${speed}ms/event`)}\n\n`);

    for (const frame of replay(artifact)) {
      await new Promise(r => setTimeout(r, speed));

      const icon    = eventIcon(frame.event.type);
      const color   = eventColor(frame.event.type);
      const seqStr  = String(frame.event.seq).padStart(4, "0");
      const typeStr = `${color}${frame.event.type.padEnd(14)}${c.reset}`;
      const hash    = style.muted(frame.event.hash.slice(0, 12) + "…");
      const chain   = frame.chain_valid ? style.muted("⛓") : style.err("⛓✗");
      const valid   = frame.state_hash_valid ? style.muted("◈") : style.err("◈✗");
      const dur     = formatDuration(frame.event.duration_ms);

      process.stdout.write(`  ${style.muted(seqStr)}  ${icon} ${typeStr}  ${c.bold}${frame.event.action}${c.reset}  ${dur}  ${hash}  ${chain}${valid}\n`);
    }

    process.stdout.write(`\n${line()}\n`);
    process.stdout.write(`  ${style.ok("✓ replay complete")}  ${total} events\n\n`);
    return;
  }

  // Interactive mode
  const { createInterface } = await import("readline");

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  const render = () => {
    clearScreen();
    printLogo();
    printTimeline(events, seq);
    printEventFull(events[seq], total);
    printControls(seq, total);
  };

  render();

  await new Promise<void>((resolve) => {
    process.stdin.on("data", (key: string) => {
      if (key === "\x1b[C" || key === "l") { if (seq < total - 1) { seq++; render(); } }
      else if (key === "\x1b[D" || key === "h") { if (seq > 0) { seq--; render(); } }
      else if (key === "v") {
        const result = verify(artifact);
        process.stdout.write(result.valid
          ? `\n  ${style.ok("✓ chain verified")}\n`
          : `\n  ${style.err(`✗ tampered at seq ${result.at_seq}`)}\n`
        );
      }
      else if (key === "q" || key === "\u0003") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve();
      }
    });
  });
}

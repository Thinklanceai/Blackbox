// Pure Node terminal renderer — zero dependencies
// ANSI color codes only

export const c = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  red:     "\x1b[31m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  blue:    "\x1b[34m",
  magenta: "\x1b[35m",
  cyan:    "\x1b[36m",
  white:   "\x1b[37m",
  gray:    "\x1b[90m",
  bgRed:   "\x1b[41m",
  bgGreen: "\x1b[42m",
} as const;

export const style = {
  header:  (s: string) => `${c.bold}${c.white}${s}${c.reset}`,
  ok:      (s: string) => `${c.bold}${c.green}${s}${c.reset}`,
  err:     (s: string) => `${c.bold}${c.red}${s}${c.reset}`,
  warn:    (s: string) => `${c.yellow}${s}${c.reset}`,
  muted:   (s: string) => `${c.gray}${s}${c.reset}`,
  accent:  (s: string) => `${c.cyan}${s}${c.reset}`,
  label:   (s: string) => `${c.bold}${c.blue}${s}${c.reset}`,
  hash:    (s: string) => `${c.magenta}${s.slice(0, 12)}…${c.reset}`,
};

export function line(char = "─", width = 72): string {
  return c.gray + char.repeat(width) + c.reset;
}

export function badge(text: string, color: keyof typeof c): string {
  return `${(c as Record<string,string>)[color]}[${text}]${c.reset}`;
}

// Event type → color + icon
const EVENT_STYLE: Record<string, { icon: string; color: string }> = {
  run_start:     { icon: "▶", color: c.green },
  run_end:       { icon: "■", color: c.green },
  tool_call:     { icon: "⚙", color: c.cyan },
  tool_result:   { icon: "↩", color: c.cyan },
  llm_call:      { icon: "◈", color: c.magenta },
  llm_result:    { icon: "◉", color: c.magenta },
  decision:      { icon: "◆", color: c.yellow },
  file_read:     { icon: "○", color: c.blue },
  file_write:    { icon: "●", color: c.blue },
  exec:          { icon: "▸", color: c.red },
  http_request:  { icon: "↗", color: c.cyan },
  http_response: { icon: "↙", color: c.cyan },
  deploy:        { icon: "⬆", color: c.yellow },
  memory_read:   { icon: "◁", color: c.gray },
  memory_write:  { icon: "▷", color: c.gray },
};

export function eventIcon(type: string): string {
  const s = EVENT_STYLE[type] ?? { icon: "·", color: c.white };
  return `${s.color}${s.icon}${c.reset}`;
}

export function eventColor(type: string): string {
  return EVENT_STYLE[type]?.color ?? c.white;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined) return "";
  if (ms < 1000) return style.muted(`${ms}ms`);
  return style.muted(`${(ms / 1000).toFixed(2)}s`);
}

export function formatTimestamp(ts: string): string {
  return style.muted(new Date(ts).toISOString().replace("T", " ").replace("Z", ""));
}

export function truncate(s: string, max = 60): string {
  const str = typeof s === "string" ? s : JSON.stringify(s);
  return str.length > max ? str.slice(0, max) + "…" : str;
}

export function printLogo(): void {
  process.stdout.write(`
${c.bold}${c.white}
  ◼ blackbox${c.reset}${c.gray} — deterministic agent runtime${c.reset}
${line()}
`);
}

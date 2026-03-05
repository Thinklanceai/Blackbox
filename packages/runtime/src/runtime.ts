import { createHash, randomUUID } from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export type EventType =
  | "tool_call" | "tool_result"
  | "llm_call"  | "llm_result"
  | "decision"
  | "memory_read" | "memory_write"
  | "file_read"   | "file_write"
  | "exec"
  | "http_request" | "http_response"
  | "deploy"
  | "run_start" | "run_end";

export interface AgentEvent {
  id: string;
  run_id: string;
  seq: number;
  timestamp: string;
  type: EventType;
  action: string;
  input: unknown;
  output: unknown;
  state_before: string;
  state_after: string;
  prev_hash: string;
  hash: string;
  agent_id: string;
  tags: string[];
  duration_ms?: number;
  error?: {
    message: string;
    code?: string;
    recoverable: boolean;
    stack?: string;
  };
}

export interface BlackboxArtifact {
  version: "0.1";
  run_id: string;
  agent_id: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  event_count: number;
  root_hash: string;
  stats: RunStats;
  events: AgentEvent[];
}

export interface RunStats {
  total_events: number;
  errors: number;
  by_type: Partial<Record<EventType, number>>;
  llm_calls: number;
  tool_calls: number;
  deploys: number;
  execs: number;
}

export interface BlackboxOptions {
  agent_id: string;
  tags?: string[];
  onEvent?: (event: AgentEvent) => void;
}

// ─── Crypto ───────────────────────────────────────────────────────────────────

export function canonicalJSON(obj: unknown): string {
  const sorted = sortKeysDeep(obj);
  return JSON.stringify(sorted);
}

function sortKeysDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj !== null && typeof obj === "object") {
    return Object.keys(obj as Record<string, unknown>)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
        return acc;
      }, {} as Record<string, unknown>);
  }
  return obj;
}

export function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hashState(state: unknown): string {
  return sha256(canonicalJSON({ state }));
}

export function hashEvent(event: Omit<AgentEvent, "hash">): string {
  const obj: Record<string, unknown> = {
    id: event.id,
    run_id: event.run_id,
    seq: event.seq,
    timestamp: event.timestamp,
    type: event.type,
    action: event.action,
    input: event.input,
    output: event.output,
    state_before: event.state_before,
    state_after: event.state_after,
    prev_hash: event.prev_hash,
    agent_id: event.agent_id,
    tags: event.tags,
  };
  if (event.duration_ms !== undefined) obj.duration_ms = event.duration_ms;
  if (event.error) obj.error = event.error;
  return sha256(canonicalJSON(obj));
}

// ─── Verifier ─────────────────────────────────────────────────────────────────

export type VerifyResult =
  | { valid: true; events_checked: number }
  | { valid: false; reason: string; at_seq: number; expected?: string; got?: string };

export function verify(artifact: BlackboxArtifact): VerifyResult {
  const { events } = artifact;

  if (!events || events.length === 0) {
    return { valid: false, reason: "artifact contains no events", at_seq: -1 };
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    if (event.seq !== i) {
      return { valid: false, reason: `seq discontinuity`, at_seq: i, expected: String(i), got: String(event.seq) };
    }

    const expectedPrev = i === 0 ? "genesis" : events[i - 1].hash;
    if (event.prev_hash !== expectedPrev) {
      return { valid: false, reason: `prev_hash mismatch — chain broken`, at_seq: i, expected: expectedPrev, got: event.prev_hash };
    }

    const { hash, ...rest } = event;
    const recomputed = hashEvent(rest);
    if (recomputed !== hash) {
      return { valid: false, reason: `hash mismatch — event was tampered`, at_seq: i, expected: recomputed, got: hash };
    }
  }

  const lastEvent = events[events.length - 1];
  if (lastEvent.hash !== artifact.root_hash) {
    return { valid: false, reason: `root_hash mismatch — artifact header was tampered`, at_seq: events.length - 1 };
  }

  return { valid: true, events_checked: events.length };
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

export interface RunDiff {
  run_a: string;
  run_b: string;
  identical: boolean;
  diverges_at?: number;
  added: AgentEvent[];
  removed: AgentEvent[];
  modified: Array<{ seq: number; fields: string[] }>;
}

export function diff(a: BlackboxArtifact, b: BlackboxArtifact): RunDiff {
  const result: RunDiff = {
    run_a: a.run_id,
    run_b: b.run_id,
    identical: false,
    added: [],
    removed: [],
    modified: [],
  };

  const len = Math.max(a.events.length, b.events.length);

  for (let i = 0; i < len; i++) {
    const ea = a.events[i];
    const eb = b.events[i];

    if (!ea) { result.added.push(eb); continue; }
    if (!eb) { result.removed.push(ea); continue; }

    if (ea.hash !== eb.hash) {
      if (result.diverges_at === undefined) result.diverges_at = i;
      const changedFields: string[] = [];
      for (const key of ["type","action","input","output","state_before","state_after","error"] as const) {
        if (JSON.stringify(ea[key]) !== JSON.stringify(eb[key])) changedFields.push(key);
      }
      result.modified.push({ seq: i, fields: changedFields });
    }
  }

  result.identical = result.added.length === 0 && result.removed.length === 0 && result.modified.length === 0;
  return result;
}

// ─── Replay ───────────────────────────────────────────────────────────────────

export interface ReplayFrame {
  event: AgentEvent;
  state_hash_valid: boolean;
  chain_valid: boolean;
}

export function* replay(artifact: BlackboxArtifact): Generator<ReplayFrame> {
  let prevHash = "genesis";

  for (const event of artifact.events) {
    const chain_valid = event.prev_hash === prevHash;
    const { hash, ...rest } = event;
    const recomputed = hashEvent(rest);
    const state_hash_valid = recomputed === hash;

    yield { event, state_hash_valid, chain_valid };
    prevHash = event.hash;
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export function computeStats(events: AgentEvent[]): RunStats {
  const by_type: Partial<Record<EventType, number>> = {};
  let errors = 0;

  for (const e of events) {
    by_type[e.type] = (by_type[e.type] ?? 0) + 1;
    if (e.error) errors++;
  }

  return {
    total_events: events.length,
    errors,
    by_type,
    llm_calls: by_type["llm_call"] ?? 0,
    tool_calls: by_type["tool_call"] ?? 0,
    deploys: by_type["deploy"] ?? 0,
    execs: by_type["exec"] ?? 0,
  };
}

// ─── Runtime ──────────────────────────────────────────────────────────────────

export class Blackbox {
  private run_id: string;
  private agent_id: string;
  private tags: string[];
  private events: AgentEvent[] = [];
  private seq = 0;
  private state: Record<string, unknown> = {};
  private onEvent?: (event: AgentEvent) => void;
  private started_at: string;
  private started_ms: number;

  constructor(options: BlackboxOptions) {
    this.run_id    = randomUUID();
    this.agent_id  = options.agent_id;
    this.tags      = options.tags ?? [];
    this.onEvent   = options.onEvent;
    this.started_at = new Date().toISOString();
    this.started_ms = Date.now();
    this._emit("run_start", "run_start", {}, {});
  }

  // ── Core API ─────────────────────────────────────────────────────────────────

  async record<T>(type: EventType, action: string, input: unknown, fn: () => Promise<T>): Promise<T> {
    const state_before = hashState(this.state);
    const t0 = Date.now();
    let output: unknown = null;
    let error: AgentEvent["error"] | undefined;

    try {
      const result = await fn();
      output = result ?? null;
      this.state = { ...this.state, last_action: action, last_seq: this.seq };
      const state_after = hashState(this.state);
      this._emit(type, action, input, output, state_before, state_after, undefined, Date.now() - t0);
      return result;
    } catch (err) {
      const e = err as Error;
      error = { message: e.message, code: (e as NodeJS.ErrnoException).code, recoverable: false, stack: e.stack };
      this.state = { ...this.state, last_error: e.message, last_seq: this.seq };
      const state_after = hashState(this.state);
      this._emit(type, action, input, null, state_before, state_after, error, Date.now() - t0);
      throw err;
    }
  }

  setState(patch: Record<string, unknown>): void {
    this.state = { ...this.state, ...patch };
  }

  getRunId(): string { return this.run_id; }
  getEventCount(): number { return this.events.length; }

  end(): BlackboxArtifact {
    const duration_ms = Date.now() - this.started_ms;
    this._emit("run_end", "run_end", {}, { event_count: this.seq, duration_ms });

    const ended_at = new Date().toISOString();
    const lastEvent = this.events[this.events.length - 1];
    const stats = computeStats(this.events);

    return {
      version: "0.1",
      run_id: this.run_id,
      agent_id: this.agent_id,
      started_at: this.started_at,
      ended_at,
      duration_ms,
      event_count: this.events.length,
      root_hash: lastEvent.hash,
      stats,
      events: this.events,
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _emit(
    type: EventType, action: string,
    input: unknown, output: unknown,
    state_before?: string, state_after?: string,
    error?: AgentEvent["error"], duration_ms?: number
  ): void {
    const sb = state_before ?? hashState(this.state);
    const sa = state_after  ?? hashState(this.state);
    const prev_hash = this.seq === 0 ? "genesis" : this.events[this.seq - 1].hash;

    const partial: Omit<AgentEvent, "hash"> = {
      id: randomUUID(), run_id: this.run_id, seq: this.seq,
      timestamp: new Date().toISOString(),
      type, action, input, output,
      state_before: sb, state_after: sa,
      prev_hash, agent_id: this.agent_id, tags: this.tags,
      ...(duration_ms !== undefined ? { duration_ms } : {}),
      ...(error ? { error } : {}),
    };

    const event: AgentEvent = { ...partial, hash: hashEvent(partial) };
    this.events.push(event);
    this.seq++;
    this.onEvent?.(event);
  }
}

// ─── One-liner ────────────────────────────────────────────────────────────────

export function blackbox(options: BlackboxOptions) {
  const bb = new Blackbox(options);
  return { bb, record: bb.record.bind(bb) };
}

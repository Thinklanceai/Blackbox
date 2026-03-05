import { createHash, randomUUID } from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export type EventType =
  | "tool_call"
  | "tool_result"
  | "llm_call"
  | "llm_result"
  | "decision"
  | "memory_read"
  | "memory_write"
  | "file_read"
  | "file_write"
  | "exec"
  | "http_request"
  | "http_response"
  | "deploy"
  | "run_start"
  | "run_end";

export type AgentEvent = {
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
  error?: {
    message: string;
    code?: string;
    recoverable: boolean;
  };
};

export type BlackboxArtifact = {
  version: "0.1";
  run_id: string;
  agent_id: string;
  started_at: string;
  ended_at: string;
  event_count: number;
  root_hash: string;
  events: AgentEvent[];
};

export type BlackboxOptions = {
  agent_id: string;
  tags?: string[];
  onEvent?: (event: AgentEvent) => void;
};

export type ActionFn<T> = () => Promise<T>;

// ─── Hashing ─────────────────────────────────────────────────────────────────

function canonicalHash(obj: Record<string, unknown>): string {
  const sorted = sortKeysDeep(obj);
  const json = JSON.stringify(sorted);
  return createHash("sha256").update(json).digest("hex");
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

function hashState(state: unknown): string {
  return canonicalHash({ state });
}

function hashEvent(event: Omit<AgentEvent, "hash">): string {
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
  if (event.error) obj.error = event.error;
  return canonicalHash(obj);
}

// ─── Verifier ─────────────────────────────────────────────────────────────────

export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: string; at_seq: number };

export function verify(artifact: BlackboxArtifact): VerifyResult {
  const { events } = artifact;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    // Check seq is monotonic
    if (event.seq !== i) {
      return { valid: false, reason: `seq mismatch: expected ${i}, got ${event.seq}`, at_seq: i };
    }

    // Check prev_hash chain
    const expectedPrev = i === 0 ? "genesis" : events[i - 1].hash;
    if (event.prev_hash !== expectedPrev) {
      return { valid: false, reason: `prev_hash mismatch at seq ${i}`, at_seq: i };
    }

    // Recompute hash
    const { hash, ...rest } = event;
    const recomputed = hashEvent(rest);
    if (recomputed !== hash) {
      return { valid: false, reason: `hash mismatch at seq ${i} — event was tampered`, at_seq: i };
    }
  }

  // Check root_hash
  const lastEvent = events[events.length - 1];
  if (lastEvent?.hash !== artifact.root_hash) {
    return { valid: false, reason: "root_hash does not match last event hash", at_seq: events.length - 1 };
  }

  return { valid: true };
}

// ─── Runtime ──────────────────────────────────────────────────────────────────

export class Blackbox {
  private run_id: string;
  private agent_id: string;
  private tags: string[];
  private events: AgentEvent[] = [];
  private seq = 0;
  private state: unknown = {};
  private onEvent?: (event: AgentEvent) => void;
  private started_at: string;

  constructor(options: BlackboxOptions) {
    this.run_id = randomUUID();
    this.agent_id = options.agent_id;
    this.tags = options.tags ?? [];
    this.onEvent = options.onEvent;
    this.started_at = new Date().toISOString();
    this._emit("run_start", "run_start", {}, {});
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Wrap any async action. This is the core primitive.
   *
   * @example
   * const result = await bb.record("file_write", "write_config", input, async () => {
   *   return fs.writeFile(path, content)
   * })
   */
  async record<T>(
    type: EventType,
    action: string,
    input: unknown,
    fn: ActionFn<T>
  ): Promise<T> {
    const state_before = hashState(this.state);
    let output: unknown;
    let error: AgentEvent["error"] | undefined;
    let result: T;

    try {
      result = await fn();
      output = result ?? null;
      this.state = { ...((this.state as object) ?? {}), last_action: action };
    } catch (err) {
      const e = err as Error;
      error = { message: e.message, recoverable: false };
      output = null;
      this.state = { ...((this.state as object) ?? {}), last_error: e.message };
      const state_after = hashState(this.state);
      this._emit(type, action, input, output, state_before, state_after, error);
      throw err;
    }

    const state_after = hashState(this.state);
    this._emit(type, action, input, output, state_before, state_after);
    return result!;
  }

  /**
   * Manually set state (e.g. after an LLM response updates agent memory).
   */
  setState(patch: Record<string, unknown>): void {
    this.state = { ...((this.state as object) ?? {}), ...patch };
  }

  /**
   * End the run and return the portable .blackbox artifact.
   */
  end(): BlackboxArtifact {
    this._emit("run_end", "run_end", {}, { event_count: this.seq });
    const ended_at = new Date().toISOString();
    const lastEvent = this.events[this.events.length - 1];

    return {
      version: "0.1",
      run_id: this.run_id,
      agent_id: this.agent_id,
      started_at: this.started_at,
      ended_at,
      event_count: this.events.length,
      root_hash: lastEvent.hash,
      events: this.events,
    };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _emit(
    type: EventType,
    action: string,
    input: unknown,
    output: unknown,
    state_before?: string,
    state_after?: string,
    error?: AgentEvent["error"]
  ): void {
    const sb = state_before ?? hashState(this.state);
    const sa = state_after ?? hashState(this.state);
    const prev_hash = this.seq === 0 ? "genesis" : this.events[this.seq - 1].hash;

    const partial: Omit<AgentEvent, "hash"> = {
      id: randomUUID(),
      run_id: this.run_id,
      seq: this.seq,
      timestamp: new Date().toISOString(),
      type,
      action,
      input,
      output,
      state_before: sb,
      state_after: sa,
      prev_hash,
      agent_id: this.agent_id,
      tags: this.tags,
      ...(error ? { error } : {}),
    };

    const event: AgentEvent = { ...partial, hash: hashEvent(partial) };
    this.events.push(event);
    this.seq++;
    this.onEvent?.(event);
  }
}

// ─── One-liner wrapper ────────────────────────────────────────────────────────

/**
 * The simplest possible API.
 *
 * @example
 * const { bb, record } = blackbox({ agent_id: "my-agent@1.0.0" })
 * await record("file_write", "write_config", { path }, () => fs.writeFile(path, data))
 * const artifact = bb.end()
 */
export function blackbox(options: BlackboxOptions): {
  bb: Blackbox;
  record: Blackbox["record"];
} {
  const bb = new Blackbox(options);
  return { bb, record: bb.record.bind(bb) };
}

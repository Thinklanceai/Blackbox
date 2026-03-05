# Agent Blackbox — Event Format Spec v0.1

## Philosophy

Every agent action produces a structured, hashed, chained event.
No action without a trace. No trace without a hash. No hash without a chain.

The format is intentionally minimal.
It describes *what happened*, not *how to fix it*.

---

## Event Structure

```typescript
type AgentEvent = {
  // Identity
  id: string            // UUID v4 — unique per event
  run_id: string        // UUID v4 — groups all events from one agent run
  seq: number           // Monotonic sequence number within run (0, 1, 2...)

  // Timing
  timestamp: string     // ISO 8601 UTC — "2024-01-15T10:23:45.123Z"

  // What happened
  type: EventType       // See EventType enum below
  action: string        // Human-readable label — "read_file", "exec_sql", "call_api"

  // Input / Output
  input: unknown        // Serializable. What the agent received before acting.
  output: unknown       // Serializable. What the agent produced after acting.

  // State snapshot
  state_before: string  // SHA-256 of serialized agent state before action
  state_after: string   // SHA-256 of serialized agent state after action

  // Chain integrity
  prev_hash: string     // SHA-256 of previous event. "genesis" if seq === 0.
  hash: string          // SHA-256 of this event (all fields except hash itself)

  // Context
  agent_id: string      // Identifier of the agent (name, version, model)
  tags: string[]        // Optional. ["production", "database", "critical"]

  // Error (optional)
  error?: {
    message: string
    code?: string
    recoverable: boolean
  }
}
```

---

## EventType Enum

```typescript
type EventType =
  | "tool_call"       // Agent calls an external tool or function
  | "tool_result"     // Result received from tool
  | "llm_call"        // Agent calls an LLM (prompt sent)
  | "llm_result"      // LLM response received
  | "decision"        // Agent makes a branching decision
  | "memory_read"     // Agent reads from memory/context
  | "memory_write"    // Agent writes to memory/context
  | "file_read"       // Agent reads a file
  | "file_write"      // Agent writes or modifies a file
  | "exec"            // Agent executes a command or script
  | "http_request"    // Agent makes an HTTP request
  | "http_response"   // HTTP response received
  | "deploy"          // Agent triggers a deployment
  | "run_start"       // First event of a run
  | "run_end"         // Last event of a run — includes summary
```

---

## Hashing Rule

The `hash` field is computed as:

```
hash = SHA-256(
  JSON.stringify({
    id, run_id, seq, timestamp,
    type, action,
    input, output,
    state_before, state_after,
    prev_hash,
    agent_id, tags,
    error  // omitted if undefined
  })
)
```

**Canonical JSON:** keys sorted alphabetically, no extra whitespace.
This guarantees determinism across languages and platforms.

---

## Chain Integrity

Each event references the hash of the previous event via `prev_hash`.

```
run_start  (seq=0, prev_hash="genesis")
    │
    ▼ hash_0
tool_call  (seq=1, prev_hash=hash_0)
    │
    ▼ hash_1
tool_result (seq=2, prev_hash=hash_1)
    │
    ▼ hash_2
run_end    (seq=3, prev_hash=hash_2)
```

To verify a run: recompute every hash from seq=0 and check the chain.
Any tampering breaks the chain at the corrupted event.

---

## Run Artifact

A complete run produces a single `.blackbox` file:

```json
{
  "version": "0.1",
  "run_id": "f47ac10b-...",
  "agent_id": "my-agent@1.0.0",
  "started_at": "2024-01-15T10:23:45.000Z",
  "ended_at": "2024-01-15T10:24:12.847Z",
  "event_count": 12,
  "root_hash": "sha256:9f86d08...",
  "events": [ ...ordered array of AgentEvent... ]
}
```

The `root_hash` is the hash of the final `run_end` event.
Share this single file to prove what an agent did — or didn't do.

---

## Replay Contract

A `.blackbox` file is replayable if:

1. Every `hash` is verifiable by recomputing from the event fields.
2. Every `prev_hash` matches the `hash` of the preceding event.
3. `seq` is strictly monotonic from 0.
4. `run_id` is consistent across all events.

A verifier only needs this spec and a SHA-256 implementation.
No dependency on the original runtime.

---

## Design Decisions

**Why SHA-256 chaining and not a Merkle tree?**
Linear chains are simpler to verify, explain, and audit.
An agent run is sequential by nature — a chain is the right structure.

**Why is `input`/`output` typed as `unknown`?**
The spec doesn't constrain what agents do. It constrains *how they report it*.
Any serializable value is valid.

**Why a `.blackbox` file and not a database?**
Portability. An auditor, a regulator, or a teammate should be able to verify
a run with zero infrastructure. One file, one command.

**Why no PII scrubbing in the spec?**
Out of scope for v0.1. Implementations should handle this at the wrapper layer.
The spec defines the contract, not the sanitization policy.

---

## What This Is Not

- Not a logging framework (no log levels, no sinks)
- Not an orchestrator (no scheduling, no retries)
- Not a monitoring system (no dashboards, no alerts)
- Not a compliance product (no regulation references)

It is one thing: **a deterministic, verifiable record of what an agent did.**

---

*v0.1 — open for comments and PRs*

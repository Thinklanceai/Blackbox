# ◼ blackbox

**The flight recorder for autonomous agents.**

---

```typescript
import { blackbox } from "@blackbox/runtime"

const { bb, record } = blackbox({ agent_id: "deploy-agent@1.0.0" })

await record("file_write", "update_config", input, () => fs.writeFile(...))
await record("exec",       "run_migrations", input, () => db.migrate())
await record("deploy",     "release_v2",     input, () => k8s.rollout())

const artifact = bb.end()
// → one portable file. every action. cryptographically chained. replayable.
```

---

## The problem

We gave agents production access.

We gave them tools to read files, write databases, trigger deployments, call APIs.

We forgot to give them a flight recorder.

When an autonomous agent modifies a critical pipeline at 3am and something breaks — who is responsible? What did it do, exactly, and in what order? Can you prove the logs weren't altered after the fact?

Right now: **no**.

Every framework logs differently. Nothing is interoperable. Nothing is cryptographically verifiable. Nothing is replayable.

---

## What blackbox is

A minimal runtime layer that sits between your agent and the world.

One constraint: **an agent cannot act without producing a verifiable trace.**

Every action becomes a structured event — hashed, chained to the previous event, and bundled into a single portable `.blackbox` artifact at the end of each run.

```
run_start  (seq=0, prev="genesis")       hash: 9f86d...
    ↓
file_read  (seq=1, prev=9f86d...)        hash: 3ac67...
    ↓
llm_call   (seq=2, prev=3ac67...)        hash: b14a8...
    ↓
deploy     (seq=3, prev=b14a8...)        hash: 7f3c2...
    ↓
run_end    (seq=4, prev=7f3c2...)        hash: 1d9e4...  ← root_hash
```

Tamper any event. The chain breaks. You know exactly where.

---

## What blackbox is not

- Not a logging framework
- Not an orchestrator
- Not a monitoring system
- Not a compliance product

It is one thing: **a deterministic, verifiable record of what an agent did.**

---

## Install

```bash
npm install @blackbox/runtime
```

No config. No infrastructure. No dependencies beyond Node's native crypto.

---

## API

### `blackbox(options)` — one-liner init

```typescript
const { bb, record } = blackbox({
  agent_id: "my-agent@1.0.0",   // required
  tags: ["production"],          // optional
  onEvent: (e) => console.log(e) // optional — stream events live
})
```

### `record(type, action, input, fn)` — wrap any action

```typescript
const result = await record(
  "file_write",          // EventType
  "update_config",       // human-readable label
  { path, content },     // input — what the agent received
  () => fs.writeFile(path, content)  // the actual action
)
```

If the action throws — the error is recorded, the chain continues, the exception propagates normally.

### `bb.end()` — get the artifact

```typescript
const artifact = bb.end()
// BlackboxArtifact — serialize to .blackbox file, send to S3, attach to incident report
```

### `verify(artifact)` — standalone verifier

```typescript
import { verify } from "@blackbox/runtime"

const result = verify(artifact)
// { valid: true }
// { valid: false, reason: "hash mismatch at seq 3 — event was tampered", at_seq: 3 }
```

The verifier has zero dependency on the runtime that produced the artifact.
Any language with SHA-256 can verify a `.blackbox` file.

---

## Event types

| type | when |
|---|---|
| `tool_call` | agent calls an external tool |
| `tool_result` | result received from tool |
| `llm_call` | prompt sent to LLM |
| `llm_result` | LLM response received |
| `decision` | agent makes a branching choice |
| `file_read` | agent reads a file |
| `file_write` | agent writes or modifies a file |
| `exec` | agent executes a command |
| `http_request` | outbound HTTP call |
| `http_response` | HTTP response received |
| `deploy` | agent triggers a deployment |
| `memory_read` | agent reads from memory |
| `memory_write` | agent writes to memory |
| `run_start` | first event of a run |
| `run_end` | last event — includes summary |

---

## The `.blackbox` artifact

One run. One file.

```json
{
  "version": "0.1",
  "run_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "agent_id": "deploy-agent@1.0.0",
  "started_at": "2024-01-15T10:23:45.000Z",
  "ended_at": "2024-01-15T10:24:12.847Z",
  "event_count": 12,
  "root_hash": "sha256:1d9e4...",
  "events": [ ... ]
}
```

Share this file to prove what an agent did — or didn't do.
Attach it to your incident report. Send it to your auditor. Store it in S3.

---

## Integrity model

Each event is hashed over all its fields using SHA-256 with canonical JSON (keys sorted alphabetically, no extra whitespace — deterministic across languages and platforms).

Each event includes the hash of the previous event. This forms a chain: altering any event invalidates every subsequent hash.

```typescript
hash = SHA256(canonicalJSON({
  id, run_id, seq, timestamp,
  type, action, input, output,
  state_before, state_after,
  prev_hash, agent_id, tags
}))
```

The `root_hash` in the artifact header is the hash of the final `run_end` event.
Verify the artifact by recomputing the chain from seq=0.

---

## Event format

Built on [AAP (Agent Action Protocol)](https://github.com/your-org/aap) — the open standard for verifiable agent actions.

blackbox is the runtime that enforces AAP. AAP is the format that makes blackbox artifacts portable.

---

## Why not just use structured logging?

Logs can be appended to. Logs can be deleted. Logs have no integrity guarantee.

A `.blackbox` artifact is tamper-evident. If someone modifies event seq=3 after the fact, the hashes for seq=4 through seq=N are all invalid. You know exactly what was changed and when the chain was broken.

This is the difference between a diary and a flight recorder.

---

## Roadmap

- [x] TypeScript runtime
- [x] Chain integrity + verifier
- [ ] Python runtime (wraps AAP natively)
- [ ] CLI: `blackbox verify run.blackbox`
- [ ] CLI: `blackbox replay run.blackbox`
- [ ] LangChain integration
- [ ] AutoGen integration
- [ ] OpenAI Agents SDK integration
- [ ] VS Code extension — visualize runs

---

## Contributing

The spec lives in `SPEC.md`. The format is intentionally minimal and stable.

If you want to add a feature — ask first whether it belongs in the runtime or in a layer above it. blackbox should stay small.

---

## License

MIT

---

*We made agents powerful. We forgot to make them accountable.*

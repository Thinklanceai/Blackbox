# Launch Copy — Blackbox

---

## HACKER NEWS — Show HN

**Title:**
Show HN: Blackbox – cryptographic flight recorder for autonomous agents

**Post body:**

We're building agents that write code, run migrations, deploy to production.

We have no way to answer: what did it do, exactly, in what order, and can we
prove the logs weren't altered after the incident?

Blackbox is a minimal runtime layer that makes it impossible for an agent to
act without producing a cryptographically chained trace.

Every action = a SHA-256 hashed event.
Every event = chained to the previous one.
One run = one portable .blackbox file. Tamper any event, the chain breaks.

  import { blackbox } from "@blackbox/runtime"

  const { bb, record } = blackbox({ agent_id: "deploy-agent@1.0.0" })

  await record("file_write",  "update_config",  input, () => fs.writeFile(...))
  await record("exec",        "run_migrations", input, () => db.migrate())
  await record("deploy",      "release_v2",     input, () => k8s.rollout())

  const artifact = bb.end()
  // → one file. every action. verifiable. replayable.

Then from the CLI:

  blackbox verify  run.blackbox   # exits 0 or 1 — CI-friendly
  blackbox replay  run.blackbox   # interactive step-through, ←→ keys
  blackbox inspect run.blackbox   # full timeline, critical path, state changes
  blackbox diff    a.blackbox b.blackbox  # compare two runs exactly

Zero dependencies. Pure Node crypto. Framework-agnostic.
Ships with integrations for LangChain, OpenAI Agents SDK, Vercel AI, AutoGen.

Built on top of AAP (Agent Action Protocol) — an open standard for verifiable
agent actions.

GitHub: github.com/[your-org]/blackbox
npm:    @blackbox/runtime

---

**Comment to post yourself (first reply, adds credibility):**

A few design decisions that might spark discussion:

1. SHA-256 chain vs Merkle tree — we chose linear chain deliberately.
   Agent runs are sequential by nature. A linear chain is simpler to
   explain to an auditor than a tree. Verifying it requires only a
   SHA-256 implementation and this spec.

2. One file per run — not a database, not a log sink. A .blackbox file
   is self-contained. Share it with a teammate, attach it to an incident
   report, send it to a regulator. No infrastructure dependency.

3. No PII scrubbing in the core — intentional. The spec defines the
   contract, not the sanitization policy. Implementations handle this
   at the wrapper layer.

4. The verifier is standalone — it has zero dependency on the runtime
   that produced the artifact. Any language with SHA-256 can verify
   a .blackbox file. We want this to be auditable by people who don't
   use Node.

Happy to discuss the threat model, the chain integrity guarantees,
or the AAP format underneath.

---

## X / TWITTER — Thread

**Tweet 1 (hook):**
We gave agents production access.

We forgot to give them a flight recorder.

Introducing Blackbox 🧵

**Tweet 2 (problem):**
Your agent just ran at 3am.
It touched 6 files, ran 2 migrations, deployed to prod.

Something broke.

Questions:
→ What did it do, exactly?
→ In what order?
→ Can you prove the logs weren't altered?

Right now: silence.

**Tweet 3 (solution):**
Blackbox = one import.

```ts
const { bb, record } = blackbox({ agent_id: "deploy-agent@1.0.0" })

await record("deploy", "release_v2", input, () => k8s.rollout())

const artifact = bb.end()
```

Every action → SHA-256 hashed event, chained to the previous one.
Tamper any event → chain breaks. You know exactly where.

**Tweet 4 (CLI demo — attach GIF here):**
The CLI is the demo.

```
blackbox verify  run.blackbox   ✓ verified — 12 events
blackbox replay  run.blackbox   # ←→ step through every action
blackbox inspect run.blackbox   # timeline, critical path, errors
blackbox diff    a.blackbox b.blackbox  # exact divergence
```

One command. Zero infra. Fully offline.

**Tweet 5 (integrations):**
Ships with drop-in integrations:

→ LangChain     callbacks: [new BlackboxCallbackHandler(bb)]
→ OpenAI Agents traceOpenAIAgent({ agent_id }, () => Runner.run(...))
→ Vercel AI     traceGenerateText(bb, params, fn)
→ AutoGen       Python hook + TypeScript bridge
→ Express/Hono  blackboxMiddleware({ onArtifact: s3.upload })

One import per framework. Nothing changes in your agent code.

**Tweet 6 (why this matters):**
The real unlock isn't debugging.

It's enterprise adoption.

A startup that sells to banks needs to answer:
"Can you show us exactly what your agent did in our environment?"

With Blackbox: yes.
Without it: "trust us."

**Tweet 7 (AAP connection):**
Built on top of AAP — Agent Action Protocol.

AAP defines what a verifiable agent action looks like.
Blackbox is the runtime that enforces it.

Both open source. Both MIT.

If you're building agent infrastructure, AAP is worth a look.

**Tweet 8 (CTA):**
Zero dependencies. Pure Node crypto.
Works with any agent framework.

github.com/[your-org]/blackbox
npm install @blackbox/runtime

We made agents powerful.
We forgot to make them accountable.

---

## REDDIT — r/MachineLearning + r/LocalLLaMA

**Title:**
Blackbox: cryptographic audit trail for autonomous AI agents (open source)

**Body:**
As agents get production access, there's a gap nobody talks about:
when something goes wrong, you can't prove what the agent actually did.

Every framework has its own logging. Nothing is interoperable.
Nothing is cryptographically verifiable. Nothing is replayable.

Blackbox solves this with a minimal runtime layer:
- Every agent action = SHA-256 hashed event
- Events chained (like a blockchain, but linear and local)
- One run = one portable .blackbox file
- Tamper detection: alter any event, the chain breaks at that exact seq

CLI ships with: verify, replay (interactive), inspect, diff between runs.

Built on AAP (Agent Action Protocol) — an open spec for verifiable agent actions.

MIT. Zero dependencies. Works with LangChain, OpenAI Agents, Vercel AI, AutoGen.

[GitHub link]

Happy to answer questions about the threat model or the chain integrity design.

---

## TIMING

Post order:
1. HN Show HN — Tuesday or Wednesday, 9am EST (peak traffic)
2. X thread — same day, 30 min after HN post goes live
3. Reddit — same day, afternoon

Don't post all at once. Let HN breathe first.
If HN gets traction (top 10 Show HN), the rest follows naturally.

## THE ONE THING

Every post ends with the same line:

  "We made agents powerful. We forgot to make them accountable."

That's the phrase that gets screenshot and reshared.
Make sure it's always the last thing someone reads.

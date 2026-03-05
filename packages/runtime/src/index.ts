/**
 * @blackbox — integration examples
 *
 * Copy-paste ready. No boilerplate.
 */

// ─── 1. RAW (no framework) ────────────────────────────────────────────────────
/*
import { blackbox } from "@blackbox/runtime"

const { bb, record } = blackbox({ agent_id: "my-agent@1.0.0" })

const result = await record("file_read", "read_config", { path: ".env" }, async () => {
  return fs.readFile(".env", "utf-8")
})

const artifact = bb.end()
fs.writeFileSync("run.blackbox", JSON.stringify(artifact))
*/

// ─── 2. LANGCHAIN ─────────────────────────────────────────────────────────────
/*
import { Blackbox } from "@blackbox/runtime"
import { BlackboxCallbackHandler } from "@blackbox/langchain"
import { AgentExecutor } from "langchain/agents"

const bb      = new Blackbox({ agent_id: "langchain-agent@1.0.0" })
const handler = new BlackboxCallbackHandler(bb)

const executor = new AgentExecutor({ agent, tools, callbacks: [handler] })
await executor.invoke({ input: "Search for recent AI papers" })

const artifact = bb.end()
*/

// ─── 3. OPENAI AGENTS SDK ─────────────────────────────────────────────────────
/*
import { traceOpenAIAgent } from "@blackbox/openai-agents"
import { Agent, Runner } from "@openai/agents"

const agent = new Agent({ name: "Assistant", instructions: "You are helpful." })

const { output, artifact } = await traceOpenAIAgent(
  { agent_id: "openai-agent@1.0.0", tags: ["production"] },
  () => Runner.run(agent, "What is the capital of France?")
)

console.log(output.final_output)
fs.writeFileSync("run.blackbox", JSON.stringify(artifact))
*/

// ─── 4. VERCEL AI SDK ─────────────────────────────────────────────────────────
/*
import { Blackbox } from "@blackbox/runtime"
import { traceGenerateText, traceTool } from "@blackbox/vercel-ai"
import { generateText } from "ai"
import { openai } from "@ai-sdk/openai"
import { z } from "zod"

const bb = new Blackbox({ agent_id: "vercel-agent@1.0.0" })

const result = await traceGenerateText(bb, {
  model: openai("gpt-4o"),
  prompt: "What tools do you have?",
  tools: {
    search: traceTool(bb, "search", {
      description: "Search the web",
      parameters: z.object({ query: z.string() }),
      execute: async ({ query }) => fetch(`/api/search?q=${query}`).then(r => r.json())
    })
  }
}, () => generateText({ model: openai("gpt-4o"), prompt: "..." }))

const artifact = bb.end()
*/

// ─── 5. AUTOGEN ───────────────────────────────────────────────────────────────
/*
import { AutoGenBlackboxBridge } from "@blackbox/autogen"
import { spawn } from "child_process"

const bridge = new AutoGenBlackboxBridge({ agent_id: "autogen-team@1.0.0" })

const proc = spawn("python", ["run_agent.py"])
bridge.start(proc.stdout)

await new Promise(resolve => proc.on("close", resolve))
const artifact = await bridge.end()
*/

// ─── 6. EXPRESS MIDDLEWARE ────────────────────────────────────────────────────
/*
import express from "express"
import { blackboxMiddleware } from "@blackbox/core"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"

const app = express()
const s3  = new S3Client({ region: "us-east-1" })

app.use(blackboxMiddleware({
  getAgentId: (req) => req.headers["x-agent-id"] ?? "api-agent",
  tags: ["production", "api"],
  onArtifact: async (artifact, req) => {
    // Auto-ship every artifact to S3 for audit trail
    await s3.send(new PutObjectCommand({
      Bucket: "my-blackbox-artifacts",
      Key: `${artifact.run_id}.blackbox`,
      Body: JSON.stringify(artifact),
      ContentType: "application/json",
    }))
  }
}))

app.post("/agent/run", async (req, res) => {
  const bb = req.blackbox // typed as Blackbox

  const result = await bb.record("tool_call", "process_request", req.body, async () => {
    // ... your agent logic ...
    return { processed: true }
  })

  const artifact = bb.end()
  res.json({ result, run_id: artifact.run_id })
})
*/

export { BlackboxCallbackHandler } from "./langchain.js";
export { traceOpenAIAgent, traceOpenAICompletion } from "./openai-agents.js";
export { AutoGenBlackboxBridge, traceConversation, PYTHON_HOOK } from "./autogen.js";
export { traceGenerateText, traceStreamText, traceTool } from "./vercel-ai.js";
export { traceToolCall, traceLLM, traceHTTP, traceFetch, traceFileOp, traceExec, blackboxMiddleware } from "./core.js";

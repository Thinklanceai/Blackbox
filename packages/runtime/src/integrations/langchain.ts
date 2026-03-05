/**
 * @blackbox/langchain
 *
 * Drop-in LangChain callback handler.
 * Every LangChain event → a blackbox trace event.
 *
 * Usage:
 *   import { BlackboxCallbackHandler } from "@blackbox/langchain"
 *   import { Blackbox } from "@blackbox/runtime"
 *
 *   const bb = new Blackbox({ agent_id: "my-langchain-agent@1.0.0" })
 *   const handler = new BlackboxCallbackHandler(bb)
 *
 *   const chain = new AgentExecutor({ agent, tools, callbacks: [handler] })
 *   await chain.invoke({ input: "..." })
 *
 *   const artifact = bb.end()
 */

import { Blackbox, EventType } from "../runtime.js";

// ─── LangChain callback types (minimal — no dep on langchain itself) ──────────

interface Serialized { id: string[]; name?: string }
interface LLMResult { generations: Array<Array<{ text: string; generationInfo?: Record<string, unknown> }>>; llmOutput?: Record<string, unknown> }
interface ChainValues { [key: string]: unknown }
interface AgentAction  { tool: string; toolInput: string | Record<string, unknown>; log: string }
interface AgentFinish  { returnValues: Record<string, unknown>; log: string }
interface Document     { pageContent: string; metadata: Record<string, unknown> }

// ─── Handler ──────────────────────────────────────────────────────────────────

export class BlackboxCallbackHandler {
  private bb: Blackbox;
  private pendingLLM   = new Map<string, { start: number; serialized: Serialized; prompts: string[] }>();
  private pendingChain = new Map<string, { start: number; name: string }>();
  private pendingTool  = new Map<string, { start: number; name: string; input: unknown }>();

  constructor(bb: Blackbox) {
    this.bb = bb;
  }

  // ── LLM ─────────────────────────────────────────────────────────────────────

  async handleLLMStart(serialized: Serialized, prompts: string[], runId: string): Promise<void> {
    this.pendingLLM.set(runId, { start: Date.now(), serialized, prompts });
    await this.bb.record("llm_call", `llm_start:${serialized.id.at(-1) ?? "unknown"}`, {
      model: serialized.id.at(-1),
      prompts: prompts.map(p => p.slice(0, 200)),
    }, async () => ({ queued: true }));
  }

  async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    const pending = this.pendingLLM.get(runId);
    this.pendingLLM.delete(runId);
    const model = pending?.serialized?.id?.at(-1) ?? "unknown";
    const text  = output.generations?.[0]?.[0]?.text ?? "";

    await this.bb.record("llm_result", `llm_end:${model}`, {
      model,
      prompt_preview: pending?.prompts?.[0]?.slice(0, 200),
    }, async () => ({
      text_preview:    text.slice(0, 500),
      text_length:     text.length,
      finish_reason:   output.generations?.[0]?.[0]?.generationInfo?.finish_reason,
      token_usage:     output.llmOutput?.tokenUsage,
      duration_ms:     pending ? Date.now() - pending.start : undefined,
    }));
  }

  async handleLLMError(err: Error, runId: string): Promise<void> {
    this.pendingLLM.delete(runId);
    await this.bb.record("llm_result", "llm_error", { run_id: runId }, async () => {
      throw err;
    }).catch(() => {});
  }

  // ── Chain ────────────────────────────────────────────────────────────────────

  async handleChainStart(serialized: Serialized, inputs: ChainValues, runId: string): Promise<void> {
    const name = serialized.id.at(-1) ?? "chain";
    this.pendingChain.set(runId, { start: Date.now(), name });
    this.bb.setState({ active_chain: name });
    await this.bb.record("tool_call", `chain_start:${name}`, {
      chain: name,
      input_keys: Object.keys(inputs),
      inputs: sanitize(inputs),
    }, async () => ({ started: true }));
  }

  async handleChainEnd(outputs: ChainValues, runId: string): Promise<void> {
    const pending = this.pendingChain.get(runId);
    this.pendingChain.delete(runId);
    await this.bb.record("tool_result", `chain_end:${pending?.name ?? "chain"}`, {}, async () => ({
      output_keys:  Object.keys(outputs),
      outputs:      sanitize(outputs),
      duration_ms:  pending ? Date.now() - pending.start : undefined,
    }));
  }

  async handleChainError(err: Error, runId: string): Promise<void> {
    const pending = this.pendingChain.get(runId);
    this.pendingChain.delete(runId);
    await this.bb.record("tool_result", `chain_error:${pending?.name ?? "chain"}`, {}, async () => {
      throw err;
    }).catch(() => {});
  }

  // ── Tool ─────────────────────────────────────────────────────────────────────

  async handleToolStart(serialized: Serialized, input: string, runId: string): Promise<void> {
    const name = serialized.id.at(-1) ?? "tool";
    this.pendingTool.set(runId, { start: Date.now(), name, input });
    await this.bb.record("tool_call", `tool_start:${name}`, {
      tool:  name,
      input: input.slice(0, 500),
    }, async () => ({ queued: true }));
  }

  async handleToolEnd(output: string, runId: string): Promise<void> {
    const pending = this.pendingTool.get(runId);
    this.pendingTool.delete(runId);
    await this.bb.record("tool_result", `tool_end:${pending?.name ?? "tool"}`, {
      input: typeof pending?.input === "string" ? pending.input.slice(0, 200) : pending?.input,
    }, async () => ({
      output:      output.slice(0, 500),
      duration_ms: pending ? Date.now() - pending.start : undefined,
    }));
  }

  async handleToolError(err: Error, runId: string): Promise<void> {
    const pending = this.pendingTool.get(runId);
    this.pendingTool.delete(runId);
    await this.bb.record("tool_result", `tool_error:${pending?.name ?? "tool"}`, {}, async () => {
      throw err;
    }).catch(() => {});
  }

  // ── Agent ────────────────────────────────────────────────────────────────────

  async handleAgentAction(action: AgentAction): Promise<void> {
    await this.bb.record("decision", `agent_action:${action.tool}`, {
      tool:       action.tool,
      tool_input: typeof action.toolInput === "string"
        ? action.toolInput.slice(0, 300)
        : action.toolInput,
      log_preview: action.log.slice(0, 200),
    }, async () => ({ decided: true }));
  }

  async handleAgentEnd(finish: AgentFinish): Promise<void> {
    await this.bb.record("decision", "agent_finish", {
      return_values: sanitize(finish.returnValues),
      log_preview:   finish.log.slice(0, 200),
    }, async () => ({ finished: true }));
  }

  // ── Retriever ────────────────────────────────────────────────────────────────

  async handleRetrieverStart(serialized: Serialized, query: string, runId: string): Promise<void> {
    await this.bb.record("memory_read", `retriever_start:${serialized.id.at(-1) ?? "retriever"}`, {
      query: query.slice(0, 300),
    }, async () => ({ queued: true }));
  }

  async handleRetrieverEnd(documents: Document[], runId: string): Promise<void> {
    await this.bb.record("memory_read", "retriever_end", {}, async () => ({
      docs_count: documents.length,
      sources:    documents.map(d => d.metadata?.source).filter(Boolean).slice(0, 10),
    }));
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sanitize(obj: unknown, maxDepth = 3, depth = 0): unknown {
  if (depth >= maxDepth) return "[truncated]";
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return obj.slice(0, 500);
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.slice(0, 10).map(v => sanitize(v, maxDepth, depth + 1));
  return Object.fromEntries(
    Object.entries(obj as Record<string, unknown>)
      .slice(0, 20)
      .map(([k, v]) => [k, sanitize(v, maxDepth, depth + 1)])
  );
}

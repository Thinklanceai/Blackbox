/**
 * @blackbox/openai-agents
 *
 * Integration for the OpenAI Agents SDK.
 * Wraps any OpenAI agent run inside a blackbox trace.
 *
 * Usage:
 *   import { traceOpenAIAgent } from "@blackbox/openai-agents"
 *
 *   const result = await traceOpenAIAgent(
 *     { agent_id: "my-openai-agent@1.0.0" },
 *     () => Runner.run(agent, "What is the capital of France?")
 *   )
 *
 *   // result.artifact — the .blackbox file
 *   // result.output   — the agent's output
 */

import { Blackbox, BlackboxArtifact } from "../runtime.js";

// ─── OpenAI Agents SDK types (minimal) ────────────────────────────────────────

interface RunResult {
  final_output?: unknown;
  new_items?: RunItem[];
}

interface RunItem {
  type: string;
  raw_item?: unknown;
}

interface FunctionCallItem {
  type: "tool_call_item";
  raw_item: {
    type: "function_call";
    name: string;
    arguments: string;
    call_id: string;
  };
}

interface FunctionCallOutputItem {
  type: "tool_call_output_item";
  output: string;
  raw_item: { call_id: string };
}

interface MessageOutputItem {
  type: "message_output_item";
  raw_item: {
    type: "message";
    role: string;
    content: Array<{ type: string; text?: string }>;
  };
}

interface HandoffItem {
  type: "handoff_output_item";
  source_agent?: { name: string };
  target_agent?: { name: string };
}

// ─── Main wrapper ─────────────────────────────────────────────────────────────

export interface TraceOpenAIAgentOptions {
  agent_id: string;
  tags?: string[];
  onEvent?: Parameters<typeof Blackbox.prototype.record>[3] extends (...args: infer A) => infer R ? never : never;
}

export interface TraceResult<T> {
  output: T;
  artifact: BlackboxArtifact;
}

export async function traceOpenAIAgent<T extends RunResult>(
  options: { agent_id: string; tags?: string[] },
  fn: () => Promise<T>
): Promise<TraceResult<T>> {
  const bb = new Blackbox({ agent_id: options.agent_id, tags: options.tags });

  const result = await bb.record("tool_call", "agent_run", {}, async () => {
    const output = await fn();

    // Parse and trace each item from the run
    if (output.new_items) {
      for (const item of output.new_items) {
        await traceItem(bb, item);
      }
    }

    return output;
  });

  const artifact = bb.end();
  return { output: result, artifact };
}

async function traceItem(bb: Blackbox, item: RunItem): Promise<void> {
  switch (item.type) {
    case "tool_call_item": {
      const i = item as FunctionCallItem;
      await bb.record("tool_call", `tool:${i.raw_item.name}`, {
        name:      i.raw_item.name,
        call_id:   i.raw_item.call_id,
        arguments: parseArgs(i.raw_item.arguments),
      }, async () => ({ queued: true }));
      break;
    }

    case "tool_call_output_item": {
      const i = item as FunctionCallOutputItem;
      await bb.record("tool_result", `tool_result:${i.raw_item.call_id}`, {
        call_id: i.raw_item.call_id,
      }, async () => ({
        output:   i.output.slice(0, 500),
        truncated: i.output.length > 500,
      }));
      break;
    }

    case "message_output_item": {
      const i = item as MessageOutputItem;
      const text = i.raw_item.content
        .filter(c => c.type === "output_text")
        .map(c => c.text ?? "")
        .join("");
      await bb.record("llm_result", `message:${i.raw_item.role}`, {
        role: i.raw_item.role,
      }, async () => ({
        text_preview: text.slice(0, 500),
        text_length:  text.length,
      }));
      break;
    }

    case "handoff_output_item": {
      const i = item as HandoffItem;
      await bb.record("decision", "agent_handoff", {
        from: i.source_agent?.name,
        to:   i.target_agent?.name,
      }, async () => ({ handed_off: true }));
      break;
    }

    default: {
      await bb.record("tool_call", `unknown_item:${item.type}`, { raw: item }, async () => ({ skipped: true }));
    }
  }
}

function parseArgs(args: string): unknown {
  try { return JSON.parse(args); } catch { return args; }
}

// ─── Middleware factory for OpenAI responses ──────────────────────────────────

/**
 * Lower-level: wrap an OpenAI chat completion call.
 * Traces the request and response as llm_call / llm_result events.
 *
 * Usage:
 *   const { result, artifact } = await traceOpenAICompletion(bb, {
 *     model: "gpt-4o",
 *     messages: [...]
 *   }, () => openai.chat.completions.create({ model: "gpt-4o", messages: [...] }))
 */
export async function traceOpenAICompletion<T extends {
  choices: Array<{ message: { role: string; content: string | null }; finish_reason: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model: string;
}>(
  bb: Blackbox,
  request: { model: string; messages: Array<{ role: string; content: string }> },
  fn: () => Promise<T>
): Promise<T> {
  const input = {
    model:    request.model,
    messages: request.messages.map(m => ({
      role:    m.role,
      content: m.content.slice(0, 300),
    })),
  };

  return bb.record("llm_call", `openai:${request.model}`, input, async () => {
    const result = await fn();

    // Inject output into the next event via setState
    bb.setState({
      last_llm_model:         result.model,
      last_llm_finish_reason: result.choices[0]?.finish_reason,
      last_llm_tokens:        result.usage?.total_tokens,
    });

    return result;
  });
}

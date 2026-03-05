/**
 * @blackbox/vercel-ai
 *
 * Integration for the Vercel AI SDK (ai package).
 * Traces generateText, streamText, generateObject, and tool calls.
 *
 * Usage:
 *   import { traceGenerateText, traceStreamText } from "@blackbox/vercel-ai"
 *   import { Blackbox } from "@blackbox/runtime"
 *   import { generateText } from "ai"
 *   import { openai } from "@ai-sdk/openai"
 *
 *   const bb = new Blackbox({ agent_id: "my-vercel-agent@1.0.0" })
 *
 *   const result = await traceGenerateText(bb, {
 *     model: openai("gpt-4o"),
 *     prompt: "What is the capital of France?"
 *   })
 *
 *   const artifact = bb.end()
 */

import { Blackbox } from "../runtime.js";

// ─── Vercel AI SDK types (minimal) ────────────────────────────────────────────

interface GenerateTextParams {
  model:       { modelId?: string; provider?: string };
  prompt?:     string;
  messages?:   Array<{ role: string; content: string }>;
  tools?:      Record<string, unknown>;
  maxSteps?:   number;
  temperature?: number;
}

interface GenerateTextResult {
  text:          string;
  toolCalls?:    Array<{ toolName: string; args: unknown; toolCallId: string }>;
  toolResults?:  Array<{ toolName: string; result: unknown; toolCallId: string }>;
  usage?:        { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason?: string;
  steps?:        Array<{ text: string; toolCalls?: unknown[]; toolResults?: unknown[] }>;
}

interface StreamTextParams extends GenerateTextParams {
  onChunk?: (chunk: { type: string; chunk: unknown }) => void;
  onFinish?: (result: GenerateTextResult) => void;
}

// ─── generateText wrapper ─────────────────────────────────────────────────────

export async function traceGenerateText(
  bb: Blackbox,
  params: GenerateTextParams,
  fn: () => Promise<GenerateTextResult>
): Promise<GenerateTextResult> {
  const modelId   = params.model?.modelId ?? "unknown";
  const provider  = params.model?.provider ?? "unknown";
  const promptPreview = params.prompt?.slice(0, 300)
    ?? params.messages?.findLast(m => m.role === "user")?.content.slice(0, 300);

  return bb.record("llm_call", `vercel-ai:${provider}/${modelId}`, {
    model:         modelId,
    provider,
    prompt_preview: promptPreview,
    has_tools:     !!params.tools,
    max_steps:     params.maxSteps,
    temperature:   params.temperature,
  }, async () => {
    const result = await fn();

    // Trace each tool call in the result
    if (result.toolCalls?.length) {
      for (const tc of result.toolCalls) {
        await bb.record("tool_call", `tool:${tc.toolName}`, {
          tool_name: tc.toolName,
          call_id:   tc.toolCallId,
          args:      tc.args,
        }, async () => {
          const tr = result.toolResults?.find(r => r.toolCallId === tc.toolCallId);
          return tr?.result ?? null;
        });
      }
    }

    // Trace multi-step if present
    if (result.steps?.length) {
      bb.setState({ total_steps: result.steps.length });
    }

    bb.setState({
      last_model:        modelId,
      last_provider:     provider,
      last_finish_reason: result.finishReason,
      last_tokens:       result.usage?.totalTokens,
    });

    return result;
  });
}

// ─── streamText wrapper ───────────────────────────────────────────────────────

export async function traceStreamText(
  bb: Blackbox,
  params: StreamTextParams,
  fn: () => AsyncIterable<string> & { finalText?: Promise<string>; usage?: Promise<{ totalTokens: number }> }
): Promise<{ stream: AsyncIterable<string>; artifact_ready: Promise<void> }> {
  const modelId  = params.model?.modelId ?? "unknown";
  const provider = params.model?.provider ?? "unknown";

  let totalChunks = 0;
  let totalChars  = 0;

  await bb.record("llm_call", `stream:${provider}/${modelId}`, {
    model:    modelId,
    provider,
    prompt_preview: params.prompt?.slice(0, 300),
  }, async () => ({ streaming: true }));

  const rawStream = fn();

  // Wrap the stream to count chunks
  async function* wrappedStream(): AsyncIterable<string> {
    for await (const chunk of rawStream) {
      totalChunks++;
      totalChars += chunk.length;
      yield chunk;
    }
  }

  const artifact_ready = (async () => {
    // Wait for stream to finish
    for await (const _ of wrappedStream()) {}

    await bb.record("llm_result", `stream_end:${modelId}`, {}, async () => ({
      total_chunks: totalChunks,
      total_chars:  totalChars,
      model:        modelId,
    }));
  })();

  return { stream: wrappedStream(), artifact_ready };
}

// ─── Tool execution tracer ────────────────────────────────────────────────────

/**
 * Wrap a Vercel AI SDK tool definition to auto-trace executions.
 *
 * @example
 *   const tools = {
 *     search: traceTool(bb, "search", {
 *       description: "Search the web",
 *       parameters: z.object({ query: z.string() }),
 *       execute: async ({ query }) => { ... }
 *     })
 *   }
 */
export function traceTool<TInput, TOutput>(
  bb: Blackbox,
  name: string,
  tool: {
    description?: string;
    parameters:   unknown;
    execute:      (input: TInput) => Promise<TOutput>;
  }
): typeof tool {
  return {
    ...tool,
    execute: async (input: TInput): Promise<TOutput> => {
      return bb.record("tool_call", `tool:${name}`, {
        tool:  name,
        input: input as unknown,
      }, () => tool.execute(input));
    },
  };
}

/**
 * @blackbox/core
 *
 * Framework-agnostic primitives.
 * Use these when you're not using LangChain / OpenAI / AutoGen.
 *
 * Includes:
 * - traceToolCall()   — wrap any tool/function call
 * - traceLLM()        — wrap any LLM call (any provider)
 * - traceHTTP()       — wrap any fetch/axios call
 * - traceExec()       — wrap any child_process.exec call
 * - traceFileOp()     — wrap any file system operation
 * - BlackboxMiddleware — Express/Hono/Fastify middleware
 */

import { Blackbox, BlackboxArtifact, EventType } from "../runtime.js";
import { ChildProcess } from "child_process";

// ─── Tool call wrapper ────────────────────────────────────────────────────────

export async function traceToolCall<T>(
  bb: Blackbox,
  name: string,
  input: unknown,
  fn: () => Promise<T>
): Promise<T> {
  const result = await bb.record("tool_call", name, input, fn);
  return result;
}

// ─── LLM wrapper (provider-agnostic) ─────────────────────────────────────────

export interface LLMRequest {
  model:    string;
  provider: "openai" | "anthropic" | "google" | "mistral" | "cohere" | string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  max_tokens?:  number;
}

export interface LLMResponse {
  content:      string;
  model:        string;
  stop_reason?: string;
  usage?: {
    input_tokens?:  number;
    output_tokens?: number;
    total_tokens?:  number;
  };
}

export async function traceLLM<T extends LLMResponse>(
  bb: Blackbox,
  request: LLMRequest,
  fn: () => Promise<T>
): Promise<T> {
  const input = {
    provider:    request.provider,
    model:       request.model,
    temperature: request.temperature,
    max_tokens:  request.max_tokens,
    message_count: request.messages.length,
    last_user_message: request.messages.findLast(m => m.role === "user")?.content.slice(0, 300),
  };

  return bb.record("llm_call", `${request.provider}:${request.model}`, input, async () => {
    const result = await fn();
    bb.setState({
      last_llm_provider:    request.provider,
      last_llm_model:       result.model,
      last_llm_stop_reason: result.stop_reason,
      last_llm_tokens:      result.usage?.total_tokens,
    });
    return result;
  });
}

// ─── HTTP wrapper ─────────────────────────────────────────────────────────────

export interface HttpRequest {
  method: string;
  url:    string;
  headers?: Record<string, string>;
  body?:    unknown;
}

export async function traceHTTP<T>(
  bb: Blackbox,
  request: HttpRequest,
  fn: () => Promise<{ status: number; headers?: Record<string, string>; data: T }>
): Promise<T> {
  const url = new URL(request.url);

  return bb.record("http_request", `${request.method} ${url.hostname}${url.pathname}`, {
    method:   request.method,
    url:      request.url,
    hostname: url.hostname,
    path:     url.pathname,
  }, async () => {
    const response = await fn();
    bb.setState({ last_http_status: response.status, last_http_host: url.hostname });
    return response.data;
  });
}

// ─── fetch() wrapper ──────────────────────────────────────────────────────────

export async function traceFetch(
  bb: Blackbox,
  url: string,
  init?: RequestInit
): Promise<Response> {
  const method = init?.method ?? "GET";
  const parsed = new URL(url);

  return bb.record("http_request", `fetch:${method} ${parsed.hostname}`, {
    method,
    url,
    has_body: !!init?.body,
  }, async () => {
    const response = await fetch(url, init);
    bb.setState({ last_fetch_status: response.status, last_fetch_host: parsed.hostname });
    return response;
  });
}

// ─── File operation wrapper ───────────────────────────────────────────────────

export type FileOpType = "read" | "write" | "delete" | "rename" | "stat";

export async function traceFileOp<T>(
  bb: Blackbox,
  op: FileOpType,
  path: string,
  fn: () => Promise<T>,
  metadata?: Record<string, unknown>
): Promise<T> {
  const type: EventType = op === "read" ? "file_read" : "file_write";
  return bb.record(type, `file_${op}:${path}`, { path, op, ...metadata }, fn);
}

// ─── Process exec wrapper ─────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  code:   number | null;
}

export async function traceExec(
  bb: Blackbox,
  command: string,
  fn: () => Promise<ExecResult>
): Promise<ExecResult> {
  // Sanitize: don't log full command if it contains secrets
  const safeCmd = command.length > 200 ? command.slice(0, 200) + "…" : command;
  const cmdLabel = command.split(" ")[0]; // just the binary name for the action label

  return bb.record("exec", `exec:${cmdLabel}`, {
    command:  safeCmd,
    binary:   cmdLabel,
  }, async () => {
    const result = await fn();
    if (result.code !== 0) {
      throw Object.assign(new Error(`Process exited with code ${result.code}`), {
        code:   String(result.code),
        stderr: result.stderr.slice(0, 500),
      });
    }
    return result;
  });
}

// ─── Express/Hono/Fastify middleware ──────────────────────────────────────────

export interface RequestLike {
  method: string;
  url:    string;
  path?:  string;
  headers: Record<string, string | string[] | undefined>;
  body?:  unknown;
}

export interface ResponseLike {
  statusCode?: number;
  status?:     number;
}

/**
 * HTTP middleware factory.
 * Attaches a Blackbox instance to each request for per-request tracing.
 *
 * @example Express:
 *   app.use(blackboxMiddleware({ getAgentId: (req) => req.headers['x-agent-id'] ?? 'api' }))
 *   app.post('/run', (req, res) => {
 *     const bb: Blackbox = req.blackbox
 *     // ... use bb.record() for agent actions ...
 *     const artifact = bb.end()
 *     res.json({ artifact })
 *   })
 */
export function blackboxMiddleware(options: {
  getAgentId?: (req: RequestLike) => string;
  tags?:       string[];
  onArtifact?: (artifact: BlackboxArtifact, req: RequestLike) => void;
}) {
  return function middleware(req: RequestLike & Record<string, unknown>, res: ResponseLike & Record<string, unknown>, next: () => void): void {
    const agentId = options.getAgentId?.(req) ?? "http-agent";
    const bb = new Blackbox({ agent_id: agentId, tags: options.tags });

    // Attach to request
    req.blackbox = bb;

    // Trace the incoming request
    bb.record("http_request", `${req.method} ${req.path ?? req.url}`, {
      method:  req.method,
      path:    req.path ?? req.url,
      headers: sanitizeHeaders(req.headers),
    }, async () => ({ received: true })).catch(() => {});

    // Hook response finish
    const originalEnd = (res as Record<string, unknown>).end as Function;
    (res as Record<string, unknown>).end = function(...args: unknown[]) {
      const artifact = bb.end();
      options.onArtifact?.(artifact, req);
      return originalEnd.apply(res, args);
    };

    next();
  };
}

function sanitizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const SENSITIVE = new Set(["authorization", "cookie", "x-api-key", "x-auth-token"]);
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([k]) => !SENSITIVE.has(k.toLowerCase()))
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v ?? ""])
  );
}

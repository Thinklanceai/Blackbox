/**
 * @blackbox/autogen
 *
 * Integration for Microsoft AutoGen (Python-side via subprocess bridge
 * OR TypeScript AutoGen port). Ships both:
 *
 * 1. A TypeScript event bridge that receives events from a Python AutoGen
 *    agent via stdin/stdout JSON-RPC.
 *
 * 2. A Python snippet (as a string constant) that can be injected into
 *    AutoGen agents to emit blackbox-compatible events.
 *
 * Usage (TypeScript bridge):
 *   import { AutoGenBlackboxBridge } from "@blackbox/autogen"
 *
 *   const bridge = new AutoGenBlackboxBridge({ agent_id: "autogen-team@1.0.0" })
 *   bridge.start(process.stdin) // pipe from Python subprocess
 *   // ... run your AutoGen agent ...
 *   const artifact = bridge.end()
 *
 * Usage (Python side) — inject PYTHON_HOOK into your AutoGen agent:
 *   import BlackboxHook from "@blackbox/autogen"
 *   // copy BlackboxHook.PYTHON_HOOK into your agent file
 */

import { Blackbox, BlackboxArtifact, EventType } from "../runtime.js";
import { Readable } from "stream";

// ─── JSON-RPC event schema emitted by the Python hook ─────────────────────────

interface AutoGenEvent {
  jsonrpc: "2.0";
  method:  "blackbox.event";
  params: {
    type:    string;
    action:  string;
    agent:   string;
    input:   unknown;
    output:  unknown;
    error?:  { message: string; recoverable: boolean };
    ts:      string;
  };
}

// ─── TypeScript bridge ────────────────────────────────────────────────────────

export class AutoGenBlackboxBridge {
  private bb: Blackbox;
  private buffer = "";
  private eventQueue: Promise<void> = Promise.resolve();

  constructor(options: { agent_id: string; tags?: string[] }) {
    this.bb = new Blackbox({ agent_id: options.agent_id, tags: options.tags });
  }

  /**
   * Attach to a Readable stream (e.g. subprocess stdout).
   * Parses newline-delimited JSON-RPC events.
   */
  start(stream: Readable): void {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) this._processLine(line.trim());
      }
    });
  }

  private _processLine(line: string): void {
    let msg: AutoGenEvent;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.jsonrpc !== "2.0" || msg.method !== "blackbox.event") return;

    const { type, action, input, output, error } = msg.params;
    const eventType = AUTOGEN_TYPE_MAP[type] ?? "tool_call";

    this.eventQueue = this.eventQueue.then(async () => {
      if (error) {
        await this.bb.record(eventType, action, input, async () => {
          throw Object.assign(new Error(error.message), { recoverable: error.recoverable });
        }).catch(() => {});
      } else {
        await this.bb.record(eventType, action, input, async () => output);
      }
    });
  }

  async end(): Promise<BlackboxArtifact> {
    await this.eventQueue;
    return this.bb.end();
  }
}

const AUTOGEN_TYPE_MAP: Record<string, EventType> = {
  "agent_message":      "llm_result",
  "agent_reply":        "llm_result",
  "tool_call":          "tool_call",
  "tool_response":      "tool_result",
  "human_input":        "memory_read",
  "termination":        "decision",
  "groupchat_select":   "decision",
  "code_execution":     "exec",
  "code_result":        "tool_result",
  "function_call":      "tool_call",
  "function_response":  "tool_result",
};

// ─── Python hook (inject into AutoGen agents) ─────────────────────────────────

export const PYTHON_HOOK = `
# blackbox hook — inject into AutoGen agent
# Emits newline-delimited JSON-RPC events to stdout.
# Compatible with @blackbox/autogen TypeScript bridge.

import sys, json
from datetime import datetime, timezone
from typing import Any

def _bb_emit(type_: str, action: str, agent: str, input_: Any, output: Any, error: dict | None = None) -> None:
    event = {
        "jsonrpc": "2.0",
        "method":  "blackbox.event",
        "params": {
            "type":   type_,
            "action": action,
            "agent":  agent,
            "input":  input_,
            "output": output,
            "ts":     datetime.now(timezone.utc).isoformat(),
            **({"error": error} if error else {}),
        }
    }
    sys.stdout.write(json.dumps(event) + "\\n")
    sys.stdout.flush()

# Usage in AutoGen agent:
# _bb_emit("tool_call", "search_web", "ResearchAgent", {"query": "..."}, None)
# _bb_emit("tool_response", "search_web", "ResearchAgent", None, {"results": [...]})
# _bb_emit("agent_reply", "final_answer", "AssistantAgent", None, {"text": "..."})
`;

// ─── Multi-agent conversation tracer ─────────────────────────────────────────

export interface ConversationMessage {
  sender:  string;
  content: string;
  role:    "user" | "assistant" | "system" | "tool";
}

/**
 * Trace a full multi-agent conversation as a blackbox run.
 * Useful when you have the conversation history and want to audit it.
 */
export async function traceConversation(
  options: { agent_id: string; tags?: string[] },
  messages: ConversationMessage[]
): Promise<BlackboxArtifact> {
  const bb = new Blackbox(options);

  for (const msg of messages) {
    const type: EventType = msg.role === "tool" ? "tool_result" : "llm_result";
    const action = `${msg.sender}:${msg.role}`;

    await bb.record(type, action, { sender: msg.sender, role: msg.role }, async () => ({
      content_preview: msg.content.slice(0, 500),
      content_length:  msg.content.length,
    }));
  }

  return bb.end();
}

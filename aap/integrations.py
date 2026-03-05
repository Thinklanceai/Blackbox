"""
aap.integrations — Python agent framework integrations

LangChain:
    from aap.integrations import BlackboxCallbackHandler
    from aap import Tracer

    tracer = Tracer(agent_id="langchain-agent@1.0.0")
    handler = BlackboxCallbackHandler(tracer)
    chain = AgentExecutor(agent=agent, tools=tools, callbacks=[handler])
    await chain.ainvoke({"input": "..."})
    artifact = tracer.end()

OpenAI:
    from aap.integrations import trace_openai
    from aap import Tracer
    from openai import AsyncOpenAI

    tracer  = Tracer(agent_id="openai-agent@1.0.0")
    client  = trace_openai(tracer, AsyncOpenAI())
    result  = await client.chat.completions.create(...)
    artifact = tracer.end()
"""

from __future__ import annotations
import time, json
from typing import Any, Optional, TYPE_CHECKING
from . import Tracer

# ── LangChain ──────────────────────────────────────────────────────────────────

class BlackboxCallbackHandler:
    """
    Drop-in LangChain callback handler.
    Pass as callbacks=[handler] to any Chain, AgentExecutor, or LLM.
    """

    def __init__(self, tracer: Tracer):
        self.tracer = tracer
        self._pending_llm:   dict[str, dict] = {}
        self._pending_chain: dict[str, dict] = {}
        self._pending_tool:  dict[str, dict] = {}

    # ── LLM ─────────────────────────────────────────────────────────────────

    def on_llm_start(self, serialized: dict, prompts: list[str], *, run_id: Any, **kw):
        model = (serialized.get("id") or ["unknown"])[-1]
        self._pending_llm[str(run_id)] = {"start": time.monotonic_ns()//1_000_000, "model": model, "prompts": prompts}
        with self.tracer.record("llm_call", f"llm_start:{model}", {
            "model": model, "prompts": [p[:200] for p in prompts[:3]]
        }) as s:
            s.set_output({"queued": True})

    def on_llm_end(self, response: Any, *, run_id: Any, **kw):
        p = self._pending_llm.pop(str(run_id), {})
        model = p.get("model", "unknown")
        text  = ""
        try: text = response.generations[0][0].text
        except: pass
        dur = time.monotonic_ns()//1_000_000 - p.get("start", 0)
        with self.tracer.record("llm_result", f"llm_end:{model}", {
            "model": model, "prompt_preview": (p.get("prompts") or [""])[0][:200]
        }) as s:
            s.set_output({
                "text_preview":  text[:500],
                "text_length":   len(text),
                "duration_ms":   dur,
            })

    def on_llm_error(self, error: Exception, *, run_id: Any, **kw):
        self._pending_llm.pop(str(run_id), None)
        try:
            with self.tracer.record("llm_result", "llm_error", {"error": str(error)}) as s:
                raise error
        except: pass

    # ── Chain ────────────────────────────────────────────────────────────────

    def on_chain_start(self, serialized: dict, inputs: dict, *, run_id: Any, **kw):
        name = (serialized.get("id") or ["chain"])[-1]
        self._pending_chain[str(run_id)] = {"start": time.monotonic_ns()//1_000_000, "name": name}
        with self.tracer.record("tool_call", f"chain_start:{name}", {
            "chain": name, "input_keys": list(inputs.keys())[:10]
        }) as s:
            s.set_output({"started": True})

    def on_chain_end(self, outputs: dict, *, run_id: Any, **kw):
        p = self._pending_chain.pop(str(run_id), {})
        with self.tracer.record("tool_result", f"chain_end:{p.get('name','chain')}", {}) as s:
            s.set_output({"output_keys": list(outputs.keys())[:10], "duration_ms": time.monotonic_ns()//1_000_000 - p.get("start",0)})

    def on_chain_error(self, error: Exception, *, run_id: Any, **kw):
        p = self._pending_chain.pop(str(run_id), {})
        try:
            with self.tracer.record("tool_result", f"chain_error:{p.get('name','chain')}", {}) as s:
                raise error
        except: pass

    # ── Tool ─────────────────────────────────────────────────────────────────

    def on_tool_start(self, serialized: dict, input_str: str, *, run_id: Any, **kw):
        name = (serialized.get("id") or ["tool"])[-1]
        self._pending_tool[str(run_id)] = {"start": time.monotonic_ns()//1_000_000, "name": name, "input": input_str}
        with self.tracer.record("tool_call", f"tool_start:{name}", {
            "tool": name, "input": input_str[:500]
        }) as s:
            s.set_output({"queued": True})

    def on_tool_end(self, output: str, *, run_id: Any, **kw):
        p = self._pending_tool.pop(str(run_id), {})
        with self.tracer.record("tool_result", f"tool_end:{p.get('name','tool')}", {
            "input_preview": str(p.get("input",""))[:200]
        }) as s:
            s.set_output({"output": str(output)[:500], "duration_ms": time.monotonic_ns()//1_000_000 - p.get("start",0)})

    def on_tool_error(self, error: Exception, *, run_id: Any, **kw):
        p = self._pending_tool.pop(str(run_id), {})
        try:
            with self.tracer.record("tool_result", f"tool_error:{p.get('name','tool')}", {}) as s:
                raise error
        except: pass

    # ── Agent ────────────────────────────────────────────────────────────────

    def on_agent_action(self, action: Any, **kw):
        with self.tracer.record("decision", f"agent_action:{action.tool}", {
            "tool":       action.tool,
            "tool_input": str(action.tool_input)[:300],
            "log":        action.log[:200],
        }) as s:
            s.set_output({"decided": True})

    def on_agent_finish(self, finish: Any, **kw):
        with self.tracer.record("decision", "agent_finish", {
            "return_values": {k: str(v)[:200] for k,v in (finish.return_values or {}).items()},
        }) as s:
            s.set_output({"finished": True})

    # ── Retriever ────────────────────────────────────────────────────────────

    def on_retriever_start(self, serialized: dict, query: str, *, run_id: Any, **kw):
        with self.tracer.record("memory_read", "retriever_start", {"query": query[:300]}) as s:
            s.set_output({"queued": True})

    def on_retriever_end(self, documents: list, *, run_id: Any, **kw):
        with self.tracer.record("memory_read", "retriever_end", {}) as s:
            s.set_output({"docs_count": len(documents)})


# ── OpenAI ────────────────────────────────────────────────────────────────────

def trace_openai(tracer: Tracer, client: Any) -> Any:
    """
    Wrap an OpenAI client to auto-trace all chat completions.

    Usage:
        client  = trace_openai(tracer, AsyncOpenAI())
        result  = await client.chat.completions.create(
                      model="gpt-4o", messages=[...]
                  )
    """
    original_create      = client.chat.completions.create
    original_acreate     = getattr(client.chat.completions, "acreate", None)

    def _make_input(model, messages, **kw):
        return {
            "model":    model,
            "messages": [{"role": m["role"], "content": str(m.get("content",""))[:300]} for m in (messages or [])[-6:]],
            **{k: v for k,v in kw.items() if k in ("temperature","max_tokens","top_p")},
        }

    def _process_result(result: Any, tracer: Tracer, model: str) -> Any:
        text = ""
        try: text = result.choices[0].message.content or ""
        except: pass
        tracer.set_state(
            last_llm_model  = getattr(result, "model", model),
            last_llm_tokens = getattr(getattr(result, "usage", None), "total_tokens", None),
            last_finish     = getattr(getattr(result, "choices", [{}])[0], "finish_reason", None),
        )
        return result

    def sync_create(*, model: str, messages: list, **kw):
        inp = _make_input(model, messages, **kw)
        with tracer.record("llm_call", f"openai:{model}", inp) as s:
            result = original_create(model=model, messages=messages, **kw)
            _process_result(result, tracer, model)
            text = ""
            try: text = result.choices[0].message.content or ""
            except: pass
            s.set_output({"text_preview": text[:500], "text_length": len(text)})
        return result

    async def async_create(*, model: str, messages: list, **kw):
        inp = _make_input(model, messages, **kw)
        with tracer.record("llm_call", f"openai:{model}", inp) as s:
            result = await original_create(model=model, messages=messages, **kw)
            _process_result(result, tracer, model)
            text = ""
            try: text = result.choices[0].message.content or ""
            except: pass
            s.set_output({"text_preview": text[:500], "text_length": len(text)})
        return result

    import asyncio
    if asyncio.iscoroutinefunction(original_create):
        client.chat.completions.create = async_create
    else:
        client.chat.completions.create = sync_create

    return client


# ── Generic tool decorator ─────────────────────────────────────────────────────

def traced_tool(tracer: Tracer, name: str | None = None):
    """
    Decorator to auto-trace any function as a tool_call event.

    Usage:
        @traced_tool(tracer, name="search_web")
        def search(query: str) -> list:
            ...
    """
    def decorator(fn):
        tool_name = name or fn.__name__
        import functools, asyncio

        @functools.wraps(fn)
        def sync_wrapper(*args, **kwargs):
            inp = {"args": [str(a)[:200] for a in args], "kwargs": {k: str(v)[:200] for k,v in kwargs.items()}}
            with tracer.record("tool_call", f"tool:{tool_name}", inp) as s:
                result = fn(*args, **kwargs)
                s.set_output(result if isinstance(result, (dict, list, str, int, float, bool, type(None))) else str(result)[:500])
            return result

        @functools.wraps(fn)
        async def async_wrapper(*args, **kwargs):
            inp = {"args": [str(a)[:200] for a in args], "kwargs": {k: str(v)[:200] for k,v in kwargs.items()}}
            with tracer.record("tool_call", f"tool:{tool_name}", inp) as s:
                result = await fn(*args, **kwargs)
                s.set_output(result if isinstance(result, (dict, list, str, int, float, bool, type(None))) else str(result)[:500])
            return result

        return async_wrapper if asyncio.iscoroutinefunction(fn) else sync_wrapper
    return decorator

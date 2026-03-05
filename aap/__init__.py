"""
aap — Agent Action Protocol
Python implementation

pip install aap-python

Usage:
    from aap import Tracer, EventType

    tracer = Tracer(agent_id="my-agent@1.0.0")

    with tracer.record("tool_call", "read_file", input={"path": "config.json"}) as span:
        data = open("config.json").read()
        span.set_output({"content": data})

    artifact = tracer.end()
    artifact.save("run.blackbox")
    artifact.verify()  # raises if tampered
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Callable, Generator, Iterator, Literal, Optional

# ── Types ──────────────────────────────────────────────────────────────────────

EventType = Literal[
    "tool_call", "tool_result",
    "llm_call",  "llm_result",
    "decision",
    "memory_read", "memory_write",
    "file_read",   "file_write",
    "exec",
    "http_request", "http_response",
    "deploy",
    "run_start", "run_end",
]

# ── Crypto ─────────────────────────────────────────────────────────────────────

def _canonical_json(obj: Any) -> str:
    """Deterministic JSON: keys sorted recursively, no extra whitespace."""
    return json.dumps(_sort_keys_deep(obj), separators=(",", ":"), ensure_ascii=False)

def _sort_keys_deep(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _sort_keys_deep(v) for k, v in sorted(obj.items())}
    if isinstance(obj, list):
        return [_sort_keys_deep(v) for v in obj]
    return obj

def _sha256(data: str) -> str:
    return hashlib.sha256(data.encode("utf-8")).hexdigest()

def _hash_state(state: Any) -> str:
    return _sha256(_canonical_json({"state": state}))

def _hash_event(event: dict) -> str:
    """Hash all event fields except 'hash' itself."""
    fields = {k: v for k, v in event.items() if k != "hash"}
    return _sha256(_canonical_json(fields))

# ── Event ──────────────────────────────────────────────────────────────────────

@dataclass
class AgentEvent:
    id:           str
    run_id:       str
    seq:          int
    timestamp:    str
    type:         str
    action:       str
    input:        Any
    output:       Any
    state_before: str
    state_after:  str
    prev_hash:    str
    hash:         str
    agent_id:     str
    tags:         list[str]
    duration_ms:  Optional[int]  = None
    error:        Optional[dict] = None

    def to_dict(self) -> dict:
        d = asdict(self)
        # Remove None values
        return {k: v for k, v in d.items() if v is not None}

    @classmethod
    def from_dict(cls, d: dict) -> "AgentEvent":
        return cls(**{k: d.get(k) for k in cls.__dataclass_fields__})

# ── Artifact ───────────────────────────────────────────────────────────────────

@dataclass
class RunStats:
    total_events: int
    errors:       int
    by_type:      dict[str, int]
    llm_calls:    int
    tool_calls:   int
    deploys:      int
    execs:        int

@dataclass
class BlackboxArtifact:
    version:     str
    run_id:      str
    agent_id:    str
    started_at:  str
    ended_at:    str
    duration_ms: int
    event_count: int
    root_hash:   str
    stats:       RunStats
    events:      list[AgentEvent]

    def to_dict(self) -> dict:
        return {
            "version":     self.version,
            "run_id":      self.run_id,
            "agent_id":    self.agent_id,
            "started_at":  self.started_at,
            "ended_at":    self.ended_at,
            "duration_ms": self.duration_ms,
            "event_count": self.event_count,
            "root_hash":   self.root_hash,
            "stats":       asdict(self.stats),
            "events":      [e.to_dict() for e in self.events],
        }

    def save(self, path: str) -> None:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, indent=2, ensure_ascii=False)

    def dumps(self) -> str:
        return json.dumps(self.to_dict(), indent=2, ensure_ascii=False)

    @classmethod
    def load(cls, path: str) -> "BlackboxArtifact":
        with open(path, encoding="utf-8") as f:
            return cls.from_dict(json.load(f))

    @classmethod
    def from_dict(cls, d: dict) -> "BlackboxArtifact":
        stats = RunStats(**d["stats"])
        events = [AgentEvent.from_dict(e) for e in d["events"]]
        return cls(
            version=d["version"], run_id=d["run_id"], agent_id=d["agent_id"],
            started_at=d["started_at"], ended_at=d["ended_at"],
            duration_ms=d["duration_ms"], event_count=d["event_count"],
            root_hash=d["root_hash"], stats=stats, events=events,
        )

    def verify(self) -> "VerifyResult":
        return verify(self)

# ── Verify ─────────────────────────────────────────────────────────────────────

@dataclass
class VerifyResult:
    valid:          bool
    events_checked: int        = 0
    reason:         str        = ""
    at_seq:         int        = -1
    expected:       str        = ""
    got:            str        = ""

    def __bool__(self) -> bool:
        return self.valid

    def assert_valid(self) -> None:
        if not self.valid:
            raise TamperedArtifactError(
                f"Artifact tampered at seq={self.at_seq}: {self.reason}\n"
                f"  expected: {self.expected}\n"
                f"  got:      {self.got}"
            )

class TamperedArtifactError(Exception):
    pass

def verify(artifact: BlackboxArtifact) -> VerifyResult:
    events = artifact.events

    if not events:
        return VerifyResult(valid=False, reason="artifact contains no events")

    for i, event in enumerate(events):
        # Seq monotonic
        if event.seq != i:
            return VerifyResult(valid=False, reason="seq discontinuity",
                                at_seq=i, expected=str(i), got=str(event.seq))

        # Chain integrity
        expected_prev = "genesis" if i == 0 else events[i - 1].hash
        if event.prev_hash != expected_prev:
            return VerifyResult(valid=False, reason="prev_hash mismatch — chain broken",
                                at_seq=i, expected=expected_prev, got=event.prev_hash)

        # Hash integrity
        d = event.to_dict()
        recomputed = _hash_event(d)
        if recomputed != event.hash:
            return VerifyResult(valid=False, reason="hash mismatch — event was tampered",
                                at_seq=i, expected=recomputed, got=event.hash)

    # Root hash
    if events[-1].hash != artifact.root_hash:
        return VerifyResult(valid=False, reason="root_hash mismatch — artifact header tampered",
                            at_seq=len(events) - 1)

    return VerifyResult(valid=True, events_checked=len(events))

# ── Replay ─────────────────────────────────────────────────────────────────────

@dataclass
class ReplayFrame:
    event:             AgentEvent
    chain_valid:       bool
    hash_valid:        bool

def replay(artifact: BlackboxArtifact) -> Iterator[ReplayFrame]:
    prev_hash = "genesis"
    for event in artifact.events:
        chain_valid = event.prev_hash == prev_hash
        recomputed  = _hash_event(event.to_dict())
        hash_valid  = recomputed == event.hash
        yield ReplayFrame(event=event, chain_valid=chain_valid, hash_valid=hash_valid)
        prev_hash = event.hash

# ── Span (context manager) ────────────────────────────────────────────────────

class Span:
    """Returned by Tracer.record() context manager."""

    def __init__(self, output_callback: Callable[[Any], None]):
        self._output_callback = output_callback
        self._output: Any = None

    def set_output(self, output: Any) -> None:
        self._output = output
        self._output_callback(output)

# ── Tracer ─────────────────────────────────────────────────────────────────────

class Tracer:
    """
    Core tracer. Two APIs:

    1. Context manager (recommended):

       with tracer.record("tool_call", "read_file", input={"path": "f"}) as span:
           data = read()
           span.set_output(data)

    2. Explicit begin/end:

       tracer.begin("tool_call", "read_file", input={"path": "f"})
       data = read()
       tracer.finish(data)
    """

    def __init__(
        self,
        agent_id: str,
        tags: list[str] | None = None,
        on_event: Callable[[AgentEvent], None] | None = None,
    ):
        self.agent_id  = agent_id
        self.tags      = tags or []
        self.on_event  = on_event
        self._run_id   = str(uuid.uuid4())
        self._events:  list[AgentEvent] = []
        self._seq      = 0
        self._state:   dict = {}
        self._started_at  = datetime.now(timezone.utc).isoformat()
        self._started_ms  = time.monotonic_ns() // 1_000_000
        self._emit("run_start", "run_start", {}, {})

    # ── Public API ─────────────────────────────────────────────────────────────

    @contextmanager
    def record(
        self,
        type: EventType,
        action: str,
        input: Any = None,
        *,
        tags: list[str] | None = None,
    ) -> Generator[Span, None, None]:
        """Context manager. Use span.set_output() inside the block."""
        state_before = _hash_state(self._state)
        t0 = time.monotonic_ns() // 1_000_000
        output_holder: list[Any] = [None]

        span = Span(lambda out: output_holder.__setitem__(0, out))

        try:
            yield span
            output = output_holder[0]
            self._state = {**self._state, "last_action": action, "last_seq": self._seq}
            state_after = _hash_state(self._state)
            self._emit(type, action, input, output, state_before, state_after,
                       duration_ms=time.monotonic_ns() // 1_000_000 - t0)
        except Exception as e:
            self._state = {**self._state, "last_error": str(e), "last_seq": self._seq}
            state_after = _hash_state(self._state)
            error = {"message": str(e), "recoverable": False}
            if hasattr(e, "errno"):
                error["code"] = str(e.errno)
            self._emit(type, action, input, None, state_before, state_after,
                       error=error, duration_ms=time.monotonic_ns() // 1_000_000 - t0)
            raise

    def record_call(
        self,
        type: EventType,
        action: str,
        input: Any,
        fn: Callable[[], Any],
    ) -> Any:
        """Functional API: record(type, action, input, lambda: do_thing())"""
        with self.record(type, action, input) as span:
            result = fn()
            span.set_output(result)
        return result

    def set_state(self, **kwargs: Any) -> None:
        self._state = {**self._state, **kwargs}

    def get_run_id(self) -> str:
        return self._run_id

    def end(self) -> BlackboxArtifact:
        duration_ms = time.monotonic_ns() // 1_000_000 - self._started_ms
        self._emit("run_end", "run_end", {}, {"event_count": self._seq, "duration_ms": duration_ms})
        ended_at = datetime.now(timezone.utc).isoformat()
        last = self._events[-1]
        stats = self._compute_stats()
        return BlackboxArtifact(
            version="0.1", run_id=self._run_id, agent_id=self.agent_id,
            started_at=self._started_at, ended_at=ended_at,
            duration_ms=duration_ms, event_count=len(self._events),
            root_hash=last.hash, stats=stats, events=self._events,
        )

    # ── Private ────────────────────────────────────────────────────────────────

    def _emit(
        self,
        type: str, action: str,
        input: Any, output: Any,
        state_before: str | None = None,
        state_after:  str | None = None,
        error: dict | None = None,
        duration_ms: int | None = None,
    ) -> None:
        sb = state_before or _hash_state(self._state)
        sa = state_after  or _hash_state(self._state)
        prev_hash = "genesis" if self._seq == 0 else self._events[-1].hash

        partial: dict = {
            "id":           str(uuid.uuid4()),
            "run_id":       self._run_id,
            "seq":          self._seq,
            "timestamp":    datetime.now(timezone.utc).isoformat(),
            "type":         type,
            "action":       action,
            "input":        input,
            "output":       output,
            "state_before": sb,
            "state_after":  sa,
            "prev_hash":    prev_hash,
            "agent_id":     self.agent_id,
            "tags":         self.tags,
        }
        if duration_ms is not None: partial["duration_ms"] = duration_ms
        if error:                   partial["error"] = error

        partial["hash"] = _hash_event(partial)

        event = AgentEvent(
            id=partial["id"], run_id=partial["run_id"], seq=partial["seq"],
            timestamp=partial["timestamp"], type=partial["type"],
            action=partial["action"], input=partial["input"], output=partial["output"],
            state_before=partial["state_before"], state_after=partial["state_after"],
            prev_hash=partial["prev_hash"], hash=partial["hash"],
            agent_id=partial["agent_id"], tags=partial["tags"],
            duration_ms=partial.get("duration_ms"), error=partial.get("error"),
        )

        self._events.append(event)
        self._seq += 1
        if self.on_event:
            self.on_event(event)

    def _compute_stats(self) -> RunStats:
        by_type: dict[str, int] = {}
        errors = 0
        for e in self._events:
            by_type[e.type] = by_type.get(e.type, 0) + 1
            if e.error: errors += 1
        return RunStats(
            total_events=len(self._events), errors=errors, by_type=by_type,
            llm_calls=by_type.get("llm_call", 0),
            tool_calls=by_type.get("tool_call", 0),
            deploys=by_type.get("deploy", 0),
            execs=by_type.get("exec", 0),
        )

# ── Convenience ────────────────────────────────────────────────────────────────

def tracer(agent_id: str, tags: list[str] | None = None) -> Tracer:
    """One-liner factory."""
    return Tracer(agent_id=agent_id, tags=tags)

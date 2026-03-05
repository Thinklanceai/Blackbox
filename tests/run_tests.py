#!/usr/bin/env python3
"""Standalone test runner — no pytest required."""
import sys, os, copy, json, time, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aap import (
    Tracer, verify, replay, BlackboxArtifact,
    TamperedArtifactError, _canonical_json, _hash_event,
)

G = "\x1b[32m"; R = "\x1b[31m"; B = "\x1b[1m"; X = "\x1b[0m"; DIM = "\x1b[90m"
passed = 0; failed = 0

def ok(name):
    global passed; passed += 1
    print(f"  {G}PASS{X}  {name}")

def fail(name, e):
    global failed; failed += 1
    print(f"  {R}FAIL{X}  {name}")
    print(f"       {DIM}{e}{X}")

def test(name, fn):
    try: fn(); ok(name)
    except Exception as e: fail(name, e)

def assert_(v, msg=""):
    if not v: raise AssertionError(msg or "assertion failed")

# ── fixture ────────────────────────────────────────────────────────────────────

def make_artifact():
    t = Tracer(agent_id="test@1.0", tags=["test"])
    with t.record("file_read",  "read",    {"path": "x"})    as s: s.set_output({"data": 42})
    with t.record("llm_call",   "analyze", {"p": "hi"})      as s: s.set_output({"text": "ok"})
    with t.record("decision",   "deploy?", {"c": 0.95})      as s: s.set_output({"d": "go"})
    with t.record("deploy",     "rollout", {"img": "v2"})    as s: s.set_output({"ok": True})
    return t.end()

# ── canonical JSON ─────────────────────────────────────────────────────────────
print(f"\n{B}canonical JSON{X}")

test("sorts keys",    lambda: assert_(_canonical_json({"z":1,"a":2}) == _canonical_json({"a":2,"z":1})))
test("nested sort",   lambda: assert_(_canonical_json({"b":{"y":1,"x":2}}) == _canonical_json({"b":{"x":2,"y":1}})))
test("no whitespace", lambda: assert_(" " not in _canonical_json({"a":1})))

# ── tracer ─────────────────────────────────────────────────────────────────────
print(f"\n{B}tracer{X}")

test("run_start seq 0",   lambda: assert_(make_artifact().events[0].type == "run_start"))
test("run_end last",      lambda: assert_(make_artifact().events[-1].type == "run_end"))
test("seq monotonic",     lambda: [assert_(e.seq == i) for i, e in enumerate(make_artifact().events)])
test("run_id consistent", lambda: assert_(len({e.run_id for e in make_artifact().events}) == 1))
test("agent_id on all",   lambda: [assert_(e.agent_id == "test@1.0") for e in make_artifact().events])
test("genesis prev_hash", lambda: assert_(make_artifact().events[0].prev_hash == "genesis"))
def test_chain_links():
    art = make_artifact()
    for i in range(1, len(art.events)):
        assert_(art.events[i].prev_hash == art.events[i-1].hash, f"chain broken at seq {i}")
test("chain links", test_chain_links)
test("root_hash = last",  lambda: assert_((a := make_artifact()).root_hash == a.events[-1].hash))

def test_input_output():
    t = Tracer(agent_id="x")
    with t.record("file_read", "r", {"path": "x"}) as s:
        s.set_output({"content": "hello"})
    art = t.end()
    assert_(art.events[1].input == {"path": "x"})
    assert_(art.events[1].output == {"content": "hello"})
test("input/output recorded", test_input_output)

def test_duration():
    t = Tracer(agent_id="x")
    with t.record("exec", "sleep", {}) as s:
        time.sleep(0.05); s.set_output({})
    art = t.end()
    assert_(art.events[1].duration_ms is not None)
    assert_(art.events[1].duration_ms >= 40, f"too low: {art.events[1].duration_ms}")
test("duration_ms measured", test_duration)

def test_error_recorded():
    t = Tracer(agent_id="x")
    try:
        with t.record("exec", "fail", {}) as s: raise ValueError("boom")
    except ValueError: pass
    art = t.end()
    assert_(art.events[1].error is not None)
    assert_("boom" in art.events[1].error["message"])
test("error recorded", test_error_recorded)

def test_state_changes():
    t = Tracer(agent_id="x")
    with t.record("file_write", "w", {"path": "x"}) as s: s.set_output({})
    art = t.end()
    assert_(art.events[1].state_before != art.events[1].state_after)
test("state hashes change after action", test_state_changes)

# ── verify ─────────────────────────────────────────────────────────────────────
print(f"\n{B}verify{X}")

test("clean artifact",         lambda: assert_(verify(make_artifact()).valid))
test("events_checked count",   lambda: assert_((v := verify(a := make_artifact())).events_checked == len(a.events)))
test("as bool",                lambda: assert_(bool(verify(make_artifact()))))
test("assert_valid no raise",  lambda: verify(make_artifact()).assert_valid())

def test_tamper_output():
    art = make_artifact(); t = copy.deepcopy(art)
    t.events[2].output = {"INJECTED": True}
    r = verify(t); assert_(not r.valid); assert_(r.at_seq == 2)
test("tamper output -> at_seq=2", test_tamper_output)

def test_tamper_input():
    art = make_artifact(); t = copy.deepcopy(art)
    t.events[1].input = {"MALICIOUS": "x"}
    r = verify(t); assert_(not r.valid)
test("tamper input", test_tamper_input)

def test_tamper_chain():
    art = make_artifact(); t = copy.deepcopy(art)
    t.events[3].prev_hash = "0" * 64
    r = verify(t); assert_(not r.valid); assert_("chain broken" in r.reason)
test("tamper prev_hash -> chain broken", test_tamper_chain)

def test_tamper_seq():
    art = make_artifact(); t = copy.deepcopy(art)
    t.events[2].seq = 99
    r = verify(t); assert_(not r.valid)
test("tamper seq", test_tamper_seq)

def test_tamper_root():
    art = make_artifact(); t = copy.deepcopy(art)
    t.root_hash = "0" * 64
    r = verify(t); assert_(not r.valid); assert_("root_hash" in r.reason)
test("tamper root_hash", test_tamper_root)

def test_assert_raises():
    art = make_artifact(); t = copy.deepcopy(art)
    t.events[1].output = {"bad": True}
    raised = False
    try: verify(t).assert_valid()
    except TamperedArtifactError: raised = True
    assert_(raised, "TamperedArtifactError not raised")
test("assert_valid raises TamperedArtifactError", test_assert_raises)

def test_tamper_propagates():
    art = make_artifact(); t = copy.deepcopy(art)
    t.events[3].output = {"bad": True}
    r = verify(t); assert_(r.at_seq == 3, f"expected 3, got {r.at_seq}")
test("tamper propagates to exact seq", test_tamper_propagates)

# ── replay ─────────────────────────────────────────────────────────────────────
print(f"\n{B}replay{X}")

test("yields all events", lambda: assert_(len(list(replay(make_artifact()))) == len(make_artifact().events)))
test("all frames valid",  lambda: [assert_(f.chain_valid and f.hash_valid) for f in replay(make_artifact())])

def test_replay_tamper():
    art = make_artifact(); t = copy.deepcopy(art)
    t.events[2].output = {"bad": True}
    frames = list(replay(t))
    # seq 2: hash invalid because output was changed
    assert_(not frames[2].hash_valid, "seq 2 should be invalid")
    # replay uses stored hash for chain tracking, so seq 3 chain appears intact
    # full verify() catches this via root_hash mismatch
    r = verify(t)
    assert_(not r.valid, "artifact should be invalid")
    assert_(r.at_seq == 2, f"expected at_seq=2, got {r.at_seq}")
test("replay detects tamper + verify catches it", test_replay_tamper)

# ── serialization ──────────────────────────────────────────────────────────────
print(f"\n{B}serialization{X}")

def test_json_roundtrip():
    art = make_artifact()
    restored = BlackboxArtifact.from_dict(json.loads(art.dumps()))
    assert_(verify(restored).valid)
    assert_(restored.run_id == art.run_id)
    assert_(len(restored.events) == len(art.events))
test("JSON roundtrip + verify", test_json_roundtrip)

def test_save_load():
    art = make_artifact()
    with tempfile.NamedTemporaryFile(suffix=".blackbox", delete=False, mode="w") as f:
        json.dump(art.to_dict(), f); path = f.name
    restored = BlackboxArtifact.load(path)
    assert_(verify(restored).valid)
    assert_(restored.run_id == art.run_id)
    os.unlink(path)
test("save() / load() roundtrip", test_save_load)

# ── stats ──────────────────────────────────────────────────────────────────────
print(f"\n{B}stats{X}")

test("total_events",  lambda: assert_(make_artifact().stats.total_events == len(make_artifact().events)))
test("llm_calls=1",   lambda: assert_(make_artifact().stats.llm_calls == 1))
test("deploys=1",     lambda: assert_(make_artifact().stats.deploys == 1))
test("errors=0",      lambda: assert_(make_artifact().stats.errors == 0))

def test_error_counted():
    t = Tracer(agent_id="x")
    try:
        with t.record("exec", "fail", {}) as s: raise RuntimeError("err")
    except: pass
    art = t.end(); assert_(art.stats.errors == 1)
test("error counted in stats", test_error_counted)

# ── functional API ─────────────────────────────────────────────────────────────
print(f"\n{B}functional API{X}")

def test_record_call():
    t = Tracer(agent_id="x")
    r = t.record_call("file_read", "read", {"p": "x"}, lambda: {"data": 99})
    assert_(r == {"data": 99})
    assert_(verify(t.end()).valid)
test("record_call()", test_record_call)

def test_hash_deterministic():
    data = {
        "id": "abc", "run_id": "xyz", "seq": 0, "timestamp": "2024-01-01T00:00:00+00:00",
        "type": "file_read", "action": "read", "input": {"x": 1}, "output": {"y": 2},
        "state_before": "aaa", "state_after": "bbb", "prev_hash": "genesis",
        "agent_id": "agent@1.0", "tags": ["test"],
    }
    assert_(_hash_event(data) == _hash_event(data), "hash not deterministic")
test("hash deterministic across calls", test_hash_deterministic)

# ── summary ────────────────────────────────────────────────────────────────────
total = passed + failed
print(f"\n{B}{'─'*44}{X}")
if failed == 0:
    print(f"  {G}{B}ALL {total} TESTS PASSED{X}")
else:
    print(f"  {G}{passed} passed{X}  {R}{failed} failed{X}  of {total}")
print()
sys.exit(0 if failed == 0 else 1)

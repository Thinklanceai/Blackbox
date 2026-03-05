#!/usr/bin/env python3
"""
blackbox demo — terminal animation
Generates a realistic agent run and replays it with a cinematic terminal UI.

Run:
    python3 demo.py           # full animated demo
    python3 demo.py --fast    # fast mode (for CI / testing)
    python3 demo.py --save    # save artifact to demo.blackbox

Record as GIF:
    asciinema rec demo.cast --command "python3 demo.py"
    agg demo.cast demo.gif
"""

from __future__ import annotations
import sys, time, json, hashlib, uuid, os, random
from datetime import datetime, timezone
from typing import Any

# ── inject aap from local dir ──────────────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aap import Tracer, verify, replay, BlackboxArtifact

# ── ANSI ───────────────────────────────────────────────────────────────────────
R = "\x1b[0m"
B = "\x1b[1m"
DIM = "\x1b[2m"
RED = "\x1b[31m"
GRN = "\x1b[32m"
YLW = "\x1b[33m"
BLU = "\x1b[34m"
MAG = "\x1b[35m"
CYN = "\x1b[36m"
WHT = "\x1b[37m"
GRY = "\x1b[90m"

EVENT_STYLE = {
    "run_start":     ("▶", GRN),
    "run_end":       ("■", GRN),
    "tool_call":     ("⚙", CYN),
    "tool_result":   ("↩", CYN),
    "llm_call":      ("◈", MAG),
    "llm_result":    ("◉", MAG),
    "decision":      ("◆", YLW),
    "file_read":     ("○", BLU),
    "file_write":    ("●", BLU),
    "exec":          ("▸", RED),
    "http_request":  ("↗", CYN),
    "http_response": ("↙", CYN),
    "deploy":        ("⬆", YLW),
    "memory_read":   ("◁", GRY),
    "memory_write":  ("▷", GRY),
}

FAST = "--fast" in sys.argv
SAVE = "--save" in sys.argv

DELAY_CHAR  = 0.018 if not FAST else 0.0
DELAY_LINE  = 0.06  if not FAST else 0.0
DELAY_EVENT = 0.18  if not FAST else 0.0
DELAY_STEP  = 0.8   if not FAST else 0.0

W = 74  # terminal width

def write(s: str) -> None:
    sys.stdout.write(s)
    sys.stdout.flush()

def writeln(s: str = "") -> None:
    write(s + "\n")

def typewrite(s: str, delay: float = DELAY_CHAR) -> None:
    if FAST:
        write(s)
        return
    for ch in s:
        write(ch)
        time.sleep(delay)

def typewriteln(s: str, delay: float = DELAY_CHAR) -> None:
    typewrite(s, delay)
    write("\n")

def line(ch: str = "─", w: int = W) -> str:
    return GRY + ch * w + R

def sleep(s: float) -> None:
    if not FAST:
        time.sleep(s)

def clear() -> None:
    write("\x1b[2J\x1b[H")

def dim(s: str) -> str:   return DIM + s + R
def bold(s: str) -> str:  return B + s + R
def ok(s: str) -> str:    return GRN + B + s + R
def err(s: str) -> str:   return RED + B + s + R
def accent(s: str) -> str: return CYN + s + R
def muted(s: str) -> str: return GRY + s + R

def event_icon(t: str) -> str:
    icon, color = EVENT_STYLE.get(t, ("·", WHT))
    return color + icon + R

def fmt_ms(ms: int | None) -> str:
    if ms is None: return ""
    if ms < 1000:  return GRY + f"{ms}ms" + R
    return GRY + f"{ms/1000:.2f}s" + R

def fmt_hash(h: str) -> str:
    return GRY + h[:14] + "…" + R

# ── Screen sections ────────────────────────────────────────────────────────────

def print_logo() -> None:
    writeln()
    writeln(f"  {B}{WHT}◼ blackbox{R}  {GRY}— deterministic agent runtime{R}")
    writeln(line())

def print_section(title: str) -> None:
    writeln(line())
    writeln(f"  {B}{WHT}{title}{R}")
    writeln(line())
    writeln()

def print_event_row(e: Any, verified: bool = True) -> None:
    seq    = str(e.seq).zfill(4)
    icon   = event_icon(e.type)
    _, col = EVENT_STYLE.get(e.type, ("·", WHT))
    typ    = col + e.type.ljust(14) + R
    act    = B + e.action + R
    dur    = fmt_ms(e.duration_ms)
    hsh    = fmt_hash(e.hash)
    chain  = muted("⛓") if verified else err("⛓✗")
    writeln(f"  {GRY}{seq}{R}  {icon} {typ}  {act}  {dur}  {hsh}  {chain}")
    sleep(DELAY_EVENT)

# ── Generate demo artifact ─────────────────────────────────────────────────────

def generate_artifact() -> BlackboxArtifact:
    """Simulate a realistic deploy agent run."""
    events_emitted: list[str] = []

    def on_event(e: Any) -> None:
        events_emitted.append(e.action)

    t = Tracer(
        agent_id="deploy-agent@2.1.0",
        tags=["demo", "production"],
        on_event=on_event,
    )

    # 1. Read config
    with t.record("file_read", "read_deploy_config", {"path": ".deploy.json"}) as s:
        time.sleep(0.02)
        s.set_output({"env": "production", "region": "eu-west-1", "replicas": 3})

    # 2. Fetch PR metadata
    with t.record("http_request", "fetch_pr_metadata", {"pr": 1847, "repo": "org/api"}) as s:
        time.sleep(0.08)
        s.set_output({"id": 1847, "title": "feat: add rate limiting", "sha": "a3f9c12", "checks": "passed"})

    # 3. LLM: analyze changes
    with t.record("llm_call", "analyze_changes", {"pr": 1847, "model": "claude-sonnet"}) as s:
        time.sleep(0.35)
        s.set_output({
            "summary": "Rate limiting middleware — token bucket, Redis-backed.",
            "risk": "low",
            "approve": True,
            "confidence": 0.94,
        })

    # 4. Decision
    with t.record("decision", "should_deploy", {"confidence": 0.94, "risk": "low"}) as s:
        time.sleep(0.01)
        s.set_output({"decision": "proceed", "reason": "confidence > 0.9 and risk == low"})

    # 5. Run tests
    with t.record("exec", "run_test_suite", {"cmd": "npm test -- --ci"}) as s:
        time.sleep(0.12)
        s.set_output({"passed": 247, "failed": 0, "duration_ms": 4821})

    # 6. Build image
    with t.record("exec", "build_docker_image", {"tag": "org/api:a3f9c12"}) as s:
        time.sleep(0.18)
        s.set_output({"image": "org/api:a3f9c12", "size_mb": 187, "layers": 12})

    # 7. Push image
    with t.record("http_request", "push_to_registry", {"image": "org/api:a3f9c12"}) as s:
        time.sleep(0.09)
        s.set_output({"digest": "sha256:9f3a...", "pushed": True})

    # 8. Deploy to k8s
    with t.record("deploy", "k8s_rolling_deploy", {"image": "org/api:a3f9c12", "replicas": 3}) as s:
        time.sleep(0.22)
        s.set_output({"status": "success", "pods_ready": 3, "rollout_ms": 8420})

    # 9. Health check
    with t.record("http_request", "health_check", {"url": "https://api.prod/health"}) as s:
        time.sleep(0.06)
        s.set_output({"status": 200, "latency_ms": 43, "healthy": True})

    # 10. Write deploy record
    with t.record("memory_write", "record_deployment", {"pr": 1847}) as s:
        time.sleep(0.01)
        s.set_output({"stored": True, "key": "deploy:a3f9c12"})

    return t.end()

# ── Animated sections ──────────────────────────────────────────────────────────

def section_intro() -> None:
    clear()
    print_logo()
    writeln()
    sleep(DELAY_STEP * 0.5)
    typewriteln(f"  {GRY}We gave agents production access.{R}")
    sleep(DELAY_STEP * 0.4)
    typewriteln(f"  {GRY}We forgot to give them a flight recorder.{R}")
    sleep(DELAY_STEP * 0.6)
    writeln()
    typewriteln(f"  {B}Simulating:{R} {CYN}deploy-agent@2.1.0{R}  {GRY}→ production{R}")
    writeln()
    sleep(DELAY_STEP)

def section_run(artifact: BlackboxArtifact) -> None:
    print_section("AGENT RUN")

    writeln(f"  {GRY}{'seq'.ljust(4)}  · {'type'.ljust(14)}  {'action'.ljust(30)}  dur        hash{R}")
    writeln(line("─"))

    for frame in replay(artifact):
        e = frame.event
        if e.type in ("run_start", "run_end"):
            continue
        print_event_row(e, frame.chain_valid and frame.hash_valid)

    writeln()
    sleep(DELAY_STEP)

def section_artifact(artifact: BlackboxArtifact) -> None:
    print_section("ARTIFACT")

    rows = [
        ("run_id",      accent(artifact.run_id)),
        ("agent",       accent(artifact.agent_id)),
        ("events",      ok(str(artifact.event_count))),
        ("duration",    fmt_ms(artifact.duration_ms)),
        ("llm_calls",   muted(str(artifact.stats.llm_calls))),
        ("tool_calls",  muted(str(artifact.stats.tool_calls))),
        ("deploys",     YLW + str(artifact.stats.deploys) + R),
        ("execs",       muted(str(artifact.stats.execs))),
        ("errors",      ok("0") if artifact.stats.errors == 0 else err(str(artifact.stats.errors))),
        ("root_hash",   muted(artifact.root_hash)),
    ]

    for label, value in rows:
        writeln(f"  {GRY}{label.ljust(12)}{R}  {value}")
        sleep(DELAY_LINE)

    writeln()
    sleep(DELAY_STEP)

def section_verify(artifact: BlackboxArtifact) -> None:
    print_section("INTEGRITY CHECK")

    write(f"  {GRY}verifying {artifact.event_count} events{R}  ")

    # Animated dots
    for _ in range(3):
        write(".")
        sleep(0.2 if not FAST else 0)
    write("  ")

    result = verify(artifact)

    if result.valid:
        writeln(ok("✓ VERIFIED"))
        sleep(DELAY_LINE)
        writeln(f"  {GRY}chain intact — every hash recomputed and matched{R}")
        writeln(f"  {GRY}root_hash    {R}{muted(artifact.root_hash)}")
    else:
        writeln(err("✗ TAMPERED"))
        writeln(f"  {RED}chain broken at seq {result.at_seq}{R}")
        writeln(f"  {RED}{result.reason}{R}")

    writeln()
    sleep(DELAY_STEP)

def section_tamper_demo(artifact: BlackboxArtifact) -> None:
    print_section("TAMPER DEMO")

    typewriteln(f"  {GRY}Simulating: attacker modifies deploy event output...{R}")
    sleep(DELAY_STEP * 0.5)

    # Clone and tamper
    import copy
    tampered = copy.deepcopy(artifact)
    deploy_event = next(e for e in tampered.events if e.type == "deploy")
    original_output = deploy_event.output
    deploy_event.output = {"status": "success", "pods_ready": 3, "INJECTED": True, "malicious": "rm -rf /"}

    writeln()
    writeln(f"  {GRY}seq {deploy_event.seq}  ⬆ deploy  output modified{R}")
    writeln(f"  {RED}  + INJECTED: true{R}")
    writeln(f"  {RED}  + malicious: 'rm -rf /'{R}")
    writeln()
    sleep(DELAY_STEP * 0.7)

    write(f"  {GRY}verifying tampered artifact{R}  ")
    for _ in range(3):
        write(".")
        sleep(0.2 if not FAST else 0)
    write("  ")

    result = verify(tampered)
    writeln(err("✗ TAMPERED"))
    writeln(f"  {RED}chain broken at seq {result.at_seq}{R}")
    writeln(f"  {RED}{result.reason}{R}")
    writeln()
    typewriteln(f"  {GRY}Restore original...{R}")
    sleep(DELAY_STEP * 0.3)
    writeln(f"  {GRN}✓ Original artifact untouched{R}")
    writeln()
    sleep(DELAY_STEP)

def section_replay(artifact: BlackboxArtifact) -> None:
    print_section("REPLAY — critical path")

    critical = [e for e in artifact.events if e.type in ("decision", "exec", "deploy", "llm_call")]

    for e in critical:
        _, col = EVENT_STYLE.get(e.type, ("·", WHT))
        icon = event_icon(e.type)
        seq  = str(e.seq).zfill(4)
        typ  = col + e.type.ljust(14) + R
        writeln(f"  {GRY}{seq}{R}  {icon} {typ}  {B}{e.action}{R}")

        if isinstance(e.output, dict):
            for k, v in list(e.output.items())[:3]:
                writeln(f"         {GRY}{k.ljust(16)}{R}  {GRY}{str(v)[:60]}{R}")

        writeln()
        sleep(DELAY_EVENT * 1.5)

    sleep(DELAY_STEP)

def section_finale() -> None:
    writeln(line("═"))
    writeln()
    sleep(DELAY_STEP * 0.3)
    typewriteln(f"  {B}{WHT}We made agents powerful.{R}")
    sleep(DELAY_STEP * 0.4)
    typewriteln(f"  {B}{WHT}We forgot to make them accountable.{R}")
    sleep(DELAY_STEP * 0.6)
    writeln()
    writeln(f"  {GRY}npm install {CYN}@blackbox/runtime{R}")
    writeln(f"  {GRY}github.com/{CYN}your-org/blackbox{R}")
    writeln()
    writeln(line())
    writeln()

# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    section_intro()

    write(f"  {GRY}generating artifact{R}  ")
    artifact = generate_artifact()
    writeln(ok("✓ done"))
    sleep(DELAY_STEP * 0.5)

    section_run(artifact)
    section_artifact(artifact)
    section_verify(artifact)
    section_tamper_demo(artifact)
    section_replay(artifact)

    if SAVE:
        path = "demo.blackbox"
        artifact.save(path)
        writeln(f"  {GRY}saved → {R}{accent(path)}")
        writeln()

    section_finale()

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
blackbox-py CLI

Usage:
    blackbox-py verify  <file.blackbox>
    blackbox-py inspect <file.blackbox>
    blackbox-py replay  <file.blackbox> [--auto] [--speed 300]
    blackbox-py diff    <a.blackbox> <b.blackbox>
    blackbox-py demo
"""

from __future__ import annotations
import sys, json, time, copy
from pathlib import Path
from . import BlackboxArtifact, verify, replay, diff as run_diff

# ── ANSI ───────────────────────────────────────────────────────────────────────
R="\x1b[0m"; B="\x1b[1m"; DIM="\x1b[2m"
RED="\x1b[31m"; GRN="\x1b[32m"; YLW="\x1b[33m"
BLU="\x1b[34m"; MAG="\x1b[35m"; CYN="\x1b[36m"
WHT="\x1b[37m"; GRY="\x1b[90m"

EVENT_STYLE = {
    "run_start":     ("▶", GRN), "run_end":       ("■", GRN),
    "tool_call":     ("⚙", CYN), "tool_result":   ("↩", CYN),
    "llm_call":      ("◈", MAG), "llm_result":    ("◉", MAG),
    "decision":      ("◆", YLW), "file_read":     ("○", BLU),
    "file_write":    ("●", BLU), "exec":          ("▸", RED),
    "http_request":  ("↗", CYN), "http_response": ("↙", CYN),
    "deploy":        ("⬆", YLW), "memory_read":   ("◁", GRY),
    "memory_write":  ("▷", GRY),
}

W = 74

def out(s=""): print(s)
def ln(ch="─"): return GRY + ch*W + R
def icon(t): i,c = EVENT_STYLE.get(t,("·",WHT)); return c+i+R
def col(t):  _,c = EVENT_STYLE.get(t,("·",WHT)); return c
def ms(v):
    if v is None: return ""
    return GRY+(f"{v}ms" if v<1000 else f"{v/1000:.2f}s")+R
def bold(s): return B+s+R
def ok(s):   return GRN+B+s+R
def err(s):  return RED+B+s+R
def dim(s):  return GRY+s+R
def acc(s):  return CYN+s+R

def load(path: str) -> BlackboxArtifact:
    try:
        return BlackboxArtifact.load(path)
    except Exception as e:
        print(err(f"✗ Cannot read: {path}"))
        print(dim(str(e)))
        sys.exit(1)

def logo():
    out()
    out(f"  {B}{WHT}◼ blackbox{R}  {GRY}— deterministic agent runtime{R}")
    out(ln())

def section(title: str):
    out(ln())
    out(f"  {B}{WHT}{title}{R}")
    out(ln())
    out()

# ── verify ─────────────────────────────────────────────────────────────────────

def cmd_verify(path: str, verbose: bool = False, events: bool = False):
    logo()
    art = load(path)

    section("INTEGRITY CHECK")
    out(f"  {dim('file')}      {acc(path)}")
    out(f"  {dim('events')}    {art.event_count}")
    out()

    if events or verbose:
        out(f"  {dim('seq'.ljust(4))}  · {dim('type'.ljust(14))}  {dim('action')}")
        out(ln("─"))

    tampered = False
    tampered_at = -1

    for frame in replay(art):
        e = frame.event
        ok_ = frame.chain_valid and frame.hash_valid
        if not ok_ and not tampered:
            tampered = True
            tampered_at = e.seq

        if events or verbose or not ok_:
            seq  = str(e.seq).zfill(4)
            typ  = col(e.type)+e.type.ljust(14)+R
            act  = bold(e.action)
            dur  = ms(e.duration_ms)
            hsh  = GRY+e.hash[:14]+"…"+R
            ch   = dim("⛓") if frame.chain_valid else err("⛓✗")
            hv   = dim("◈") if frame.hash_valid  else err("◈✗")
            out(f"  {GRY}{seq}{R}  {icon(e.type)} {typ}  {act}  {dur}  {hsh}  {ch}{hv}")

            if not frame.chain_valid:
                out(f"         {err('↳ prev_hash mismatch — chain broken')}")
            if not frame.hash_valid:
                out(f"         {err('↳ hash invalid — event tampered')}")
            if e.error:
                out(f"         {err('↳ ERROR: ' + e.error['message'])}")

    out()
    out(ln())
    out()

    if not tampered:
        out(f"  {ok('✓ VERIFIED')}  {dim('chain intact —')} {art.event_count} events")
        out(f"  {dim('root_hash')}  {GRY}{art.root_hash}{R}")
    else:
        out(f"  {err('✗ TAMPERED')}  chain broken at seq {tampered_at}")
        out(f"  {RED}This artifact cannot be trusted.{R}")

    out()

    if verbose:
        section("RUN SUMMARY")
        rows = [
            ("run_id",    acc(art.run_id)),
            ("agent",     acc(art.agent_id)),
            ("started",   GRY+art.started_at[:19].replace("T"," ")+R),
            ("ended",     GRY+art.ended_at[:19].replace("T"," ")+R),
            ("duration",  ms(art.duration_ms)),
            ("events",    ok(str(art.stats.total_events))),
            ("errors",    err(str(art.stats.errors)) if art.stats.errors else ok("0")),
            ("llm_calls", dim(str(art.stats.llm_calls))),
            ("deploys",   YLW+str(art.stats.deploys)+R),
            ("execs",     dim(str(art.stats.execs))),
        ]
        for k,v in rows:
            out(f"  {GRY}{k.ljust(12)}{R}  {v}")
        out()

    sys.exit(1 if tampered else 0)

# ── inspect ────────────────────────────────────────────────────────────────────

def cmd_inspect(path: str):
    logo()
    art = load(path)
    result = verify(art)

    section("RUN OVERVIEW")
    integrity = ok("✓ verified") if result.valid else err(f"✗ tampered at seq {result.at_seq}")
    rows = [
        ("run_id",    acc(art.run_id)),
        ("agent",     acc(art.agent_id)),
        ("integrity", integrity),
        ("started",   GRY+art.started_at[:19].replace("T"," ")+R),
        ("ended",     GRY+art.ended_at[:19].replace("T"," ")+R),
        ("duration",  ms(art.duration_ms)),
        ("events",    ok(str(art.event_count))),
        ("errors",    err(str(art.stats.errors)) if art.stats.errors else ok("0")),
        ("root_hash", GRY+art.root_hash+R),
    ]
    for k,v in rows:
        out(f"  {GRY}{k.ljust(12)}{R}  {v}")
    out()

    # Timeline
    section("TIMELINE")
    total_ms = 0
    if len(art.events) > 1:
        try:
            from datetime import datetime
            t0 = datetime.fromisoformat(art.events[0].timestamp.replace("Z",""))
            t1 = datetime.fromisoformat(art.events[-1].timestamp.replace("Z",""))
            total_ms = int((t1-t0).total_seconds()*1000)
        except: pass

    for e in art.events:
        if e.type in ("run_start","run_end"): continue
        seq  = str(e.seq).zfill(4)
        typ  = col(e.type)+e.type.ljust(14)+R
        act  = bold(e.action)
        dur  = e.duration_ms or 0
        bar_len = min(int((dur/total_ms)*30), 30) if total_ms > 0 else 0
        bar  = col(e.type)+"█"*bar_len+R if bar_len else ""
        err_ = f"  {err('⚠ '+e.error['message'][:40])}" if e.error else ""
        out(f"  {GRY}{seq}{R}  {icon(e.type)} {typ}  {act.ljust(30)}  {ms(e.duration_ms).ljust(12)}  {bar}{err_}")
    out()

    # Critical path
    critical = [e for e in art.events if e.type in ("deploy","exec","file_write","llm_call")]
    if critical:
        section("CRITICAL PATH  " + dim("(deploy · exec · file_write · llm_call)"))
        for e in critical:
            seq = str(e.seq).zfill(4)
            typ = col(e.type)+e.type.ljust(14)+R
            hsh = GRY+e.hash[:16]+"…"+R
            out(f"  {GRY}{seq}{R}  {icon(e.type)} {typ}  {bold(e.action)}  {ms(e.duration_ms)}  {hsh}")
            if e.type == "deploy" and e.output:
                out(f"           {GRY}{json.dumps(e.output)[:80]}{R}")
        out()

    # Errors
    errors = [e for e in art.events if e.error]
    if errors:
        section(f"ERRORS  {err(str(len(errors)))}")
        for e in errors:
            out(f"  seq {acc(str(e.seq))}  {icon(e.type)} {bold(e.action)}")
            out(f"  {err('↳ '+e.error['message'])}")
            out()

# ── diff ───────────────────────────────────────────────────────────────────────

def cmd_diff(path_a: str, path_b: str, show_fields: bool = False):
    logo()
    a = load(path_a)
    b = load(path_b)
    result = run_diff(a, b)

    section("RUN DIFF")
    out(f"  {RED}−{R}  {dim('run_a')}  {acc(a.run_id)}  {dim(a.agent_id)}")
    out(f"  {GRN}+{R}  {dim('run_b')}  {acc(b.run_id)}  {dim(b.agent_id)}")
    out()

    if result.identical:
        out(f"  {ok('✓ runs are identical')}  {a.event_count} events")
        out()
        return

    if result.diverges_at is not None:
        out(f"  {YLW}⚡ diverges at seq {result.diverges_at}{R}")
        out()

    section("CHANGES")

    if result.modified:
        out(f"  {YLW}~ {len(result.modified)} modified{R}")
        out()
        for mod in result.modified:
            ea, eb = a.events[mod["seq"]], b.events[mod["seq"]]
            seq = str(mod["seq"]).zfill(4)
            out(f"  {RED}−{R} {GRY}{seq}{R}  {icon(ea.type)} {col(ea.type)+ea.type.ljust(14)+R}  {bold(ea.action)}")
            out(f"  {GRN}+{R} {GRY}{seq}{R}  {icon(eb.type)} {col(eb.type)+eb.type.ljust(14)+R}  {bold(eb.action)}")
            if show_fields:
                for f in mod["fields"]:
                    va = json.dumps(getattr(ea, f, None))[:80]
                    vb = json.dumps(getattr(eb, f, None))[:80]
                    out(f"       {dim(f.ljust(14))}")
                    out(f"       {RED}−  {va}{R}")
                    out(f"       {GRN}+  {vb}{R}")
            else:
                out(f"  {dim('  changed: '+', '.join(mod['fields']))}")
            out()

    if result.removed:
        out(f"  {err(f'- {len(result.removed)} removed')}")
        for e in result.removed:
            out(f"  {RED}−{R} {GRY}{str(e.seq).zfill(4)}{R}  {icon(e.type)} {col(e.type)+e.type.ljust(14)+R}  {bold(e.action)}")
        out()

    if result.added:
        out(f"  {ok(f'+ {len(result.added)} added')}")
        for e in result.added:
            out(f"  {GRN}+{R} {GRY}{str(e.seq).zfill(4)}{R}  {icon(e.type)} {col(e.type)+e.type.ljust(14)+R}  {bold(e.action)}")
        out()

    out(ln())
    out()
    out(f"  {dim('modified')}  {YLW}{len(result.modified)}{R}")
    out(f"  {dim('removed ')}  {RED}{len(result.removed)}{R}")
    out(f"  {dim('added   ')}  {GRN}{len(result.added)}{R}")
    out()

# ── replay ─────────────────────────────────────────────────────────────────────

def cmd_replay(path: str, auto: bool = False, speed: int = 300):
    logo()
    art = load(path)

    if not auto:
        # Interactive mode using curses
        try:
            import curses
            _replay_interactive(art)
        except Exception:
            auto = True  # fallback

    if auto:
        section("REPLAY — auto")
        out(f"  {dim('speed')}  {speed}ms/event")
        out()
        for frame in replay(art):
            e = frame.event
            seq = str(e.seq).zfill(4)
            typ = col(e.type)+e.type.ljust(14)+R
            hsh = GRY+e.hash[:12]+"…"+R
            ch  = dim("⛓") if frame.chain_valid else err("⛓✗")
            hv  = dim("◈") if frame.hash_valid  else err("◈✗")
            out(f"  {GRY}{seq}{R}  {icon(e.type)} {typ}  {bold(e.action)}  {ms(e.duration_ms)}  {hsh}  {ch}{hv}")
            time.sleep(speed/1000)
        out()
        out(f"  {ok('✓ replay complete')}  {art.event_count} events")
        out()

def _replay_interactive(art: BlackboxArtifact):
    import curses

    events = art.events
    total  = len(events)
    seq    = [0]

    def draw(stdscr):
        curses.curs_set(0)
        curses.start_color()
        curses.use_default_colors()
        curses.init_pair(1, curses.COLOR_GREEN,   -1)
        curses.init_pair(2, curses.COLOR_RED,     -1)
        curses.init_pair(3, curses.COLOR_YELLOW,  -1)
        curses.init_pair(4, curses.COLOR_CYAN,    -1)
        curses.init_pair(5, curses.COLOR_MAGENTA, -1)
        curses.init_pair(6, curses.COLOR_BLUE,    -1)

        while True:
            stdscr.clear()
            h, w = stdscr.getmaxyx()
            e = events[seq[0]]

            # Header
            header = f" ◼ blackbox  replay  {seq[0]+1}/{total} "
            stdscr.addstr(0, 0, header.ljust(w), curses.A_REVERSE)

            # Timeline bar
            bar_row = 1
            stdscr.addstr(bar_row, 2, "")
            for i, ev in enumerate(events):
                ch = "▮" if i == seq[0] else ("·" if i < seq[0] else " ")
                try:
                    stdscr.addstr(bar_row, 2+i*2, ch,
                        curses.color_pair(1) if i == seq[0] else curses.A_DIM)
                except: pass

            row = 3

            # Event header
            icon_ch, _ = EVENT_STYLE.get(e.type, ("·", ""))
            title = f" {icon_ch} {e.type}  {e.action} "
            try: stdscr.addstr(row, 2, title, curses.A_BOLD)
            except: pass
            row += 1

            progress = f" seq {e.seq} / {total-1}  {e.duration_ms or 0}ms "
            try: stdscr.addstr(row, 2, progress, curses.A_DIM)
            except: pass
            row += 2

            # Fields
            fields = [
                ("id",         e.id),
                ("run_id",     e.run_id),
                ("timestamp",  e.timestamp[:19].replace("T"," ")),
                ("agent",      e.agent_id),
            ]
            for k, v in fields:
                try:
                    stdscr.addstr(row, 4, k.ljust(12), curses.A_DIM)
                    stdscr.addstr(row, 18, str(v)[:w-20], curses.color_pair(4))
                except: pass
                row += 1

            row += 1

            # Input
            try: stdscr.addstr(row, 4, "INPUT", curses.A_BOLD | curses.color_pair(6))
            except: pass
            row += 1
            inp = json.dumps(e.input, indent=2) if e.input else "∅"
            for line in inp.split("\n")[:6]:
                try: stdscr.addstr(row, 6, line[:w-8], curses.A_DIM)
                except: pass
                row += 1

            row += 1

            # Output
            try: stdscr.addstr(row, 4, "OUTPUT", curses.A_BOLD | curses.color_pair(1))
            except: pass
            row += 1
            outp = json.dumps(e.output, indent=2) if e.output else "∅"
            for line in outp.split("\n")[:6]:
                try: stdscr.addstr(row, 6, line[:w-8], curses.A_DIM)
                except: pass
                row += 1

            row += 1

            # Chain
            try: stdscr.addstr(row, 4, "CHAIN", curses.A_BOLD)
            except: pass
            row += 1
            try:
                stdscr.addstr(row, 6, f"prev  {e.prev_hash[:32]}…", curses.A_DIM)
                row += 1
                stdscr.addstr(row, 6, f"hash  {e.hash[:32]}…", curses.A_DIM)
            except: pass
            row += 2

            # Error
            if e.error:
                try:
                    stdscr.addstr(row, 4, f"ERROR: {e.error['message'][:w-12]}",
                                  curses.color_pair(2) | curses.A_BOLD)
                except: pass
                row += 1

            # Controls
            ctrl = " [←][→] navigate   [q] quit   [v] verify "
            try: stdscr.addstr(h-1, 0, ctrl.ljust(w), curses.A_REVERSE)
            except: pass

            stdscr.refresh()

            key = stdscr.getch()
            if key in (curses.KEY_RIGHT, ord("l")):
                if seq[0] < total - 1: seq[0] += 1
            elif key in (curses.KEY_LEFT, ord("h")):
                if seq[0] > 0: seq[0] -= 1
            elif key == ord("v"):
                result = verify(art)
                msg = f" ✓ verified — {result.events_checked} events " if result.valid \
                      else f" ✗ TAMPERED at seq {result.at_seq} "
                try: stdscr.addstr(h-2, 2, msg, curses.A_BOLD)
                except: pass
                stdscr.refresh()
                time.sleep(1.5)
            elif key in (ord("q"), 27, 3):
                break

    curses.wrapper(draw)

# ── main ───────────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    cmd  = args[0] if args else "help"

    def flag(n): return f"--{n}" in args or f"-{n[0]}" in args
    def opt(n):
        i = args.index(f"--{n}") if f"--{n}" in args else -1
        return args[i+1] if i != -1 and i+1 < len(args) else None

    if cmd == "verify":
        if len(args) < 2: print(err("✗ usage: blackbox-py verify <file.blackbox>")); sys.exit(1)
        cmd_verify(args[1], verbose=flag("verbose"), events=flag("events"))

    elif cmd == "inspect":
        if len(args) < 2: print(err("✗ usage: blackbox-py inspect <file.blackbox>")); sys.exit(1)
        cmd_inspect(args[1])

    elif cmd == "replay":
        if len(args) < 2: print(err("✗ usage: blackbox-py replay <file.blackbox>")); sys.exit(1)
        cmd_replay(args[1], auto=flag("auto"), speed=int(opt("speed") or 300))

    elif cmd == "diff":
        if len(args) < 3: print(err("✗ usage: blackbox-py diff <a.blackbox> <b.blackbox>")); sys.exit(1)
        cmd_diff(args[1], args[2], show_fields=flag("fields"))

    elif cmd == "demo":
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from demo import main as demo_main
        demo_main()

    else:
        logo()
        out(f"  {B}COMMANDS{R}")
        out()
        cmds = [
            ("verify  <file>",           "verify chain integrity"),
            ("inspect <file>",           "full run analysis"),
            ("replay  <file>",           "interactive step-through"),
            ("diff    <a> <b>",          "compare two runs"),
            ("demo",                     "generate demo artifact"),
        ]
        for c, d in cmds:
            out(f"  {acc(c.ljust(26))}  {dim(d)}")
        out()

if __name__ == "__main__":
    main()

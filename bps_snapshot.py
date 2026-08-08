#!/usr/bin/env python3
"""
Build and refresh the static data snapshot the published site runs on.

The GitHub Pages build must work with no server and no key, so the data it
charts is fetched here -- locally, or by .github/workflows/snapshot.yml -- and
committed as plain JSON under `docs/data/`:

    docs/data/index.json       catalogue of all 37 subjects (small; loaded first)
    docs/data/subject<ID>.json the variables of one subject (loaded on demand)
    docs/data/var<ID>.json     one cube per variable

Covering all of BPS is ~3,200 variables, so a nightly job never rebuilds
everything. In `--refresh` mode each known variable is checked with a partial
read of its `last_update` (a few KB) and re-downloaded only when BPS actually
revised it; variables that are new are always fetched. A run that hits
`--budget-min` stops cleanly and the next one picks up where it left off, so
the first full fill can spread over a few nights.

    python bps_snapshot.py --all --refresh          # the nightly job
    python bps_snapshot.py --all --budget-min 30    # bounded first fill
    python bps_snapshot.py --subject 530 531        # just these
    python bps_snapshot.py --subject 531 --th all   # every period, not just latest

Nothing is written when nothing changed, so the repository gets a commit only
on days BPS actually published something. Python 3 standard library only.
"""

import argparse
import datetime
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import bps_api as api

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, "docs", "data")
DEFAULT_MAX_KB = 900

_print_lock = threading.Lock()


def say(msg):
    with _print_lock:
        print(msg, flush=True)


def round_cube(cube, places=4):
    """Trim float noise before it is committed -- 1234.5600000000001 costs
    bytes in git forever and BPS never publishes that precision."""
    for plane in cube["values"]:
        for row in plane:
            for i, v in enumerate(row):
                if v is not None:
                    r = round(v, places)
                    row[i] = int(r) if r == int(r) and abs(r) < 1e15 else r
    return cube


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_if_changed(path, obj):
    """Write only when the bytes differ, so untouched data keeps its git blob
    and the nightly job produces an empty diff on quiet days."""
    blob = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    old = None
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                old = f.read()
        except OSError:
            old = None
    if old == blob:
        return False, len(blob.encode("utf-8"))
    with open(path, "w", encoding="utf-8") as f:
        f.write(blob)
    return True, len(blob.encode("utf-8"))


class Budget:
    def __init__(self, minutes):
        self.deadline = time.time() + minutes * 60 if minutes else None
        self.hit = False

    def spent(self):
        if self.deadline and time.time() > self.deadline:
            self.hit = True
        return self.hit


def process_var(v, prev, args, budget):
    """One variable -> (status, entry). Statuses: kept, written, empty, error,
    skipped-big, budget."""
    var = str(v["var_id"])
    fname = f"var{var}.json"
    path = os.path.join(DATA_DIR, fname)

    if budget.spent():
        return ("budget", prev if prev and os.path.exists(path) else None)

    # Cheap check first: if BPS has not revised it, keep the committed cube.
    if args.refresh and prev and prev.get("th") and os.path.exists(path):
        try:
            when = api.fetch_last_update(var, prev["th"])
        except Exception:
            when = None
        if when and when == prev.get("last_update"):
            return ("kept", prev)

    try:
        years = api.get_years(var)
        if not years:
            return ("empty", None)
        ths = [str(y["th_id"]) for y in years] if args.th == "all" \
            else [str(years[-1]["th_id"])]
        cube = api.get_cube(var, ths)
        if not cube.get("time"):
            return ("empty", None)
        round_cube(cube)
    except Exception as e:
        say(f"    var {var}: {e}")
        return ("error", prev if prev and os.path.exists(path) else None)

    blob_kb = len(json.dumps(cube, ensure_ascii=False,
                             separators=(",", ":")).encode("utf-8")) / 1024
    if blob_kb > args.max_kb:
        return ("skipped-big", None)

    changed, size = write_if_changed(path, cube)
    entry = {"var_id": var, "title": cube["title"] or v["title"],
             "unit": cube["unit"], "file": fname,
             "periods": len(cube["time"]),
             "last_update": cube.get("last_update") or "",
             "th": ths[-1], "kb": round(size / 1024, 1)}
    return ("written" if changed else "kept", entry)


def main():
    ap = argparse.ArgumentParser(description="Build the static snapshot for GitHub Pages.")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--subject", nargs="+", help="subject id(s) to snapshot")
    src.add_argument("--all", action="store_true", help="every BPS subject")
    ap.add_argument("--th", default="latest", choices=["latest", "all"])
    ap.add_argument("--limit", type=int, default=0, help="max variables per subject")
    ap.add_argument("--max-kb", type=int, default=DEFAULT_MAX_KB,
                    help=f"skip cubes larger than this (default {DEFAULT_MAX_KB} KB)")
    ap.add_argument("--refresh", action="store_true",
                    help="re-download only variables BPS has revised")
    ap.add_argument("--workers", type=int, default=6, help="parallel requests")
    ap.add_argument("--budget-min", type=float, default=0,
                    help="stop starting new work after this many minutes")
    ap.add_argument("--keep", action="store_true", help="keep unreferenced cube files")
    ap.add_argument("--domain", default="0000")
    ap.add_argument("--lang", default="ind")
    args = ap.parse_args()

    api.SETTINGS["domain"] = args.domain
    api.SETTINGS["lang"] = args.lang
    if args.refresh:
        api.CACHE_TTL = 0          # a refresh must not read yesterday's cache
    if not api.load_key():
        sys.exit("No API key: put it in .bps_key next to this script "
                 "(in CI, write the BPS_KEY secret to that file).")

    os.makedirs(DATA_DIR, exist_ok=True)
    started = time.time()
    budget = Budget(args.budget_min)

    all_subjects = api.get_subjects()
    by_id = {str(s["id"]): s for s in all_subjects}
    targets = [str(s["id"]) for s in all_subjects] if args.all \
        else [str(x) for x in args.subject]
    targets = [t for t in targets if t in by_id]

    prev_index = read_json(os.path.join(DATA_DIR, "index.json"), {}) or {}
    prev_counts = {str(s["id"]): s.get("count", 0)
                   for s in (prev_index.get("subjects") or [])}

    # Subjects already filled are refreshed after the untouched ones, so a
    # budgeted first fill reaches new ground every night.
    targets.sort(key=lambda sid: (prev_counts.get(sid, 0) > 0, sid))

    catalogs, changed_files, stats = {}, 0, {}
    for pos, sid in enumerate(targets, 1):
        subj = by_id[sid]
        cat_path = os.path.join(DATA_DIR, f"subject{sid}.json")
        prev_entries = {e["var_id"]: e for e in (read_json(cat_path, []) or [])}

        if budget.spent():
            if prev_entries:
                catalogs[sid] = list(prev_entries.values())
            continue

        try:
            variables = api.get_vars(sid)
        except Exception as e:
            say(f"[{pos}/{len(targets)}] subject {sid}: {e}")
            if prev_entries:
                catalogs[sid] = list(prev_entries.values())
            continue
        if args.limit:
            variables = variables[:args.limit]

        say(f"[{pos}/{len(targets)}] subject {sid} — {subj['title']}: "
            f"{len(variables)} variables")

        counts = {}
        entries = []
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            results = pool.map(
                lambda v: process_var(v, prev_entries.get(str(v["var_id"])), args, budget),
                variables)
            for status, entry in results:
                counts[status] = counts.get(status, 0) + 1
                if entry:
                    entries.append(entry)
                if status == "written":
                    changed_files += 1
        for k, n in counts.items():
            stats[k] = stats.get(k, 0) + n
        entries.sort(key=lambda e: int(e["var_id"]) if e["var_id"].isdigit() else 0)
        if entries:
            catalogs[sid] = entries
            if write_if_changed(cat_path, entries)[0]:
                changed_files += 1
        say("    " + ", ".join(f"{k}={n}" for k, n in sorted(counts.items())) +
            f"  ({len(entries)} in catalogue)")
        if budget.spent():
            say(f"    budget of {args.budget_min} min reached — stopping here; "
                "the next run continues.")

    # subjects not touched this run keep whatever they already had
    for sid in by_id:
        if sid not in catalogs:
            prev = read_json(os.path.join(DATA_DIR, f"subject{sid}.json"), None)
            if prev:
                catalogs[sid] = prev

    subjects = []
    for s in all_subjects:
        sid = str(s["id"])
        subjects.append({"id": sid, "title": s["title"], "subcat": s["subcat"],
                         "ntabel": s.get("ntabel"),
                         "count": len(catalogs.get(sid, [])),
                         "file": f"subject{sid}.json" if catalogs.get(sid) else None})
    subjects.sort(key=lambda s: (s["subcat"] or "", s["id"]))

    index = {
        "subjects": subjects,
        "variable_count": sum(len(v) for v in catalogs.values()),
        "total_variables": sum(int(s.get("ntabel") or 0) for s in all_subjects),
        "th": args.th, "domain": args.domain, "lang": args.lang,
        "note": "Snapshot for the GitHub Pages build, refreshed daily. Enter a "
                "BPS API key in the app for everything, always current.",
    }
    # `generated` marks when the DATA last changed, not when the job last ran,
    # so a quiet night produces no commit at all.
    prev_body = dict(prev_index)
    prev_gen = prev_body.pop("generated", None)
    if changed_files == 0 and prev_body == index and prev_gen:
        index["generated"] = prev_gen
    else:
        index["generated"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    if write_if_changed(os.path.join(DATA_DIR, "index.json"), index)[0]:
        changed_files += 1

    removed = 0
    if not args.keep:
        keep = {"index.json"}
        for sid, entries in catalogs.items():
            keep.add(f"subject{sid}.json")
            for e in entries:
                keep.add(e["file"])
        for fn in os.listdir(DATA_DIR):
            if fn.endswith(".json") and fn not in keep:
                os.remove(os.path.join(DATA_DIR, fn))
                removed += 1
    if removed:
        say(f"removed {removed} unreferenced file(s)")

    size = sum(os.path.getsize(os.path.join(DATA_DIR, f))
               for f in os.listdir(DATA_DIR)) / 1024
    mins = (time.time() - started) / 60
    say(f"\nSnapshot: {index['variable_count']} variables across "
        f"{sum(1 for s in subjects if s['count'])} of {len(subjects)} subjects, "
        f"{size / 1024:.1f} MB in docs/data/  ({mins:.1f} min)")
    say("this run: " + (", ".join(f"{k}={n}" for k, n in sorted(stats.items())) or "nothing")
        + f"; files changed: {changed_files}")
    if budget.hit:
        say("budget reached — rerun (or wait for the nightly job) to continue.")


if __name__ == "__main__":
    main()

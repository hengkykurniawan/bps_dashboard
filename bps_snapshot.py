#!/usr/bin/env python3
"""
Build the static data snapshot the published site runs on.

The GitHub Pages build has no server and must never hold the BPS API key, so
the data it charts is fetched here (with the key, locally or in CI) and
committed as plain JSON under `docs/data/`:

    docs/data/index.json    the catalogue: subjects, variables, file names
    docs/data/var<ID>.json  one cube per variable

The browser then does everything else -- docs/infer.js picks the chart from the
cube exactly as it does for the live service, so the online site and the local
app behave identically. Anything not snapshotted stays available by running
`python bps_dashboard.py` locally.

    python bps_snapshot.py --subject 530 531
    python bps_snapshot.py --subject 531 --limit 20 --th all
    python bps_snapshot.py --subject 531 --max-kb 400   # skip huge cubes

Re-running rewrites the snapshot: cubes no longer referenced are removed unless
--keep is given. Python 3 standard library only.
"""

import argparse
import datetime
import json
import os
import sys

import bps_api as api

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, "docs", "data")
DEFAULT_MAX_KB = 900


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


def fetch_cube(var, th):
    cube = api.get_cube(var, th)
    if not cube.get("time"):
        return None
    return round_cube(cube)


def main():
    ap = argparse.ArgumentParser(description="Build the static snapshot for GitHub Pages.")
    ap.add_argument("--subject", nargs="+", required=True,
                    help="subject id(s) to snapshot (e.g. 530 531)")
    ap.add_argument("--th", default="latest", choices=["latest", "all"],
                    help="'latest' period only (default) or every period")
    ap.add_argument("--limit", type=int, default=0,
                    help="max variables per subject (0 = all)")
    ap.add_argument("--max-kb", type=int, default=DEFAULT_MAX_KB,
                    help=f"skip cubes larger than this (default {DEFAULT_MAX_KB} KB)")
    ap.add_argument("--keep", action="store_true",
                    help="keep cube files that are no longer referenced")
    ap.add_argument("--domain", default="0000")
    ap.add_argument("--lang", default="ind")
    args = ap.parse_args()

    api.SETTINGS["domain"] = args.domain
    api.SETTINGS["lang"] = args.lang
    if not api.load_key():
        sys.exit("No API key: put it in .bps_key next to this script "
                 "(in CI, write the BPS_KEY secret to that file).")

    os.makedirs(DATA_DIR, exist_ok=True)
    all_subjects = {str(s["id"]): s for s in api.get_subjects()}
    total_variables = sum(int(s.get("ntabel") or 0) for s in all_subjects.values())

    # Merge with whatever is already snapshotted, so subjects can be added one
    # run at a time without wiping the previous ones.
    index_path = os.path.join(DATA_DIR, "index.json")
    prev = {}
    if os.path.exists(index_path):
        try:
            with open(index_path, encoding="utf-8") as f:
                prev = json.load(f)
        except (OSError, ValueError):
            prev = {}
    catalog = dict(prev.get("vars") or {})
    for sid in list(catalog):
        if str(sid) in {str(x) for x in args.subject}:
            catalog.pop(sid)

    # Every BPS subject is listed, not just the snapshotted ones, so the page
    # shows the same catalogue as the BPS site; subjects without cubes are
    # marked in the UI and open with a key.
    subjects = [{"id": str(s["id"]), "title": s["title"], "subcat": s["subcat"],
                 "ntabel": s.get("ntabel")}
                for s in all_subjects.values()]
    updates = dict(prev.get("updates") or {})
    written, skipped = [], []
    for sid in args.subject:
        sid = str(sid)
        subj = all_subjects.get(sid)
        if not subj:
            print(f"subject {sid}: not found, skipped")
            continue
        variables = api.get_vars(sid)
        if args.limit:
            variables = variables[:args.limit]
        print(f"\nsubject {sid} — {subj['title']}: {len(variables)} variables")
        entries = []
        for i, v in enumerate(variables, 1):
            var = str(v["var_id"])
            try:
                cube = fetch_cube(var, args.th)
            except Exception as e:
                print(f"  [{i}/{len(variables)}] var {var}: {e}")
                skipped.append((var, str(e)))
                continue
            if not cube:
                print(f"  [{i}/{len(variables)}] var {var}: no data, skipped")
                skipped.append((var, "no data"))
                continue
            blob = json.dumps(cube, ensure_ascii=False, separators=(",", ":"))
            kb = len(blob.encode("utf-8")) / 1024
            if kb > args.max_kb:
                print(f"  [{i}/{len(variables)}] var {var}: {kb:.0f} KB > "
                      f"{args.max_kb} KB, skipped")
                skipped.append((var, f"{kb:.0f} KB"))
                continue
            fname = f"var{var}.json"
            with open(os.path.join(DATA_DIR, fname), "w", encoding="utf-8") as f:
                f.write(blob)
            entries.append({"var_id": var, "title": cube["title"] or v["title"],
                            "unit": cube["unit"], "file": fname,
                            "periods": len(cube["time"]),
                            "last_update": cube.get("last_update") or ""})
            if cube.get("last_update"):
                updates[var] = cube["last_update"]
            written.append(fname)
            n_cells = len(cube["vervar"]) * len(cube["turvar"]) * len(cube["time"])
            print(f"  [{i}/{len(variables)}] var {var}: {kb:6.0f} KB  "
                  f"{n_cells:>7,} cells  {cube['title'][:46]}")
        if entries:
            catalog[sid] = entries

    if not written and not catalog:
        sys.exit("\nNothing snapshotted; index left unchanged.")

    subjects.sort(key=lambda s: (s["subcat"] or "", str(s["id"])))
    index = {
        "generated": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "th": args.th, "domain": args.domain, "lang": args.lang,
        "subjects": subjects, "vars": catalog,
        "updates": {k: v for k, v in updates.items()
                    if any(e["var_id"] == k for es in catalog.values() for e in es)},
        "variable_count": sum(len(v) for v in catalog.values()),
        "total_variables": total_variables,
        "note": "Snapshot for the GitHub Pages build. Run bps_dashboard.py "
                "locally for every BPS variable and period.",
    }
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    if not args.keep:
        keep = {"index.json"}
        for entries in catalog.values():
            for e in entries:
                keep.add(e["file"])
        for fn in os.listdir(DATA_DIR):
            if fn.endswith(".json") and fn not in keep:
                os.remove(os.path.join(DATA_DIR, fn))
                print(f"removed stale {fn}")

    size = sum(os.path.getsize(os.path.join(DATA_DIR, f))
               for f in os.listdir(DATA_DIR)) / 1024
    print(f"\nSnapshot: {index['variable_count']} variables across "
          f"{len(subjects)} subjects ({len(written)} written this run), "
          f"{size:.0f} KB total in docs/data/")
    if skipped:
        print(f"skipped {len(skipped)}: " +
              ", ".join(f"{v} ({why})" for v, why in skipped[:8]) +
              (" …" if len(skipped) > 8 else ""))


if __name__ == "__main__":
    main()

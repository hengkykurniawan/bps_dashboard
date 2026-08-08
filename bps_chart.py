#!/usr/bin/env python3
"""
BPS data -> chart, from the command line.

Same drill-down as bps_data.py in the bps_download repo, but the export is a
self-contained HTML chart (or an SVG-ready spec) instead of a table.

  # 0) discovery -- identical to bps_data.py
  python bps_chart.py subjects
  python bps_chart.py vars --subject 531
  python bps_chart.py years --var 2776

  # 1) one variable -> one chart (type chosen from the data's structure)
  python bps_chart.py chart --var 2776 --th all
  python bps_chart.py chart --var 2534 --th latest --out pdrb.html
  python bps_chart.py chart --file data_var1161.csv --chart hbar --top 34

  # 2) a whole subject -> one HTML report, one chart per variable
  python bps_chart.py report --subject 531 --limit 12 --out neraca.html

  # 3) the numbers behind the chart, as tidy CSV (same columns as bps_data.py)
  python bps_chart.py get --var 2776 --th all

Overrides: --chart, --x, --series, --pick-vervar/--pick-turvar/--pick-time,
--top, --sort. `--json` prints the chart spec instead of writing HTML.

Python 3 standard library only; the HTML has no external dependencies.
"""

import argparse
import html as html_mod
import json
import os
import sys

import bps_api as api

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(SCRIPT_DIR, "docs")


# ----------------------------------------------------------------- page

def _asset(name):
    with open(os.path.join(DOCS, name), encoding="utf-8") as f:
        return f.read()


PAGE = """<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>{css}
body {{ padding: 24px 20px 60px; }}
main {{ max-width: 1000px; margin: 0 auto; }}
h1 {{ font-size: 20px; margin: 0 0 4px; }}
.src {{ color: var(--text-secondary); font-size: 12px; margin: 0 0 22px; }}
details {{ margin-top: 10px; }}
summary {{ cursor: pointer; color: var(--text-secondary); font-size: 12px; }}
</style></head>
<body><main>
<h1>{heading}</h1>
<p class="src">Sumber: BPS WebAPI (webapi.bps.go.id) &middot; dibuat dengan bps_dashboard</p>
<div id="root"></div>
</main>
<script>{infer}</script>
<script>{charts}</script>
<script>
// The cubes travel with the page and the chart type is decided here, by the
// same code the app and the published site use.
var CUBES = {cubes}, OPTS = {opts};
var root = document.getElementById("root");
CUBES.forEach(function (cube) {{
  var spec = BPSInfer.buildSpec(cube, OPTS);
  var card = document.createElement("div");
  card.className = "card";
  root.appendChild(card);
  var h = document.createElement("p");
  h.className = "chart-title"; h.textContent = spec.title || "";
  card.appendChild(h);
  var s = document.createElement("p");
  s.className = "chart-sub";
  s.textContent = [spec.subtitle, spec.unit ? "satuan: " + spec.unit : ""]
    .filter(Boolean).join(" \\u00b7 ");
  card.appendChild(s);
  var chips = document.createElement("div");
  chips.className = "chips";
  [spec.chart_label, spec.structure, spec.reason].forEach(function (t, i) {{
    if (!t) return;
    var c = document.createElement("span");
    c.className = i === 0 ? "chip strong" : "chip";
    c.textContent = t; chips.appendChild(c);
  }});
  card.appendChild(chips);
  var plot = document.createElement("div");
  card.appendChild(plot);
  var hidden = new Set();
  function draw() {{
    BPSChart.render(plot, spec, {{ hidden: hidden, onToggle: function (id) {{
      if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
      draw();
    }} }});
  }}
  draw();
  addEventListener("resize", (function () {{
    var t; return function () {{ clearTimeout(t); t = setTimeout(draw, 200); }};
  }})());
  // every chart ships a table twin
  var det = document.createElement("details");
  var sum = document.createElement("summary");
  sum.textContent = "Tabel nilai";
  det.appendChild(sum);
  var wrap = document.createElement("div");
  wrap.className = "table-view";
  var tbl = document.createElement("table");
  var thead = document.createElement("thead");
  var tr = document.createElement("tr");
  var th0 = document.createElement("th"); th0.textContent = spec.x.label; tr.appendChild(th0);
  spec.series.forEach(function (se) {{
    var th = document.createElement("th"); th.textContent = se.label; tr.appendChild(th);
  }});
  thead.appendChild(tr); tbl.appendChild(thead);
  var tb = document.createElement("tbody");
  spec.x.categories.forEach(function (c, i) {{
    var r = document.createElement("tr");
    var td = document.createElement("td"); td.textContent = c.full || c.label; r.appendChild(td);
    spec.series.forEach(function (se) {{
      var d = document.createElement("td");
      d.textContent = BPSChart.fmt(se.values[i]); r.appendChild(d);
    }});
    tb.appendChild(r);
  }});
  tbl.appendChild(tb); wrap.appendChild(tbl); det.appendChild(wrap);
  card.appendChild(det);
}});
</script></body></html>
"""


def write_page(cubes, path, heading, opts=None):
    page = PAGE.format(
        title=html_mod.escape(heading), heading=html_mod.escape(heading),
        css=_asset("styles.css"), infer=_asset("infer.js"),
        charts=_asset("charts.js"),
        cubes=json.dumps(cubes, ensure_ascii=False),
        opts=json.dumps(opts or {}, ensure_ascii=False))
    with open(path, "w", encoding="utf-8") as f:
        f.write(page)
    return path


# ----------------------------------------------------------------- commands

def opts_from_args(args):
    """Chart options in the shape docs/infer.js expects."""
    pick = {}
    for dim in ("vervar", "turvar", "time"):
        v = getattr(args, "pick_" + dim, None)
        if v:
            pick[dim] = v
    return {k: v for k, v in {
        "chart": args.chart, "x": args.x, "series": args.series,
        "top": args.top, "sort": args.sort, "pick": pick or None,
        "includeTotals": getattr(args, "include_totals", False) or None,
    }.items() if v}


def structure_of(cube):
    """Dimension sizes, for the console line. Which chart that shape implies is
    decided by docs/infer.js when the page renders."""
    bits = []
    for key, noun in (("vervar", "entitas"), ("turvar", "kategori"), ("time", "periode")):
        n = len(cube[key])
        if n > 1:
            bits.append(f"{n} {noun}")
    return " x ".join(bits) or "nilai tunggal"


def fetch_var_rows(var, th):
    """Rows for one variable. `th` is 'all', 'latest', or explicit year ids."""
    if th in ("all", "latest", ["all"], ["latest"]):
        years = api.get_years(var)
        if not years:
            return []
        ths = [str(years[-1]["th_id"])] if th in ("latest", ["latest"]) \
            else [str(y["th_id"]) for y in years]
    else:
        ths = [th] if isinstance(th, str) else list(th)
    rows = []
    for t in ths:
        rows += api.decode_rows(api.fetch_data(var, t))
    return rows


def load_rows(args):
    if getattr(args, "file", None):
        path = args.file if os.path.isabs(args.file) else os.path.join(SCRIPT_DIR, args.file)
        return api.read_csv_rows(path), os.path.basename(path)
    ths = args.th
    if ths in (["all"], ["latest"]):
        years = api.get_years(args.var)
        if not years:
            sys.exit(f"No periods found for var {args.var}.")
        ths = [str(years[-1]["th_id"])] if ths == ["latest"] \
            else [str(y["th_id"]) for y in years]
    rows = []
    for th in ths:
        got = api.decode_rows(api.fetch_data(args.var, th))
        print(f"  var {args.var} th {th}: {len(got)} nilai")
        rows += got
    return rows, f"var {args.var}"


def cmd_subjects(args):
    rows = api.get_subjects()
    groups = {}
    for r in rows:
        groups.setdefault(r["subcat"], []).append(r)
    print(f"{len(rows)} subjects (use the number as --subject):\n")
    for cat in sorted(groups):
        print(f"## {cat}")
        for r in sorted(groups[cat], key=lambda x: str(x["id"])):
            print(f"   subject={str(r['id']):<5} {r['title']}")
        print()


def cmd_vars(args):
    rows = api.get_vars(args.subject)
    print(f"{len(rows)} variables under subject {args.subject}:\n")
    for r in rows:
        print(f"  var={str(r['var_id']):<6} {r['title']}  [{r['unit'] or '-'}]")


def cmd_years(args):
    rows = api.get_years(args.var)
    print(f"{len(rows)} periods available for var {args.var}:")
    for r in rows:
        print(f"  th={str(r['th_id']):<5} {r['th']}")


def cmd_chart(args):
    rows, tag = load_rows(args)
    if not rows:
        sys.exit("No data returned; nothing to chart.")
    cube = api.to_cube(rows)
    if args.json:
        print(json.dumps(cube, ensure_ascii=False, indent=2))
        return
    print(f"\n  struktur : {structure_of(cube)}")
    out = args.out or f"chart_{api.sanitize(cube['title'] or tag, 50)}.html"
    path = out if os.path.isabs(out) else os.path.join(args.dir, out)
    write_page([cube], path, cube["title"] or tag, opts_from_args(args))
    print(f"  grafik   : dipilih otomatis saat halaman dibuka (docs/infer.js)")
    print(f"\nWrote {path}  ({os.path.getsize(path) / 1024:.0f} KB)")


def cmd_report(args):
    variables = api.get_vars(args.subject)
    if args.limit:
        variables = variables[:args.limit]
    print(f"{len(variables)} variables in subject {args.subject}")
    cubes = []
    for i, v in enumerate(variables, 1):
        try:
            rows = fetch_var_rows(v["var_id"], args.th)
            if not rows:
                print(f"  [{i}/{len(variables)}] var {v['var_id']}: no data, skipped")
                continue
            cube = api.to_cube(rows)
            cubes.append(cube)
            print(f"  [{i}/{len(variables)}] var {v['var_id']}: {structure_of(cube)}")
        except Exception as e:                       # one bad variable must not
            print(f"  [{i}/{len(variables)}] var {v['var_id']}: {e}")   # kill the report
    if not cubes:
        sys.exit("Nothing to report.")
    subj = next((s["title"] for s in api.get_subjects()
                 if str(s["id"]) == str(args.subject)), f"Subjek {args.subject}")
    out = args.out or f"report_subject{args.subject}.html"
    path = out if os.path.isabs(out) else os.path.join(args.dir, out)
    write_page(cubes, path, f"{subj} — {len(cubes)} grafik", opts_from_args(args))
    print(f"\nWrote {len(cubes)} charts -> {path}  ({os.path.getsize(path) / 1024:.0f} KB)")


def cmd_get(args):
    rows, tag = load_rows(args)
    if not rows:
        sys.exit("Nothing to write.")
    out = args.out or (f"data_var{args.var}.csv" if args.var else "data.csv")
    path = out if os.path.isabs(out) else os.path.join(args.dir, out)
    path = api.write_csv(rows, path, args.gzip)
    print(f"\nWrote {len(rows)} rows -> {path}  ({os.path.getsize(path) / 1024:.0f} KB)")


def add_chart_opts(p):
    p.add_argument("--chart", help="force a chart type (line, bar, hbar, "
                                   "stacked_bar, stacked_area, heatmap, donut, ...)")
    p.add_argument("--x", choices=["time", "vervar", "turvar"], help="x-axis dimension")
    p.add_argument("--series", choices=["time", "vervar", "turvar", "none"],
                   help="dimension mapped to colour")
    p.add_argument("--pick-vervar", help="hold the entity dimension at this id")
    p.add_argument("--pick-turvar", help="hold the category dimension at this id")
    p.add_argument("--pick-time", help="hold the period dimension at this id")
    p.add_argument("--top", type=int, help="max categories on ranked charts")
    p.add_argument("--sort", choices=["value", "natural"])
    p.add_argument("--include-totals", action="store_true",
                   help="keep roll-up members such as INDONESIA / Jumlah / PDRB "
                        "(dropped by default so they are not double-counted)")


def main():
    ap = argparse.ArgumentParser(
        description="BPS dynamic data -> charts.",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--domain", default="0000")
    ap.add_argument("--lang", default="ind")
    ap.add_argument("--dir", default=SCRIPT_DIR, help="output folder")
    ap.add_argument("--key")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("subjects", help="list all website subject ids")

    pv = sub.add_parser("vars", help="list variables under a subject id")
    pv.add_argument("--subject", required=True)

    py = sub.add_parser("years", help="list available periods for a variable")
    py.add_argument("--var", required=True)

    pc = sub.add_parser("chart", help="render one variable as an HTML chart")
    src = pc.add_mutually_exclusive_group(required=True)
    src.add_argument("--var", help="variable id")
    src.add_argument("--file", help="tidy CSV written by this repo or bps_download")
    pc.add_argument("--th", nargs="+", default=["all"],
                    help="year id(s), 'all' (default), or 'latest'")
    pc.add_argument("--out", help="output .html file")
    pc.add_argument("--json", action="store_true",
                    help="print the data cube instead of writing HTML")
    add_chart_opts(pc)

    pr = sub.add_parser("report", help="one HTML report for a whole subject")
    pr.add_argument("--subject", required=True)
    pr.add_argument("--limit", type=int, default=12)
    pr.add_argument("--th", default="latest", choices=["latest", "all"])
    pr.add_argument("--out")
    add_chart_opts(pr)

    pg = sub.add_parser("get", help="tidy CSV of the numbers behind the chart")
    gsrc = pg.add_mutually_exclusive_group(required=True)
    gsrc.add_argument("--var")
    gsrc.add_argument("--file")
    pg.add_argument("--th", nargs="+", default=["all"])
    pg.add_argument("--gzip", action="store_true")
    pg.add_argument("--out")

    args = ap.parse_args()
    api.SETTINGS["domain"] = args.domain
    api.SETTINGS["lang"] = args.lang
    if args.key:
        api.save_key(args.key)
    if not getattr(args, "file", None) and not api.load_key():
        sys.exit("No API key: put it in .bps_key next to this script or pass --key.")

    {"subjects": cmd_subjects, "vars": cmd_vars, "years": cmd_years,
     "chart": cmd_chart, "report": cmd_report, "get": cmd_get}[args.cmd](args)


if __name__ == "__main__":
    main()

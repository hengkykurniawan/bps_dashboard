#!/usr/bin/env python3
"""
Chart inference for BPS dynamic data.

Every BPS variable arrives as the same tidy long table (see bps_api.CSV_COLS),
but the *shape* differs per variable: how many entities (vervar), how many
sub-categories (turvar), and how many time points (year x period). That shape
decides the chart -- this module makes the decision explicit and returns a
renderer-agnostic chart spec that docs/charts.js draws.

    rows  ->  summarize()   ->  dimensions (+ sizes, totals, magnitudes)
          ->  build_spec()  ->  {chart, x, series, color, reason, alternatives}

The decision table (after role assignment and filtering):

    x = time      1 series, >=3 points ........ line
                  1 series, <=2 points ........ bar
                  2-8 series, parts of a whole  stacked area / stacked bar
                  2-8 series, otherwise ....... multi-line
                  9-16 series ................. small multiples
                  >16 series .................. heatmap (time x entity)

    x = category  1 series, values cross zero .. diverging bar
                  1 series, <=8 categories .... bar (column)
                  1 series, >8 categories ..... ranked horizontal bar
                  2-8 series, parts of a whole  stacked bar (100% if shares)
                  2-4 series, otherwise ....... grouped bar
                  >8 series ................... heatmap

Never more than 8 colour slots: past that the form changes (small multiples or
heatmap) instead of inventing hues.
"""

import re

# Labels BPS uses for a roll-up member. These are excluded from stacks and
# part-to-whole forms (stacking a total on top of its own parts double-counts).
_TOTAL_RE = re.compile(
    r"^(jumlah|total|jumlah/total|indonesia|nasional|seluruh|semua|"
    r"jumlah total|total keseluruhan|rata-rata|kumulatif|"
    r"jan\s*-\s*des|januari\s*-\s*desember|tahunan)\b", re.I)

# Units/titles whose values must never be summed or stacked: rates, indices,
# ratios and per-capita figures are not additive across regions or categories.
_NON_ADDITIVE_RE = re.compile(
    r"(persen|percent|%|indeks|index|rasio|ratio|rata-rata|average|"
    r"laju|pertumbuhan|growth|tingkat|per\s|/\s*orang|per kapita|per capita|"
    r"jiwa/km|poin|angka harapan|umur)", re.I)

_DEGENERATE_RE = re.compile(r"^(tidak ada|-|n/a|none)$", re.I)

MAX_SERIES = 8          # categorical colour slots; past this the form changes
SMALL_MULTIPLES_MAX = 16
DEFAULT_TOP = 20        # ranked bars: rows shown before truncation
HEATMAP_MAX_ROWS = 40
HEATMAP_MAX_COLS = 60

DIM_LABELS = {"vervar": "Wilayah / entitas", "turvar": "Kategori",
              "time": "Periode"}


# ----------------------------------------------------------------- helpers

def to_num(v):
    """BPS values arrive as numbers, numeric strings, or blanks/dashes."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", ".")
    if not s or s in {"-", "--", "...", "…", "NA", "N/A"}:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _int(v, default=0):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def is_total_label(label):
    return bool(label) and bool(_TOTAL_RE.match(str(label).strip()))


def _short_period(period):
    p = (period or "").strip()
    if not p or p.lower() == "tahun":
        return ""
    p = re.sub(r"^Triwulan\s+", "TW ", p, flags=re.I)
    p = re.sub(r"^Semester\s+", "Sem ", p, flags=re.I)
    p = re.sub(r"^Kuartal\s+", "TW ", p, flags=re.I)
    return p[:12]


def time_key(r):
    return f"{r['year_id']}|{r['period_id']}"


# ----------------------------------------------------------------- summarize

def summarize(rows):
    """Describe the three dimensions of a decoded variable.

    Returns {dim: {key, label, n, members:[{id,label,short,is_total,magnitude,
    n_values}], additive, degenerate}} for vervar / turvar / time."""
    members = {"vervar": {}, "turvar": {}, "time": {}}
    order = {"vervar": [], "turvar": [], "time": []}
    unit = rows[0]["unit"] if rows else ""
    title = rows[0]["variable"] if rows else ""

    for r in rows:
        val = to_num(r.get("value"))
        for dim, mid, label, sort in (
                ("vervar", str(r["vervar_id"]), r["vervar"], None),
                ("turvar", str(r["turvar_id"]), r["turvar"], None),
                ("time", time_key(r), None,
                 (_int(r["year_id"]), _int(r["period_id"])))):
            bag = members[dim]
            m = bag.get(mid)
            if m is None:
                if dim == "time":
                    short = _short_period(r["period"])
                    label = f"{r['year']} {short}".strip() if short else str(r["year"])
                    full = f"{r['year']} {r['period']}".strip() if short else str(r["year"])
                    m = {"id": mid, "label": label, "full": full, "sort": sort,
                         "year": str(r["year"]), "period": str(r["period"])}
                else:
                    m = {"id": mid, "label": label or "", "full": label or "",
                         "sort": None}
                m.update({"magnitude": 0.0, "n_values": 0,
                          "is_total": is_total_label(m["label"])})
                bag[mid] = m
                order[dim].append(mid)
            if val is not None:
                m["magnitude"] += abs(val)
                m["n_values"] += 1

    non_additive = bool(_NON_ADDITIVE_RE.search(f"{unit} {title}"))
    out = {}
    for dim in ("vervar", "turvar", "time"):
        ms = [members[dim][k] for k in order[dim]]
        if dim == "time":
            ms.sort(key=lambda m: m["sort"])
        degenerate = len(ms) == 1 and bool(
            not ms[0]["label"] or _DEGENERATE_RE.match(ms[0]["label"] or ""))
        out[dim] = {"key": dim, "label": DIM_LABELS[dim], "n": len(ms),
                    "members": ms, "degenerate": degenerate,
                    "additive": not non_additive,
                    "n_real": len([m for m in ms if not m["is_total"]])}
    out["unit"] = unit
    out["title"] = title
    out["additive"] = not non_additive
    return out


def describe(dims):
    """One-line, human-readable shape of the variable."""
    bits = []
    for dim in ("vervar", "turvar", "time"):
        d = dims[dim]
        if d["degenerate"]:
            continue
        noun = {"vervar": "entitas", "turvar": "kategori", "time": "periode"}[dim]
        bits.append(f"{d['n']} {noun}")
    return " x ".join(bits) if bits else "nilai tunggal"


# ----------------------------------------------------------------- roles

def _free(dims, dim):
    return dims[dim]["n"] > 1 and not dims[dim]["degenerate"]


def assign_roles(dims, x=None, series=None):
    """Pick which dimension is the x axis and which one splits into series.

    Time wins the x axis whenever it varies -- readers expect it there. The
    smaller of the two remaining dimensions becomes the series (colour is the
    scarce channel: at most 8 slots), and the larger one is filtered."""
    free = [d for d in ("vervar", "turvar", "time") if _free(dims, d)]
    no_series = series == "none"
    if x not in free:
        x = None
    if series not in free:
        series = None

    if x is None:
        if "time" in free:
            x = "time"
        elif free:
            # entities on the axis, categories in colour -> part-to-whole reads
            x = "vervar" if "vervar" in free else free[0]
        else:
            x = "time" if dims["time"]["n"] else "vervar"
    rest = [d for d in free if d != x]
    if series is None and rest and not no_series:
        if len(rest) == 1:
            series = rest[0]
        else:
            series = min(rest, key=lambda d: dims[d]["n"])
    if series == x:
        series = None
    filters = [d for d in ("vervar", "turvar", "time") if d not in (x, series)]
    return {"x": x, "series": series, "filters": filters}


def default_pick(dims, dim):
    """Default member for a dimension that is being held fixed."""
    ms = dims[dim]["members"]
    if not ms:
        return None
    if dim == "time":
        return ms[-1]["id"]                       # latest period
    real = [m for m in ms if not m["is_total"]] or ms
    return max(real, key=lambda m: m["magnitude"])["id"]


# ----------------------------------------------------------------- pivot

AGG_SUM, AGG_AVG = "__sum__", "__avg__"


def _pivot(rows, x_dim, series_dim, picks):
    """Sum values into a {series_id: {x_id: value}} grid, honouring filters."""
    grid, counts = {}, {}
    for r in rows:
        ids = {"vervar": str(r["vervar_id"]), "turvar": str(r["turvar_id"]),
               "time": time_key(r)}
        keep = True
        for dim, pick in picks.items():
            if pick in (AGG_SUM, AGG_AVG, None):
                continue
            if ids[dim] != pick:
                keep = False
                break
        if not keep:
            continue
        val = to_num(r.get("value"))
        if val is None:
            continue
        sid = ids[series_dim] if series_dim else "__one__"
        xid = ids[x_dim]
        grid.setdefault(sid, {}).setdefault(xid, 0.0)
        grid[sid][xid] += val
        counts.setdefault(sid, {}).setdefault(xid, 0)
        counts[sid][xid] += 1
    for dim, pick in picks.items():
        if pick == AGG_AVG:
            for sid, row in grid.items():
                for xid in row:
                    n = counts[sid][xid] or 1
                    row[xid] = row[xid] / n
            break
    return grid


# ----------------------------------------------------------------- chart choice

def _numeric_totals(grid, row_ids, col_ids, tol=0.02, hit_ratio=0.8):
    """Members whose values equal the sum of the other members.

    BPS does not name every roll-up "Jumlah": var 2534 calls it "PDRB" and
    var 1161 calls it "INDONESIA". Stacking or ranking such a member against
    its own parts double-counts, so it is detected numerically rather than by
    label, then dropped by default."""
    out = set()
    if len(row_ids) < 3:
        return out
    for cand in row_ids:
        others = [r for r in row_ids if r != cand]
        hits = seen = 0
        for c in col_ids:
            cv = grid.get(cand, {}).get(c)
            if cv is None or cv == 0:
                continue
            s = sum(grid.get(o, {}).get(c, 0.0) for o in others)
            seen += 1
            if abs(cv - s) <= tol * abs(cv):
                hits += 1
        if seen and hits / seen >= hit_ratio:
            out.add(cand)
    return out


def _transpose(grid):
    out = {}
    for rid, row in grid.items():
        for cid, v in row.items():
            out.setdefault(cid, {})[rid] = v
    return out


def _is_part_to_whole(dims, series_dim, series_members, values_nonneg, evidence):
    """Stackable only when the series really are parts of one quantity.

    Evidence is required, never assumed: either a sibling that equals the sum
    of the others was found (so a whole demonstrably exists), or the values are
    percentages adding to 100. Without it the categories may be alternative
    measures of the same thing -- BPS ships plenty, e.g. a variable split into
    "Harga Berlaku" and "Harga Konstan" -- and stacking those adds quantities
    that must never be added."""
    if series_dim != "turvar" or len(series_members) < 2:
        return False
    if not dims["additive"] or not values_nonneg:
        return False
    return bool(evidence)


def choose_chart(x_dim, n_x, n_series, part_to_whole, crosses_zero, shares):
    """The decision table from the module docstring."""
    if n_x == 1 and n_series == 1:
        # one number is not a chart; a one-bar bar chart says nothing a figure
        # does not say better
        return ("stat", "hanya satu nilai -> angka tunggal")
    if x_dim == "time":
        if n_series <= 1:
            return ("line", f"1 seri x {n_x} periode -> tren garis") if n_x >= 3 \
                else ("bar", f"hanya {n_x} periode -> batang lebih jelas dari garis")
        if part_to_whole:
            if n_x >= 4:
                return ("stacked_area" if not shares else "stacked_area_100",
                        f"{n_series} komponen sepanjang {n_x} periode -> area bertumpuk")
            return ("stacked_bar" if not shares else "stacked_bar_100",
                    f"{n_series} komponen, {n_x} periode -> batang bertumpuk")
        if n_series <= MAX_SERIES:
            return ("line", f"{n_series} seri sepanjang waktu -> garis ganda")
        if n_series <= SMALL_MULTIPLES_MAX:
            return ("small_multiples",
                    f"{n_series} seri melebihi 8 slot warna -> panel kecil")
        return ("heatmap", f"{n_series} seri x {n_x} periode -> heatmap")

    # categorical x
    if n_series <= 1:
        if crosses_zero:
            return ("diverging_bar",
                    f"{n_x} kategori dengan nilai +/- -> batang divergen dari nol")
        if n_x > 8:
            return ("hbar", f"{n_x} kategori -> batang horizontal berperingkat")
        return ("bar", f"{n_x} kategori -> batang")
    if part_to_whole:
        base = "stacked_bar_100" if shares else "stacked_bar"
        return (base, f"{n_series} komponen dari satu total -> batang bertumpuk")
    if n_series <= 4 and n_x <= 8:
        return ("grouped_bar", f"{n_series} seri x {n_x} kategori -> batang berkelompok")
    if n_series <= MAX_SERIES:
        return ("hbar_grouped", f"{n_series} seri x {n_x} kategori -> batang horizontal berkelompok")
    return ("heatmap", f"{n_series} seri x {n_x} kategori -> heatmap")


def alternatives_for(chart, x_dim, n_x, n_series):
    alts = {chart}
    if chart == "stat":
        return ["stat", "bar"]
    if x_dim == "time":
        alts |= {"line", "bar"}
        if n_series > 1:
            alts |= {"small_multiples", "heatmap"}
            alts |= {"stacked_bar", "stacked_area", "stacked_area_100", "grouped_bar"}
    else:
        alts |= {"bar", "hbar"}
        if n_series > 1:
            alts |= {"grouped_bar", "stacked_bar", "stacked_bar_100", "heatmap"}
        else:
            alts |= {"diverging_bar"}
            if n_x >= 15:
                alts |= {"histogram"}
            if n_x <= 6:
                alts |= {"donut"}
    order = ["line", "bar", "hbar", "diverging_bar", "grouped_bar", "hbar_grouped",
             "stacked_bar", "stacked_bar_100", "stacked_area", "stacked_area_100",
             "small_multiples", "heatmap", "histogram", "donut"]
    return [c for c in order if c in alts]


CHART_LABELS = {
    "line": "Garis", "bar": "Batang", "hbar": "Batang horizontal",
    "diverging_bar": "Batang divergen", "grouped_bar": "Batang berkelompok",
    "hbar_grouped": "Batang horizontal berkelompok",
    "stacked_bar": "Batang bertumpuk", "stacked_bar_100": "Batang bertumpuk 100%",
    "stacked_area": "Area bertumpuk", "stacked_area_100": "Area bertumpuk 100%",
    "small_multiples": "Panel kecil", "heatmap": "Heatmap",
    "histogram": "Histogram", "donut": "Donat", "stat": "Angka tunggal",
}

STACKED = {"stacked_bar", "stacked_bar_100", "stacked_area", "stacked_area_100"}


# ----------------------------------------------------------------- spec

def build_spec(rows, opts=None):
    """Turn tidy rows into a chart spec. `opts` overrides the automatic choice:

    x / series : dimension key ("vervar" | "turvar" | "time")
    chart      : forced chart type
    pick       : {dim: member_id | "__sum__" | "__avg__"}
    top        : max categories/series kept on ranked forms
    sort       : "value" | "natural"
    include_totals : keep roll-up members (dropped by default)
    """
    opts = dict(opts or {})
    if not rows:
        return {"chart": "empty", "title": "", "reason": "Tidak ada data",
                "series": [], "x": {"categories": []}, "notes": ["Data kosong."]}

    dims = summarize(rows)
    roles = assign_roles(dims, opts.get("x"), opts.get("series"))
    x_dim, series_dim = roles["x"], roles["series"]

    picks = {}
    for dim in roles["filters"]:
        if dims[dim]["n"] == 0:
            continue
        want = (opts.get("pick") or {}).get(dim)
        valid = {m["id"] for m in dims[dim]["members"]} | {AGG_SUM, AGG_AVG}
        if want in (AGG_SUM, AGG_AVG) and not dims["additive"]:
            want = None if want == AGG_SUM else want
        picks[dim] = want if want in valid else default_pick(dims, dim)

    grid = _pivot(rows, x_dim, series_dim, picks)

    x_members = [m for m in dims[x_dim]["members"]]
    series_members = ([m for m in dims[series_dim]["members"]] if series_dim
                      else [{"id": "__one__", "label": dims["title"],
                             "full": dims["title"], "is_total": False,
                             "magnitude": 0.0}])
    # keep only members that survived filtering
    present_x = {xid for row in grid.values() for xid in row}
    x_members = [m for m in x_members if m["id"] in present_x] or x_members
    series_members = [m for m in series_members if m["id"] in grid] or series_members

    # --- roll-up members ------------------------------------------------------
    # A member that is the sum of its siblings ("Jumlah", "PDRB", "INDONESIA")
    # must not be stacked with, or ranked against, its own parts.
    x_ids = [m["id"] for m in x_members]
    s_ids = [m["id"] for m in series_members]
    num_series_totals = _numeric_totals(grid, s_ids, x_ids) if series_dim else set()
    num_x_totals = _numeric_totals(_transpose(grid), x_ids, s_ids)
    for m in series_members:
        m["is_total"] = bool(m["is_total"] or m["id"] in num_series_totals)
    for m in x_members:
        m["is_total"] = bool(m["is_total"] or m["id"] in num_x_totals)

    # A roll-up sibling is the proof that these categories form a whole; it is
    # dropped from the stack below, so the fact is recorded first.
    had_series_total = any(m["is_total"] for m in series_members) and len(series_members) > 2

    notes = []
    dropped = []
    include_totals = bool(opts.get("include_totals"))
    if not include_totals:
        s_parts = [m for m in series_members if not m["is_total"]]
        if len(s_parts) >= 2 and len(s_parts) < len(series_members):
            dropped += [m["label"] for m in series_members if m["is_total"]]
            series_members = s_parts
        x_parts = [m for m in x_members if not m["is_total"]]
        if len(x_parts) >= 2 and len(x_parts) < len(x_members) and x_dim != "time":
            dropped += [m["label"] for m in x_members if m["is_total"]]
            x_members = x_parts
    if dropped:
        notes.append("Baris agregat (" + ", ".join(sorted(set(dropped))) +
                     ") dikeluarkan agar tidak dihitung dua kali — "
                     "aktifkan \"sertakan total\" untuk menampilkannya.")

    grid = {k: v for k, v in grid.items() if k in {m["id"] for m in series_members}}
    keep_x = {m["id"] for m in x_members}
    grid = {k: {c: v for c, v in row.items() if c in keep_x} for k, row in grid.items()}

    values_all = [v for row in grid.values() for v in row.values()]
    nonneg = all(v >= 0 for v in values_all) if values_all else True
    crosses_zero = bool(values_all) and min(values_all) < 0 < max(values_all)

    shares = False
    if re.search(r"(persen|%)", dims["unit"] or "", re.I) and len(series_members) > 1:
        sums = []
        for m in x_members:
            s = sum(grid.get(sm["id"], {}).get(m["id"], 0.0) for sm in series_members)
            if s:
                sums.append(s)
        shares = bool(sums) and all(95 <= s <= 105 for s in sums)

    part_to_whole = _is_part_to_whole(dims, series_dim, series_members, nonneg,
                                      had_series_total or shares)

    n_x, n_series = len(x_members), len(series_members)
    chart, reason = choose_chart(x_dim, n_x, n_series, part_to_whole,
                                 crosses_zero, shares)
    auto_chart = chart
    forced = opts.get("chart")
    if forced and forced != "auto":
        chart, reason = forced, f"Dipilih manual: {CHART_LABELS.get(forced, forced)}"

    # --- ranking / truncation ------------------------------------------------
    top = int(opts.get("top") or 0) or (HEATMAP_MAX_COLS if chart == "heatmap"
                                        else DEFAULT_TOP)
    truncated = None
    ranked_forms = {"hbar", "bar", "diverging_bar", "hbar_grouped", "donut"}
    sort_mode = opts.get("sort") or ("value" if chart in ranked_forms else "natural")

    def x_total(m):
        return sum(abs(grid.get(s["id"], {}).get(m["id"], 0.0)) for s in series_members)

    if x_dim != "time" and sort_mode == "value":
        x_members = sorted(x_members, key=x_total, reverse=True)
    # A category axis with hundreds of members is unreadable at any width; the
    # time axis is never truncated (a chopped time series lies about the trend).
    if x_dim != "time" and len(x_members) > top and chart != "histogram":
        if chart == "heatmap":
            x_members = sorted(x_members, key=x_total, reverse=True)[:top]
            truncated = {"shown": top, "total": len(dims[x_dim]["members"])}
        else:
            truncated = {"shown": top, "total": len(x_members)}
            x_members = x_members[:top]

    if chart in ("heatmap", "small_multiples") and len(series_members) > HEATMAP_MAX_ROWS:
        series_members = sorted(
            series_members,
            key=lambda m: sum(abs(v) for v in grid.get(m["id"], {}).values()),
            reverse=True)[:HEATMAP_MAX_ROWS]
        notes.append(f"Menampilkan {HEATMAP_MAX_ROWS} seri terbesar.")
    elif chart not in ("heatmap", "small_multiples") and len(series_members) > MAX_SERIES:
        series_members = sorted(
            series_members,
            key=lambda m: sum(abs(v) for v in grid.get(m["id"], {}).values()),
            reverse=True)[:MAX_SERIES]
        notes.append(f"Hanya {MAX_SERIES} seri terbesar diberi warna; "
                     "gunakan heatmap atau panel kecil untuk semuanya.")

    # --- assemble ------------------------------------------------------------
    x_cats = [{"id": m["id"], "label": m["label"], "full": m.get("full", m["label"])}
              for m in x_members]
    series = []
    for m in series_members:
        row = grid.get(m["id"], {})
        series.append({"id": m["id"], "label": m["label"] or dims["title"],
                       "values": [row.get(c["id"]) for c in x_cats]})

    if chart == "histogram":
        vals = [v for s in series for v in s["values"] if v is not None]
        x_cats, series = _histogram(vals)

    color = "single"
    if chart in ("heatmap",):
        color = "diverging" if crosses_zero else "sequential"
    elif chart == "diverging_bar":
        color = "diverging"
    elif len(series) > 1:
        color = "categorical"

    filter_text = []
    for dim, pick in picks.items():
        if pick == AGG_SUM:
            filter_text.append(f"{DIM_LABELS[dim]}: jumlah semua")
        elif pick == AGG_AVG:
            filter_text.append(f"{DIM_LABELS[dim]}: rata-rata")
        else:
            lbl = next((m["full"] for m in dims[dim]["members"] if m["id"] == pick), pick)
            if lbl and not _DEGENERATE_RE.match(str(lbl)):
                filter_text.append(str(lbl))

    return {
        "chart": chart,
        "auto_chart": auto_chart,
        "chart_label": CHART_LABELS.get(chart, chart),
        "title": dims["title"],
        "unit": dims["unit"],
        "subtitle": " · ".join(filter_text),
        "structure": describe(dims),
        "reason": reason,
        "x": {"dim": x_dim, "label": DIM_LABELS[x_dim],
              "type": "time" if x_dim == "time" else "category",
              "categories": x_cats},
        "y": {"label": dims["unit"] or "Nilai"},
        "series_dim": series_dim,
        "series_label": DIM_LABELS.get(series_dim, ""),
        "series": series,
        "color": color,
        "stacked": chart in STACKED,
        "percent": chart.endswith("_100"),
        "roles": {"x": x_dim, "series": series_dim, "picks": picks},
        "truncated": truncated,
        "totals_dropped": sorted(set(dropped)),
        "include_totals": include_totals,
        "notes": notes,
        "alternatives": [{"id": c, "label": CHART_LABELS[c]}
                         for c in alternatives_for(auto_chart, x_dim, n_x, n_series)],
        "dims": {d: {"key": d, "label": DIM_LABELS[d], "n": dims[d]["n"],
                     "degenerate": dims[d]["degenerate"],
                     "additive": dims["additive"],
                     "members": [{"id": m["id"], "label": m["full"] or m["label"],
                                  "is_total": m["is_total"]}
                                 for m in dims[d]["members"]]}
                 for d in ("vervar", "turvar", "time")},
    }


def _histogram(values, bins=None):
    """Distribution of a single-series categorical spread (e.g. 514 regencies)."""
    if not values:
        return [], []
    lo, hi = min(values), max(values)
    if lo == hi:
        return ([{"id": "0", "label": f"{lo:g}", "full": f"{lo:g}"}],
                [{"id": "count", "label": "Jumlah entitas", "values": [len(values)]}])
    n = bins or max(6, min(20, int(len(values) ** 0.5) + 1))
    width = (hi - lo) / n
    counts = [0] * n
    for v in values:
        i = min(n - 1, int((v - lo) / width))
        counts[i] += 1
    cats = []
    for i in range(n):
        a, b = lo + i * width, lo + (i + 1) * width
        cats.append({"id": str(i), "label": f"{a:,.4g}",
                     "full": f"{a:,.4g} – {b:,.4g}"})
    return cats, [{"id": "count", "label": "Jumlah entitas", "values": counts}]

#!/usr/bin/env python3
"""
BPS WebAPI data layer -- shared by the dashboard app and the CLI.

Same data source as https://github.com/hengkykurniawan/bps_download:
`webapi.bps.go.id` "Tabel Dinamis" (dynamic data). This module only fetches and
decodes; charting lives in bps_viz.py.

Drill-down:
    subjects  ->  variables (per subject)  ->  years/periods (per variable)
              ->  data cube (per variable + year)  ->  tidy rows

Tidy row columns (one row per value):
    var_id, variable, unit, vervar_id, vervar, turvar_id, turvar,
    year_id, year, period_id, period, value

    vervar = the row entity (usually region/kab-kota), turvar = sub-category,
    period = sub-year (quarter/month; "Tahun" when the series is annual).

The API key is read from `.bps_key` next to this file. Python 3 stdlib only.
"""

import csv
import gzip
import hashlib
import html
import json
import os
import re
import time
import urllib.request

BASE = "https://webapi.bps.go.id/v1/api"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(SCRIPT_DIR, "cache")

# Charts get re-requested constantly while the reader flips dimensions, so every
# API response is cached on disk; BPS revises dynamic tables slowly.
CACHE_TTL = 6 * 3600

SETTINGS = {"domain": "0000", "lang": "ind", "perpage": 100}

CSV_COLS = ["var_id", "variable", "unit", "vervar_id", "vervar", "turvar_id",
            "turvar", "year_id", "year", "period_id", "period", "value"]


# ----------------------------------------------------------------- key + text

def load_key():
    path = os.path.join(SCRIPT_DIR, ".bps_key")
    return open(path).read().strip() if os.path.exists(path) else ""


def save_key(value):
    with open(os.path.join(SCRIPT_DIR, ".bps_key"), "w") as f:
        f.write(value.strip())


_TAG_RE = re.compile(r"<[^>]+>")


def clean(s):
    """Strip HTML tags and decode entities from BPS labels
    (BPS embeds markup like '<b>A. Pintu Udara</b>' and '&amp;' in labels)."""
    if s is None:
        return s
    s = _TAG_RE.sub("", str(s))
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def sanitize(name, maxlen=120):
    name = re.sub(r'[<>:"/\\|?*\n\r\t]', " ", str(name))
    name = re.sub(r"\s+", " ", name).strip().strip(".")
    return name[:maxlen].strip() or "untitled"


# ----------------------------------------------------------------- HTTP + cache

def _cache_path(url):
    key = load_key()
    tag = hashlib.sha1(url.replace(key, "KEY").encode("utf-8")).hexdigest()[:20]
    return os.path.join(CACHE_DIR, tag + ".json.gz")


def _cache_read(path, ttl):
    try:
        if time.time() - os.path.getmtime(path) > ttl:
            return None
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _cache_write(path, obj):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with gzip.open(path, "wt", encoding="utf-8") as f:
            json.dump(obj, f)
    except Exception:
        pass


def api(url, retries=4, cache=True, ttl=CACHE_TTL):
    path = _cache_path(url)
    if cache:
        hit = _cache_read(path, ttl)
        if hit is not None:
            return hit
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                d = json.loads(r.read().decode("utf-8", "replace"))
            if cache:
                _cache_write(path, d)
            return d
        except Exception as e:
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"API error: {last}")


def clear_cache():
    n = 0
    if os.path.isdir(CACHE_DIR):
        for f in os.listdir(CACHE_DIR):
            try:
                os.remove(os.path.join(CACHE_DIR, f))
                n += 1
            except OSError:
                pass
    return n


def api_list(model, filt="", domain=None, lang=None, all_pages=True):
    key = load_key()
    if not key:
        raise RuntimeError("No API key set (put it in .bps_key, or use Settings).")
    domain = domain or SETTINGS["domain"]
    lang = lang or SETTINGS["lang"]
    perpage = SETTINGS.get("perpage", 100)
    seg = f"{filt}/" if filt else ""
    out, page = [], 1
    while True:
        url = (f"{BASE}/list/model/{model}/lang/{lang}/domain/{domain}/{seg}"
               f"perpage/{perpage}/page/{page}/key/{key}/")
        d = api(url)
        data = d.get("data")
        if not (isinstance(data, list) and len(data) > 1 and data[1]):
            break
        meta, rows = data[0], data[1]
        out.extend(rows)
        if not all_pages or page >= meta.get("pages", 1):
            break
        page += 1
    return out


# ----------------------------------------------------------------- discovery

def get_subjects():
    rows = api_list("subjectcsa")
    return [{"id": r.get("sub_id"), "title": clean(r.get("title")),
             "subcat": clean(r.get("subcat")) or "Lainnya", "ntabel": r.get("ntabel")}
            for r in rows]


def get_vars(subject):
    rows = api_list("var", f"subjectcsa/{subject}")
    return [{"var_id": r.get("var_id"), "title": clean(r.get("title")),
             "unit": clean(r.get("unit") or ""), "sub_name": r.get("sub_name") or ""}
            for r in rows]


def get_years(var):
    rows = api_list("th", f"var/{var}")
    return [{"th_id": r.get("th_id"), "th": r.get("th")} for r in rows]


def get_domains():
    key = load_key()
    d = api(f"{BASE}/domain/type/all/key/{key}/")
    data = d.get("data")
    rows = data[1] if isinstance(data, list) and len(data) > 1 else []
    return [{"id": r.get("domain_id"), "name": r.get("domain_name")} for r in rows]


# ----------------------------------------------------------------- data cube

def fetch_data(var, th, domain=None, lang=None):
    key = load_key()
    if not key:
        raise RuntimeError("No API key set (put it in .bps_key, or use Settings).")
    domain = domain or SETTINGS["domain"]
    lang = lang or SETTINGS["lang"]
    url = (f"{BASE}/list/model/data/lang/{lang}/domain/{domain}"
           f"/var/{var}/th/{th}/key/{key}/")
    return api(url)


def decode_rows(d):
    """Reconstruct every cell of the BPS data cube into tidy rows.
    key = [vervar][var][turvar][tahun][turtahun] -> value in `datacontent`."""
    if d.get("data-availability") != "available":
        return []
    var = d["var"][0]
    var_id = str(var["val"])
    unit, var_label = clean(var.get("unit", "")), clean(var.get("label", ""))
    vervar = d.get("vervar", [])
    turvar = d.get("turvar") or [{"val": "", "label": ""}]
    tahun = d.get("tahun", [])
    turtahun = d.get("turtahun") or [{"val": "", "label": ""}]
    dc = d.get("datacontent", {})
    rows = []
    for vv in vervar:
        for tv in turvar:
            for ty in tahun:
                for tt in turtahun:
                    k = f"{vv['val']}{var_id}{tv['val']}{ty['val']}{tt['val']}"
                    if k in dc:
                        rows.append({
                            "var_id": var_id, "variable": var_label, "unit": unit,
                            "vervar_id": vv["val"], "vervar": clean(vv["label"]),
                            "turvar_id": tv["val"], "turvar": clean(tv["label"]),
                            "year_id": ty["val"], "year": clean(ty["label"]),
                            "period_id": tt["val"], "period": clean(tt["label"]),
                            "value": dc[k],
                        })
    return rows


def get_rows(var, ths, domain=None, lang=None):
    """Tidy rows for one variable across one or more year ids ('all' = every year)."""
    if ths in ("all", ["all"]):
        ths = [str(y["th_id"]) for y in get_years(var)]
    elif isinstance(ths, (str, int)):
        ths = [str(ths)]
    rows = []
    for th in ths:
        rows += decode_rows(fetch_data(var, th, domain, lang))
    return rows


def _short_period(period):
    """'Triwulan I' -> 'TW I'; annual periods carry no sub-year label."""
    p = (period or "").strip()
    if not p or p.lower() == "tahun":
        return ""
    p = re.sub(r"^Triwulan\s+", "TW ", p, flags=re.I)
    p = re.sub(r"^Semester\s+", "Sem ", p, flags=re.I)
    p = re.sub(r"^Kuartal\s+", "TW ", p, flags=re.I)
    return p[:12]


def _num(v):
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


def to_cube(rows):
    """Compact, chart-ready form of the tidy rows.

    The browser does the charting (docs/infer.js decides the chart type, so the
    decision lives in exactly one place), and this is what it consumes: the
    three dimensions plus a dense [vervar][turvar][time] grid of values. It is
    the same payload whether it comes live from the local service or from a
    committed snapshot under docs/data/."""
    vervar, turvar, time = {}, {}, {}
    for r in rows:
        vid = str(r["vervar_id"])
        if vid not in vervar:
            vervar[vid] = clean(r["vervar"]) or ""
        tid = str(r["turvar_id"])
        if tid not in turvar:
            turvar[tid] = clean(r["turvar"]) or ""
        key = f"{r['year_id']}|{r['period_id']}"
        if key not in time:
            short = _short_period(r["period"])
            time[key] = (
                int(str(r["year_id"] or 0) or 0), int(str(r["period_id"] or 0) or 0),
                f"{r['year']} {short}".strip() if short else str(r["year"]),
                f"{r['year']} {r['period']}".strip() if short else str(r["year"]))

    vv = [[k, v] for k, v in vervar.items()]
    tv = [[k, v] for k, v in turvar.items()]
    tt = sorted(time.items(), key=lambda kv: (kv[1][0], kv[1][1]))
    ti = [[k, v[2], v[3]] for k, v in tt]

    vidx = {k: i for i, (k, _) in enumerate(vv)}
    tidx = {k: i for i, (k, _) in enumerate(tv)}
    pidx = {k: i for i, (k, _, _) in enumerate(ti)}
    values = [[[None] * len(ti) for _ in tv] for _ in vv]
    for r in rows:
        v = _num(r.get("value"))
        if v is None:
            continue
        values[vidx[str(r["vervar_id"])]][tidx[str(r["turvar_id"])]][
            pidx[f"{r['year_id']}|{r['period_id']}"]] = v

    meta = var_meta(rows)
    return {"var_id": meta["var_id"], "title": meta["title"], "unit": meta["unit"],
            "vervar": vv, "turvar": tv, "time": ti, "values": values}


def from_cube(cube):
    """Tidy rows back out of a cube -- used for the CSV export."""
    rows = []
    for vi, (vid, vlabel) in enumerate(cube["vervar"]):
        for ti, (tid, tlabel) in enumerate(cube["turvar"]):
            for pi, entry in enumerate(cube["time"]):
                v = cube["values"][vi][ti][pi]
                if v is None:
                    continue
                year_id, period_id = entry[0].split("|")
                rows.append({
                    "var_id": cube["var_id"], "variable": cube["title"],
                    "unit": cube["unit"], "vervar_id": vid, "vervar": vlabel,
                    "turvar_id": tid, "turvar": tlabel,
                    "year_id": year_id, "year": entry[2].split(" ")[0],
                    "period_id": period_id,
                    "period": " ".join(entry[2].split(" ")[1:]) or "Tahun",
                    "value": v})
    return rows


def read_csv_rows(path):
    """Load tidy rows from a CSV written by this repo or by bps_download."""
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        missing = [c for c in ("vervar", "turvar", "year", "value")
                   if c not in (reader.fieldnames or [])]
        if missing:
            raise RuntimeError(f"{os.path.basename(path)} is not a BPS tidy CSV "
                               f"(missing columns: {', '.join(missing)})")
        return [{c: r.get(c, "") for c in CSV_COLS} for r in reader]


def write_csv(rows, path, gzip_out=False):
    if gzip_out and not path.endswith(".gz"):
        path += ".gz"
    opener = (lambda p: gzip.open(p, "wt", newline="", encoding="utf-8-sig")) \
        if gzip_out else (lambda p: open(p, "w", newline="", encoding="utf-8-sig"))
    with opener(path) as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLS)
        w.writeheader()
        w.writerows(rows)
    return path


def var_meta(rows, var_id=""):
    """Title + unit for a variable, taken from the decoded rows."""
    if rows:
        return {"var_id": rows[0]["var_id"], "title": rows[0]["variable"],
                "unit": rows[0]["unit"]}
    return {"var_id": str(var_id), "title": "", "unit": ""}

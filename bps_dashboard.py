#!/usr/bin/env python3
"""
BPS Dashboard -- local web app that charts BPS dynamic data (zero install).

Same data source as https://github.com/hengkykurniawan/bps_download, but the
output is graphics instead of tables: pick a subject, pick a variable, and the
app decides the chart type from the variable's own structure (see bps_viz.py).

Run:
    python bps_dashboard.py
Then a browser opens at http://127.0.0.1:8766

    --no-browser     start the service only (for the GitHub Pages front-end)
    --port N         serve on another port
    --data-dir DIR   also chart tidy CSVs found in DIR (e.g. your bps_download
                     folder), so the app works offline

Everything is served locally; the backend makes the BPS calls, so the API key
never reaches the browser. Python 3 stdlib only.
"""

import argparse
import csv
import io
import json
import mimetypes
import os
import sys
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import bps_api as api

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DOCS_DIR = os.path.join(SCRIPT_DIR, "docs")
PAGES_ORIGIN = "https://hengkykurniawan.github.io"
HOST, PORT = "127.0.0.1", 8766
DATA_DIRS = [SCRIPT_DIR]

_ROWS_CACHE = {}
_ROWS_LOCK = threading.Lock()
_CACHE_MAX = 12


def rows_for(var, ths):
    """Decoded rows for a variable, memoised so flipping chart options is instant."""
    key = (str(var), tuple(ths), api.SETTINGS["domain"], api.SETTINGS["lang"])
    with _ROWS_LOCK:
        if key in _ROWS_CACHE:
            return _ROWS_CACHE[key]
    rows = api.get_rows(var, list(ths))
    with _ROWS_LOCK:
        if len(_ROWS_CACHE) >= _CACHE_MAX:
            _ROWS_CACHE.pop(next(iter(_ROWS_CACHE)))
        _ROWS_CACHE[key] = rows
    return rows


def resolve_ths(var, ths):
    """'all' -> every period, 'latest' -> the newest one, else as given."""
    if ths in (["all"], ["latest"]):
        years = api.get_years(var)
        if not years:
            return []
        if ths == ["latest"]:
            return [str(years[-1]["th_id"])]
        return [str(y["th_id"]) for y in years]
    return [str(t) for t in ths]


def rows_for_file(name):
    """Rows from a local tidy CSV, memoised on (path, mtime) -- a multi-MB CSV
    must not be re-parsed every time the reader flips a chart option."""
    for base in DATA_DIRS:
        path = os.path.normpath(os.path.join(base, name))
        if os.path.commonpath([base, path]) == base and os.path.isfile(path):
            key = ("file", path, os.path.getmtime(path))
            with _ROWS_LOCK:
                if key in _ROWS_CACHE:
                    return _ROWS_CACHE[key]
            rows = api.read_csv_rows(path)
            with _ROWS_LOCK:
                if len(_ROWS_CACHE) >= _CACHE_MAX:
                    _ROWS_CACHE.pop(next(iter(_ROWS_CACHE)))
                _ROWS_CACHE[key] = rows
            return rows
    raise RuntimeError(f"File not found: {name}")


def local_files():
    out = []
    seen = set()
    for base in DATA_DIRS:
        if not os.path.isdir(base):
            continue
        for fn in sorted(os.listdir(base)):
            if not (fn.endswith(".csv") or fn.endswith(".csv.gz")) or fn in seen:
                continue
            seen.add(fn)
            path = os.path.join(base, fn)
            out.append({"name": fn, "dir": base,
                        "size": os.path.getsize(path)})
    return out


def cube_from_query(q):
    """The chart-ready cube for a request. Which chart to draw from it is
    decided in the browser (docs/infer.js), so the local app and the static
    GitHub Pages build behave identically."""
    if q.get("file"):
        rows = rows_for_file(q["file"][0])
        cube = api.to_cube(rows)
        cube["source"] = {"file": q["file"][0], "rows": len(rows)}
        return cube
    var = q["var"][0]
    ths = tuple(resolve_ths(var, q.get("th") or ["all"]))
    key = ("cube", str(var), ths, api.SETTINGS["domain"], api.SETTINGS["lang"])
    with _ROWS_LOCK:
        hit = _ROWS_CACHE.get(key)
    if hit is None:
        hit = api.get_cube(var, list(ths))
        with _ROWS_LOCK:
            if len(_ROWS_CACHE) >= _CACHE_MAX:
                _ROWS_CACHE.pop(next(iter(_ROWS_CACHE)))
            _ROWS_CACHE[key] = hit
    cube = dict(hit)
    cells = sum(1 for p in cube["values"] for r in p for v in r if v is not None)
    cube["source"] = {"var": var, "th": list(ths), "rows": cells}
    return cube


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    # ------------------------------------------------------------- plumbing
    def _send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        origin = self.headers.get("Origin")
        if origin == PAGES_ORIGIN:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _origin_allowed(self):
        origin = self.headers.get("Origin")
        local = {f"http://{HOST}:{PORT}", f"http://localhost:{PORT}"}
        return not origin or origin == PAGES_ORIGIN or origin in local

    def do_OPTIONS(self):
        if not self._origin_allowed():
            return self._send(403, {"error": "origin not allowed"})
        self._send(204, b"")

    def _q(self):
        return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def _static(self, path):
        rel = path.lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(DOCS_DIR, rel))
        if os.path.commonpath([DOCS_DIR, full]) != DOCS_DIR or not os.path.isfile(full):
            return False
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype == "application/javascript":
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype, {"Cache-Control": "no-cache"})
        return True

    # ------------------------------------------------------------- routes
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        q = self._q()
        if not self._origin_allowed():
            return self._send(403, {"error": "origin not allowed"})
        try:
            if path == "/" or path == "/index.html":
                if self._static("index.html"):
                    return
                return self._send(500, "docs/index.html is missing",
                                  "text/plain; charset=utf-8")
            if not path.startswith("/api/"):
                if self._static(path):
                    return
                return self._send(404, {"error": "not found"})

            if path == "/api/health":
                return self._send(200, {"ok": True, "app": "bps_dashboard",
                                        "key_set": bool(api.load_key())})
            if path == "/api/settings":
                k = api.load_key()
                return self._send(200, {**api.SETTINGS, "key_set": bool(k),
                                        "key_masked": (k[:4] + "…" + k[-4:]) if k else ""})
            if path == "/api/subjects":
                return self._send(200, api.get_subjects())
            if path == "/api/domains":
                return self._send(200, api.get_domains())
            if path == "/api/vars":
                return self._send(200, api.get_vars(q["subject"][0]))
            if path == "/api/years":
                return self._send(200, api.get_years(q["var"][0]))
            if path == "/api/localfiles":
                return self._send(200, local_files())
            if path == "/api/cube":
                return self._send(200, cube_from_query(q))
            if path == "/api/data.csv":
                if q.get("file"):
                    rows = rows_for_file(q["file"][0])
                    fn = q["file"][0]
                else:
                    var = q["var"][0]
                    rows = rows_for(var, resolve_ths(var, q.get("th") or ["all"]))
                    fn = f"data_var{var}.csv"
                buf = io.StringIO()
                w = csv.DictWriter(buf, fieldnames=api.CSV_COLS)
                w.writeheader()
                w.writerows(rows)
                return self._send(200, "﻿" + buf.getvalue(),
                                  "text/csv; charset=utf-8",
                                  {"Content-Disposition": f'attachment; filename="{fn}"'})
            if path == "/api/open_folder":
                try:
                    os.startfile(SCRIPT_DIR)  # noqa - Windows
                except Exception:
                    pass
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "not found"})
        except KeyError as e:
            return self._send(400, {"error": f"missing parameter: {e}"})
        except Exception as e:
            return self._send(500, {"error": str(e)})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if not self._origin_allowed():
            return self._send(403, {"error": "origin not allowed"})
        try:
            b = self._body()
            if path == "/api/settings":
                for k in ("domain", "lang", "perpage"):
                    if k in b and b[k] != "":
                        api.SETTINGS[k] = b[k]
                if b.get("key"):
                    api.save_key(b["key"])
                with _ROWS_LOCK:
                    _ROWS_CACHE.clear()
                return self._send(200, {"ok": True})
            if path == "/api/clear_cache":
                n = api.clear_cache()
                with _ROWS_LOCK:
                    _ROWS_CACHE.clear()
                return self._send(200, {"ok": True, "removed": n})
            return self._send(404, {"error": "not found"})
        except Exception as e:
            return self._send(500, {"error": str(e)})


def main():
    global PORT
    ap = argparse.ArgumentParser(description="BPS Dashboard - charts for BPS data.")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--data-dir", action="append", default=[],
                    help="extra folder with tidy BPS CSVs (repeatable)")
    args = ap.parse_args()
    PORT = args.port
    for d in args.data_dir:
        d = os.path.abspath(d)
        if os.path.isdir(d):
            DATA_DIRS.append(d)
        else:
            print(f"(ignoring --data-dir {d}: not a folder)")

    if not api.load_key():
        print("WARNING: no API key found. Put your BPS WebAPI key in .bps_key "
              "next to this script, or paste it in the app's Settings tab.\n")

    url = f"http://{HOST}:{PORT}"
    try:
        srv = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as e:
        sys.exit(f"Cannot start on {url}: {e}\nTry: python bps_dashboard.py --port 8770")
    print(f"BPS Dashboard running at {url}")
    print("Keep this window open. Press Ctrl+C to stop.")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()

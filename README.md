# BPS Dashboard

**Interactive app:** https://hengkykurniawan.github.io/bps_dashboard/

**Repository:** https://github.com/hengkykurniawan/bps_dashboard

Charts for BPS (Badan Pusat Statistik) dynamic data from `webapi.bps.go.id`.

Same data source as **[bps_download](https://github.com/hengkykurniawan/bps_download)**
— same subjects, same variables, same tidy CSV columns — but the output is
**graphics instead of tables**, and *the chart type is chosen from the structure
of each variable*.

**Same folder, same key, no installs.** Pure Python 3 standard library, no CDN,
no JavaScript dependencies. The API key is read from `.bps_key` in this folder.

## Quick start

```bash
git clone https://github.com/hengkykurniawan/bps_dashboard.git
cd bps_dashboard
```

Create a file named `.bps_key`, paste your BPS WebAPI key into it, then run:

```bash
python bps_dashboard.py
```

A browser opens at **http://127.0.0.1:8766**. Keep the terminal open while you
use it. On Windows you can double-click **`Start BPS Dashboard.bat`** instead.

> The two apps use different ports (`bps_download` → 8765, `bps_dashboard` →
> 8766), so you can run both at the same time.

---

## 🌐 `bps_dashboard.py` — the app

| Tab | What it does |
|---|---|
| **Jelajah** | Subject → variable → chart. The chart type is picked automatically; every dimension of the variable becomes a control (x axis, colour, which region/category to hold fixed, top-N, sorting). |
| **Galeri subjek** | Every variable in one subject, charted at once (latest period), loaded as you scroll. A fast way to see what a subject actually contains. |
| **File lokal** | Charts any tidy CSV already on disk — including the `data_var*.csv` files written by `bps_download`. Works offline. |
| **Pengaturan** | Region/**domain** (national or any of the 549 regional offices), language, API key, and a cache reset. |

Every chart carries a **table view** (the "Tabel" button), an **SVG/PNG export**,
and a **CSV export** of the exact numbers behind it. Charts follow the light or
dark theme.

To chart local CSVs from your `bps_download` folder too:

```bash
python bps_dashboard.py --data-dir ../BPS_download
```

Other flags: `--no-browser` (service only, for the GitHub Pages front-end),
`--port N`.

Everything runs locally: the backend makes the BPS calls, so the key and the
Cloudflare-safe headers never touch the browser. Responses are cached for 6
hours in `cache/` so flipping chart options does not re-hit the API.

---

## How the chart type is chosen

This is the whole point of the repo, so it is a table, not a heuristic buried in
the code (see `bps_viz.py`). Each BPS variable is a cube of
**entities (`vervar`) × categories (`turvar`) × periods (year × sub-year)**.
After the roles are assigned — time takes the x axis whenever it varies, the
smaller remaining dimension takes colour, the larger one is held fixed with a
selector — the shape decides the form:

| Structure | Chart |
|---|---|
| A single value | **Stat figure** (a one-bar bar chart says nothing extra) |
| 1 series over ≥3 periods | **Line** |
| 1 series over ≤2 periods | **Bar** |
| 2–8 components of a proven whole, over time | **Stacked area** (100% when the values are shares) |
| 2–8 series over time | **Multi-line** |
| 9–16 series over time | **Small multiples** |
| >16 series over time | **Heatmap** |
| 1 series, values crossing zero (growth rates) | **Diverging bar** |
| 1 series, >8 categories (34 provinces, 514 regencies) | **Ranked horizontal bar** |
| 1 series, ≤8 categories | **Bar** |
| 2–8 components of a proven whole | **Stacked bar** |
| 2–4 series × ≤8 categories | **Grouped bar** |
| More than 8 series × categories | **Heatmap** |

Any choice can be overridden in the UI or with `--chart` on the command line.

**Two rules that keep the charts honest:**

- **Roll-up members are detected and removed by default.** BPS does not name
  them consistently — var 2534 calls its total `PDRB`, var 1161 calls it
  `INDONESIA`, others say `Jumlah` — so a member whose values equal the sum of
  its siblings is found *numerically*, not by label. Ranking a total against its
  own parts, or stacking it on top of them, double-counts. Tick **"sertakan
  total"** (or pass `--include-totals`) to put it back.
- **Stacking requires proof of a whole.** Categories are only stacked when a
  roll-up sibling exists or the values are percentages summing to 100.
  Otherwise they may be *alternative measures* rather than parts — several BPS
  variables split into `Harga Berlaku` / `Harga Konstan`, and adding those two
  is meaningless — so they get separate lines instead.

Colour follows a fixed eight-slot categorical palette validated for
colour-vision deficiency, with a one-hue sequential ramp for magnitude and a
blue↔red diverging pair for signed values. Past eight series no ninth hue is
invented: the *form* changes (small multiples, or a heatmap) instead.

---

## `bps_chart.py` — the same thing from the command line

Discovery is identical to `bps_data.py` in the `bps_download` repo:

```bash
python bps_chart.py subjects                  # all 37 subject ids
python bps_chart.py vars --subject 531        # variables under a subject
python bps_chart.py years --var 2776          # periods a variable has
```

Then render:

```bash
# one variable -> one self-contained HTML chart
python bps_chart.py chart --var 2776 --th all
python bps_chart.py chart --var 2534 --th latest --out pdrb.html

# a whole subject -> one report, one chart per variable
python bps_chart.py report --subject 531 --limit 12 --out neraca.html

# a CSV you already have (works offline)
python bps_chart.py chart --file data_var1161.csv --chart hbar --top 34

# the numbers behind the chart, same columns as bps_data.py
python bps_chart.py get --var 2776 --th all
```

Overrides: `--chart`, `--x`, `--series`, `--pick-vervar/-turvar/-time`, `--top`,
`--sort`, `--include-totals`. `--json` prints the chart spec instead of writing
HTML — handy for scripting or for feeding another renderer.

The generated HTML is standalone: no network, no CDN, opens anywhere, and each
chart keeps its table view.

---

## Files

| File | Role |
|---|---|
| `bps_api.py` | BPS WebAPI: key, paging, the data cube, and its decoding into tidy rows |
| `bps_viz.py` | The decision table above: dimensions → chart spec |
| `bps_dashboard.py` | The local web app (HTTP + static files, stdlib only) |
| `bps_chart.py` | Command-line charts and reports |
| `docs/` | The front-end — `charts.js` (SVG renderer), `app.js`, `styles.css`; also the GitHub Pages entry point |

## Notes

- **`subject=NNN`** on the BPS website (e.g. `statistics-table?subject=530`) is
  the API's `id_subject_csa`. The same number works here and in `bps_download`.
- Default domain is `0000` (national). Override in Settings or with `--domain`.
- **API key:** stored in `.bps_key`, never committed and never sent to the
  browser. Regenerate it at the BPS developer portal if it needs replacing.
- The UI is in Indonesian, matching the language of the data labels.
- No third-party packages, in Python or in the browser.

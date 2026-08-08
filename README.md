# BPS Dashboard

**Interactive app:** https://hengkykurniawan.github.io/bps_dashboard/

**Repository:** https://github.com/hengkykurniawan/bps_dashboard

Charts for BPS (Badan Pusat Statistik) dynamic data from `webapi.bps.go.id`.

Same data source as **[bps_download](https://github.com/hengkykurniawan/bps_download)**
— same subjects, same variables, same tidy CSV columns — but the output is
**graphics instead of tables**, and *the chart type is chosen from the structure
of each variable*.

**No installs, no dependencies.** Pure Python 3 standard library on the server
side, plain JavaScript in the browser: no CDN, no build step, no packages.

## Three data sources, one app

`webapi.bps.go.id` sends permissive CORS headers, so the published page can call
BPS itself. Pick a source in the header; the charts are identical because all
three feed the same cube to `docs/infer.js`.

| Source | Covers | Needs |
|---|---|---|
| **● API BPS langsung** | every variable, every period, **always current** | your own BPS key, pasted once into Settings |
| **● Layanan lokal** | the same, plus tidy CSVs already on your disk | `python bps_dashboard.py` running |
| **◐ Data tersimpan** | all 37 subjects, latest period, refreshed nightly | nothing at all |

The page picks the best source available and remembers your key, so the online
link behaves like a normal web app after the first visit.

### About that key

The **repository holds no key and never will** — a public page cannot keep a
secret. In direct mode the key is *yours*: typed into Settings, stored in your
own browser's `localStorage`, and sent only to `webapi.bps.go.id`. It is not
committed, not bundled, and not shared with anyone else who opens the page —
they use their own (free from
[webapi.bps.go.id/developer](https://webapi.bps.go.id/developer/)).

Anyone with access to your browser profile can read `localStorage` back, so on a
**shared machine** prefer the local service, where the key stays in the
`.bps_key` file and never enters a browser at all. "Hapus kunci" in Settings
removes it.

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
| **Jelajah** | All 37 BPS subjects grouped as on the BPS site → variable → chart. The chart type is picked automatically; every dimension of the variable becomes a control (x axis, colour, which region/category to hold fixed, top-N, sorting). |
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

---

## 🕒 Freshness badges

BPS reports a `last_update` for every variable, and it is shown wherever a
variable appears: as a column in the variable list and as a badge on the chart
itself — `5 Agu 2026 · 3 hari lalu`, tinted green within 30 days and amber
within six months. In the snapshot the dates ride along in `index.json`; in
direct mode **↻ Cek pembaruan** fetches them for the whole subject at once,
reading only the first few KB of each response and aborting the rest, so a
90-variable subject costs a fraction of its data.

---

## 📸 The no-key fallback — `bps_snapshot.py`

So the page shows something useful before anyone enters a key, a snapshot is
committed under `docs/data/`:

| File | Contents |
|---|---|
| `index.json` | all 37 subjects, with how many variables each has in the snapshot — small, loaded on every visit |
| `subject<ID>.json` | that subject's variables and their update dates — loaded when the subject is opened |
| `var<ID>.json` | one cube per variable |

```bash
python bps_snapshot.py --all --refresh          # the nightly job
python bps_snapshot.py --all --budget-min 30    # bounded fill
python bps_snapshot.py --subject 530 531        # just these
python bps_snapshot.py --subject 531 --th all   # every period, not just the latest
```

### How the nightly refresh stays cheap

All of BPS is ~3,200 variables, so nothing rebuilds the lot every night:

- **`--refresh` asks before downloading.** For each known variable it reads only
  the first few KB of the response to get `last_update`, and re-downloads the
  cube only if BPS actually revised it. A quiet night costs a few KB per
  variable instead of megabytes.
- **New variables are always fetched**, so subjects BPS adds appear on their own.
- **`--budget-min` stops the run cleanly** and the next one continues where it
  left off — subjects with nothing snapshotted are processed first, so the
  initial fill spreads over a few nights instead of one enormous job.
- **Nothing is written when nothing changed.** Files are compared before writing
  and `generated` only moves when the data does, so days BPS publishes nothing
  produce no commit and no repository growth.
- `--max-kb` (default 900) skips cubes too big to be worth committing, and
  `--workers` sets the parallelism.

**The schedule:** `.github/workflows/snapshot.yml` runs nightly at 04:00 WIB and
commits only when something changed. It needs one repository secret named
**`BPS_KEY`** (Settings → Secrets and variables → Actions → New repository
secret). Without it the workflow fails with a clear message and the committed
snapshot simply stays as it is. You can also run it by hand from the Actions
tab, optionally for specific subjects or with a full re-download.

---

## How the chart type is chosen

This is the whole point of the repo, so it is a table, not a heuristic buried in
the code (see `docs/infer.js`). Each BPS variable is a cube of
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
`--sort`, `--include-totals`. `--json` prints the data cube instead of writing
HTML — handy for scripting or for feeding another renderer.

The generated HTML is standalone: no network, no CDN, opens anywhere, and each
chart keeps its table view. It carries its own copy of `infer.js`, so the chart
type is decided by the same code the app uses, when the page opens.

---

## Files

| File | Role |
|---|---|
| `bps_api.py` | BPS WebAPI: key, paging, decoding into tidy rows and into the chart-ready cube |
| `bps_dashboard.py` | The local web app (HTTP + static files, stdlib only) |
| `bps_chart.py` | Command-line charts and reports |
| `bps_snapshot.py` | Builds `docs/data/` for the no-key fallback |
| `docs/bps-api.js` | The browser's own BPS client (direct mode) |
| `docs/infer.js` | **The decision table above** — dimensions → chart spec |
| `docs/charts.js` | The SVG renderer |
| `docs/app.js`, `docs/index.html`, `docs/styles.css` | The UI, and the GitHub Pages entry point |
| `docs/data/` | The committed snapshot the online build reads |

The chart decision lives in **one** place, `docs/infer.js`, and runs in the
browser — so the local app, the published site and the HTML that `bps_chart.py`
exports all reach the same conclusion from the same code. Python fetches and
decodes; it never decides what a chart should be.

## Notes

- **`subject=NNN`** on the BPS website (e.g. `statistics-table?subject=530`) is
  the API's `id_subject_csa`. The same number works here and in `bps_download`.
- Default domain is `0000` (national). Override in Settings or with `--domain`.
- **API key:** stored in `.bps_key`, never committed and never sent to the
  browser. Regenerate it at the BPS developer portal if it needs replacing.
- The UI is in Indonesian, matching the language of the data labels.
- No third-party packages, in Python or in the browser.

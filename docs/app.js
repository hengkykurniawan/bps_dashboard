/* BPS Dashboard - UI.
 *
 * Three data sources, one code path. Whichever is active, the browser ends up
 * with the same cube and docs/infer.js decides the chart, so they behave
 * identically:
 *
 *   direct - the browser calls webapi.bps.go.id itself with the visitor's own
 *            key (docs/bps-api.js). Every variable, every period, always
 *            current -- and it needs no server at all.
 *   live   - the local Python service holds the key on disk and makes the
 *            calls. Same coverage; preferred on a shared machine.
 *   static - JSON cubes committed under docs/data/, refreshed by a scheduled
 *            GitHub Action. No key needed; covers the snapshotted subjects.
 */
(function () {
  "use strict";

  var LOCAL = "http://127.0.0.1:8766";
  var SELF_HOSTED = location.port === "8766";
  var API = SELF_HOSTED ? "" : LOCAL;
  var DATA = "data/";

  var MODE = "static";
  var CATALOG = null;
  var LIVE_OK = false;
  var HEALTH = null;
  var SET = { domain: "0000", lang: "ind" };

  var $ = function (id) { return document.getElementById(id); };

  function htm(tag, cls, parent, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }

  function qs(params) {
    var p = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === null || v === undefined || v === "") return;
      p.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
    });
    return p.length ? "?" + p.join("&") : "";
  }

  function getJSON(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d && d.error ? d.error : "HTTP " + r.status);
        return d;
      }, function () { throw new Error("HTTP " + r.status); });
    });
  }

  function api(path, params) { return getJSON(API + path + qs(params)); }

  function post(path, body) {
    return fetch(API + path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }

  function download(name, text, mime) {
    var b = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  function slug(s) {
    return String(s || "chart").toLowerCase().replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "").slice(0, 60) || "chart";
  }

  try {
    var st = JSON.parse(localStorage.getItem("bps-settings") || "{}");
    if (st.domain) SET.domain = st.domain;
    if (st.lang) SET.lang = st.lang;
  } catch (e) { }

  function saveSettings() {
    try { localStorage.setItem("bps-settings", JSON.stringify(SET)); } catch (e) { }
  }

  // ---------------------------------------------------------------- updated badge

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
    "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

  function parseWhen(s) {
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }

  function daysAgo(s) {
    var d = parseWhen(s);
    if (!d) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }

  function whenLabel(s) {
    var d = parseWhen(s);
    if (!d) return "";
    return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
  }

  /* Freshness badge for one variable: date plus how long ago, tinted when the
     figure was revised recently. */
  function updateBadge(parent, when, opts) {
    if (!when) return null;
    opts = opts || {};
    var n = daysAgo(when);
    var cls = "badge";
    if (n !== null && n <= 30) cls += " badge-fresh";
    else if (n !== null && n <= 180) cls += " badge-warm";
    var b = htm("span", cls, parent);
    var text = whenLabel(when);
    if (opts.long) text = "diperbarui " + text;
    if (n !== null) {
      text += n === 0 ? " · hari ini"
        : n < 30 ? " · " + n + " hari lalu"
          : n < 365 ? " · " + Math.round(n / 30) + " bln lalu"
            : " · " + Math.floor(n / 365) + " thn lalu";
    }
    b.textContent = text;
    b.title = "Terakhir diperbarui BPS: " + when;
    return b;
  }

  function knownUpdate(varId) {
    return BPSApi.getUpdate(varId);   // snapshot rows carry their own date
  }

  // ---------------------------------------------------------------- sources

  var CUBES = {};

  function cacheKey(ref) { return MODE + "|" + JSON.stringify(ref); }

  function fetchCube(ref) {
    var key = cacheKey(ref);
    if (CUBES[key]) return Promise.resolve(CUBES[key]);
    var p;
    if (MODE === "static") p = getJSON(DATA + ref.data);
    else if (MODE === "direct") {
      p = ref.th === "latest" || !ref.th
        ? BPSApi.getCubeLatest(ref.var, SET)
        : BPSApi.getCube(ref.var, [ref.th], SET);
    } else p = api("/api/cube", ref);
    return p.then(function (cube) { CUBES[key] = cube; return cube; });
  }

  function listSubjects() {
    if (MODE === "static") return Promise.resolve(CATALOG.subjects || []);
    if (MODE === "direct") return BPSApi.getSubjects(SET);
    return api("/api/subjects");
  }

  /* The catalogue is split per subject: index.json stays small enough to load
     on every visit, and a subject's ~90 variables arrive only when opened. */
  var SUBJECT_CACHE = {};

  function listVars(subject) {
    if (MODE === "static") {
      var rec = (CATALOG.subjects || []).filter(function (s) {
        return String(s.id) === String(subject);
      })[0];
      if (!rec || !rec.file) return Promise.resolve([]);
      if (SUBJECT_CACHE[subject]) return Promise.resolve(SUBJECT_CACHE[subject]);
      return getJSON(DATA + rec.file).then(function (list) {
        SUBJECT_CACHE[subject] = list;
        return list;
      });
    }
    if (MODE === "direct") return BPSApi.getVars(subject, SET);
    return api("/api/vars", { subject: subject });
  }

  function listYears(varId) {
    if (MODE === "static") return Promise.resolve([]);
    if (MODE === "direct") return BPSApi.getYears(varId, SET);
    return api("/api/years", { var: varId });
  }

  function cubeRefFor(v, th) {
    return MODE === "static" ? { data: v.file } : { var: v.var_id, th: th || "latest" };
  }

  // ---------------------------------------------------------------- shell

  document.querySelectorAll("nav button").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll("nav button").forEach(function (x) { x.classList.remove("on"); });
      b.classList.add("on");
      ["explore", "gallery", "files", "settings", "about"].forEach(function (v) {
        $("view-" + v).hidden = v !== b.dataset.view;
      });
      if (b.dataset.view === "gallery") initGallery();
      if (b.dataset.view === "files") loadFiles();
      if (b.dataset.view === "settings") loadSettings();
    });
  });

  $("theme").addEventListener("click", function () {
    var cur = document.documentElement.getAttribute("data-theme");
    var dark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
    try { localStorage.setItem("bps-theme", dark ? "light" : "dark"); } catch (e) { }
    redraw();
  });
  try {
    var saved = localStorage.getItem("bps-theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
  } catch (e) { }

  function banner(msg, action) {
    var b = $("banner");
    b.textContent = "";
    b.hidden = !msg;
    if (!msg) return;
    htm("span", null, b, msg);
    if (action) {
      var link = htm("button", "linkish", b, action.label);
      link.type = "button";
      link.addEventListener("click", action.fn);
    }
  }

  function modeAvailable() {
    var out = [];
    if (LIVE_OK) out.push(["live", "● Layanan lokal"]);
    if (BPSApi.getKey()) out.push(["direct", "● API BPS langsung"]);
    if (CATALOG) out.push(["static", "◐ Data tersimpan"]);
    return out;
  }

  function applyMode() {
    document.querySelector('nav button[data-view="files"]').hidden = MODE !== "live";
    if (MODE !== "live") $("view-files").hidden = true;
    var sel = $("mode");
    var avail = modeAvailable();
    sel.textContent = "";
    avail.forEach(function (m) {
      var o = document.createElement("option");
      o.value = m[0]; o.textContent = m[1];
      sel.appendChild(o);
    });
    sel.value = MODE;
    sel.hidden = avail.length < 2;
    document.body.setAttribute("data-mode", MODE);
  }

  function showModeStatus() {
    var conn = $("conn");
    conn.className = "chip strong";
    if (MODE === "direct") {
      conn.textContent = "API BPS langsung · selalu terbaru";
      banner("");
    } else if (MODE === "live") {
      conn.textContent = HEALTH && HEALTH.key_set
        ? "layanan lokal · selalu terbaru" : "layanan lokal · kunci API belum diisi";
      banner(HEALTH && !HEALTH.key_set
        ? "Belum ada kunci API BPS. Isi di tab Pengaturan, atau tulis ke file .bps_key." : "");
    } else if (CATALOG) {
      conn.textContent = "data tersimpan · " + (CATALOG.variable_count || 0) + " variabel";
      banner("Menampilkan data tersimpan di repositori — diperiksa tiap malam, " +
        "data terakhir berubah " + (CATALOG.generated || "?").slice(0, 10) + ", " +
        "periode terbaru tiap variabel. Isi kunci API BPS Anda untuk mengambil " +
        "langsung dari BPS: seluruh variabel dan periode apa pun. ",
        { label: "Isi kunci API", fn: function () {
          document.querySelector('nav button[data-view="settings"]').click();
          setTimeout(function () { $("s-key").focus(); }, 100);
        } });
    } else {
      conn.textContent = "tidak ada sumber data";
      banner("Isi kunci API BPS di Pengaturan untuk mengambil data langsung dari BPS.");
    }
  }

  function boot() {
    var cat = getJSON(DATA + "index.json").then(function (c) { CATALOG = c; })
      .catch(function () { CATALOG = null; });
    var live = api("/api/health").then(function (d) {
      LIVE_OK = true; return d;
    }).catch(function () { LIVE_OK = false; return null; });

    Promise.all([cat, live]).then(function (r) {
      HEALTH = r[1];
      MODE = LIVE_OK ? "live" : (BPSApi.getKey() ? "direct" : (CATALOG ? "static" : "direct"));
      applyMode();
      showModeStatus();
      loadSubjects();
    });
  }

  $("mode").addEventListener("change", function () {
    switchMode($("mode").value);
  });

  function switchMode(m) {
    MODE = m;
    CUBES = {};
    S = freshState();
    $("card-vars").hidden = true;
    $("card-chart").hidden = true;
    applyMode();
    showModeStatus();
    loadSubjects();
  }

  // ---------------------------------------------------------------- state

  function freshState() {
    return {
      subject: null, subjectTitle: "", varId: null, varTitle: "", varRec: null,
      years: [], th: "latest", opts: {}, hidden: new Set(), spec: null, cube: null
    };
  }
  var S = freshState();
  var F = { file: null, opts: {}, hidden: new Set(), spec: null, cube: null };

  function redraw() {
    if (S.spec) drawInto($("chart"), S.spec, S.hidden);
    if (F.spec) drawInto($("fchart"), F.spec, F.hidden);
  }
  addEventListener("resize", (function () {
    var t;
    return function () { clearTimeout(t); t = setTimeout(redraw, 200); };
  })());

  // ---------------------------------------------------------------- subjects

  var SUBJECTS = [];

  function loadSubjects() {
    $("subjects").textContent = "";
    htm("p", "muted", $("subjects"), "memuat…");
    listSubjects().then(function (rows) {
      SUBJECTS = rows;
      renderSubjects();
      var sel = $("g-subject");
      sel.textContent = "";
      rows.slice().sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); })
        .forEach(function (s) {
          var o = document.createElement("option");
          o.value = s.id; o.textContent = s.id + " — " + s.title;
          sel.appendChild(o);
        });
    }).catch(function (e) {
      $("subjects").textContent = "";
      htm("p", "err", $("subjects"), "Gagal memuat subjek: " + e.message);
    });
  }

  $("q-subject").addEventListener("input", renderSubjects);

  function snapshotCount(id) {
    if (!CATALOG) return 0;
    var rec = (CATALOG.subjects || []).filter(function (s) {
      return String(s.id) === String(id);
    })[0];
    return (rec && rec.count) || 0;
  }

  /* All 37 BPS subjects, grouped by their category, as on the BPS site. */
  function renderSubjects() {
    var q = $("q-subject").value.toLowerCase();
    var rows = SUBJECTS.filter(function (s) {
      return !q || (s.title + " " + s.subcat + " " + s.id).toLowerCase().indexOf(q) >= 0;
    });
    $("subject-count").textContent = rows.length + " dari " + SUBJECTS.length;
    var box = $("subjects");
    box.textContent = "";
    if (!rows.length) {
      htm("p", "muted", box, "Tidak ada subjek yang cocok.");
      return;
    }
    var groups = {};
    rows.forEach(function (s) { (groups[s.subcat] = groups[s.subcat] || []).push(s); });
    Object.keys(groups).sort().forEach(function (cat) {
      htm("h3", "group-title", box, cat);
      var list = htm("div", "subject-list", box);
      groups[cat].sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); })
        .forEach(function (s) {
          var n = snapshotCount(s.id);
          var empty = MODE === "static" && !n;
          var row = htm("button", "subject-row" + (S.subject == s.id ? " on" : "") +
            (empty ? " dim" : ""), list);
          row.type = "button";
          htm("span", "sid", row, s.id);
          htm("span", "stitle", row, s.title);
          if (MODE === "static" && n) htm("span", "pill-ok", row, n + " grafik");
          htm("span", "scount", row, (s.ntabel || 0) + " tabel");
          row.addEventListener("click", function () { pickSubject(s, empty); });
        });
    });
  }

  // ---------------------------------------------------------------- variables

  var VARS = [];

  function pickSubject(s, emptyInSnapshot) {
    S.subject = s.id; S.subjectTitle = s.title;
    renderSubjects();
    $("card-vars").hidden = false;
    $("vars-hint").textContent = "Variabel dinamis di subjek " + s.id + " — " + s.title + ".";
    $("vars").textContent = "";
    if (emptyInSnapshot) {
      VARS = [];
      var box = $("vars");
      // BPS itself lists some subjects with no dynamic tables at all; that is a
      // different situation from a subject the snapshot has not reached.
      htm("p", "muted", box, !s.ntabel
        ? "BPS belum menerbitkan tabel dinamis untuk subjek ini."
        : "Subjek ini belum ada dalam cuplikan tersimpan. Isi kunci API BPS di " +
          "Pengaturan untuk membukanya langsung dari BPS.");
      $("btn-check").hidden = true;
      return;
    }
    htm("p", "muted", $("vars"), "memuat…");
    listVars(s.id).then(function (rows) {
      VARS = rows;
      renderVars();
    }).catch(function (e) {
      $("vars").textContent = "";
      htm("p", "err", $("vars"), "Gagal memuat variabel: " + e.message);
    });
  }

  $("q-var").addEventListener("input", renderVars);

  function renderVars() {
    var q = $("q-var").value.toLowerCase();
    var rows = VARS.filter(function (v) {
      return !q || (v.title + " " + v.var_id).toLowerCase().indexOf(q) >= 0;
    });
    var box = $("vars");
    box.textContent = "";
    $("btn-check").hidden = MODE !== "direct" || !VARS.length;
    if (!VARS.length) {
      htm("p", "muted", box, "Tidak ada variabel.");
      return;
    }
    var table = htm("table", null, box);
    var tr = htm("tr", null, htm("thead", null, table));
    htm("th", null, tr, "Variabel");
    htm("th", null, tr, "Satuan");
    htm("th", null, tr, "Diperbarui");
    htm("th", "num", tr, "ID");
    var tb = htm("tbody", null, table);
    rows.forEach(function (v) {
      var r = htm("tr", "clk" + (S.varId == v.var_id ? " on" : ""), tb);
      htm("td", null, r, v.title);
      htm("td", "muted", r, v.unit || "—");
      var td = htm("td", null, r);
      var when = v.last_update || knownUpdate(v.var_id);
      if (!updateBadge(td, when)) htm("span", "muted", td, "—");
      htm("td", "num muted", r, v.var_id);
      r.addEventListener("click", function () { pickVar(v); });
    });
    if (!rows.length) htm("p", "muted", box, "Tidak ada variabel yang cocok.");
  }

  $("btn-check").addEventListener("click", function () {
    var btn = $("btn-check");
    btn.disabled = true;
    var original = btn.textContent;
    BPSApi.checkUpdates(VARS, SET, function (done, total) {
      btn.textContent = "memeriksa " + done + "/" + total + "…";
    }).then(function () {
      btn.disabled = false;
      btn.textContent = original;
      renderVars();
    });
  });

  function pickVar(v) {
    S.varId = v.var_id; S.varTitle = v.title; S.varRec = v;
    S.opts = {}; S.hidden = new Set();
    renderVars();
    $("card-chart").hidden = false;
    $("chart-title").textContent = v.title;
    $("chart-sub").textContent = "memuat…";
    $("card-chart").scrollIntoView({ behavior: "smooth", block: "start" });
    listYears(v.var_id).then(function (ys) {
      S.years = ys;
      S.th = ys.length ? String(ys[ys.length - 1].th_id) : "latest";
      requestChart();
    }).catch(function (e) {
      $("chart-sub").textContent = "";
      $("chart").textContent = "";
      htm("p", "err", $("chart"), "Gagal memuat daftar tahun: " + e.message);
    });
  }

  // ---------------------------------------------------------------- chart

  function specOpts(opts) {
    return {
      x: opts.x, series: opts.series, chart: opts.chart,
      top: opts.top, sort: opts.sort, includeTotals: !!opts.include_totals,
      pick: {
        vervar: opts.pick_vervar, turvar: opts.pick_turvar, time: opts.pick_time
      }
    };
  }

  function requestChart() {
    var box = $("chart");
    box.classList.add("loading");
    if (!box.firstChild) htm("p", "muted", box, "memuat data…");
    fetchCube(cubeRefFor(S.varRec, S.th)).then(function (cube) {
      S.cube = cube;
      S.spec = BPSInfer.buildSpec(cube, specOpts(S.opts));
      box.classList.remove("loading");
      paint(S.spec, S, $("chart-title"), $("chart-sub"), $("chart-chips"),
        $("controls"), $("chart"), $("table"), requestChart, MODE !== "static");
    }).catch(function (e) {
      box.classList.remove("loading");
      box.textContent = "";
      htm("p", "err", box, "Gagal memuat data: " + e.message);
    });
  }

  function drawInto(box, spec, hidden) {
    BPSChart.render(box, spec, {
      hidden: hidden,
      onToggle: function (id) {
        if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
        drawInto(box, spec, hidden);
      }
    });
  }

  function paint(spec, st, elTitle, elSub, elChips, elControls, elChart, elTable,
                 onChange, withYears) {
    elTitle.textContent = spec.title || st.varTitle || "";
    var sub = [];
    if (spec.subtitle) sub.push(spec.subtitle);
    if (spec.unit) sub.push("satuan: " + spec.unit);
    elSub.textContent = sub.join(" · ");

    elChips.textContent = "";
    htm("span", "chip strong", elChips, spec.chart_label);
    htm("span", "chip", elChips, spec.structure);
    htm("span", "chip", elChips, spec.reason);
    if (st.cube && st.cube.source && st.cube.source.rows) {
      htm("span", "chip", elChips, st.cube.source.rows.toLocaleString("id-ID") + " nilai");
    }
    var when = (st.cube && st.cube.last_update) ||
      (st.varId ? knownUpdate(st.varId) : null);
    if (when && st.varId) BPSApi.rememberUpdate(st.varId, when);
    updateBadge(elChips, when, { long: true });

    buildControls(spec, st, elControls, onChange, withYears);
    drawInto(elChart, spec, st.hidden);
    buildTable(spec, elTable);
  }

  function field(parent, label) {
    var f = htm("div", "field", parent);
    htm("label", null, f, label);
    return f;
  }

  function select(parent, label, options, value, onchange) {
    var f = field(parent, label);
    var s = htm("select", null, f);
    options.forEach(function (o) {
      var n = document.createElement("option");
      n.value = o.value; n.textContent = o.label;
      if (String(o.value) === String(value)) n.selected = true;
      s.appendChild(n);
    });
    s.addEventListener("change", function () { onchange(s.value); });
    return s;
  }

  function buildControls(spec, st, box, onChange, withYears) {
    box.textContent = "";

    if (withYears && st.years && st.years.length) {
      var yopts = [{ value: "all", label: "Semua tahun (" + st.years.length + ")" }];
      st.years.slice().reverse().forEach(function (y) {
        yopts.push({ value: String(y.th_id), label: String(y.th) });
      });
      select(box, "Tahun", yopts, st.th, function (v) {
        st.th = v; st.hidden.clear(); onChange();
      });
    }

    var copts = [{ value: "auto", label: "Otomatis (" + labelOf(spec.auto_chart, spec) + ")" }];
    (spec.alternatives || []).forEach(function (a) {
      copts.push({ value: a.id, label: a.label });
    });
    select(box, "Jenis grafik", copts, st.opts.chart || "auto", function (v) {
      st.opts.chart = v === "auto" ? null : v; onChange();
    });

    var dimOpts = [];
    ["time", "vervar", "turvar"].forEach(function (d) {
      var dim = spec.dims[d];
      if (dim && dim.n > 1 && !dim.degenerate) {
        dimOpts.push({ value: d, label: dim.label + " (" + dim.n + ")" });
      }
    });
    if (dimOpts.length > 1) {
      select(box, "Sumbu X", dimOpts, spec.roles.x, function (v) {
        st.opts.x = v; st.opts.series = null; st.hidden.clear(); onChange();
      });
      var sopts = [{ value: "", label: "— tanpa seri —" }].concat(
        dimOpts.filter(function (o) { return o.value !== spec.roles.x; }));
      select(box, "Seri (warna)", sopts, spec.roles.series || "", function (v) {
        st.opts.series = v || "none"; st.hidden.clear(); onChange();
      });
    }

    Object.keys(spec.roles.picks || {}).forEach(function (d) {
      var dim = spec.dims[d];
      if (!dim || !dim.n || dim.degenerate) return;
      var opts = [];
      if (d !== "time") {
        if (dim.additive) opts.push({ value: "__sum__", label: "▣ Jumlah semua" });
        opts.push({ value: "__avg__", label: "▣ Rata-rata" });
      }
      dim.members.forEach(function (m) {
        opts.push({ value: m.id, label: m.label + (m.is_total ? " (total)" : "") });
      });
      select(box, dim.label, opts, spec.roles.picks[d], function (v) {
        st.opts["pick_" + d] = v; onChange();
      });
    });

    if ((spec.totals_dropped && spec.totals_dropped.length) || spec.include_totals) {
      var f = field(box, "Baris agregat");
      var lab = htm("label", "checkline", f);
      var cb = htm("input", null, lab);
      cb.type = "checkbox";
      cb.checked = !!spec.include_totals;
      htm("span", null, lab, "sertakan total");
      cb.addEventListener("change", function () {
        st.opts.include_totals = cb.checked; st.hidden.clear(); onChange();
      });
    }

    if (spec.x.type === "category") {
      select(box, "Urutkan", [
        { value: "value", label: "Nilai terbesar" },
        { value: "natural", label: "Urutan asli" }
      ], st.opts.sort || "value", function (v) { st.opts.sort = v; onChange(); });
      var total = spec.truncated ? spec.truncated.total : spec.x.categories.length;
      if (total > 10) {
        var steps = [10, 20, 34, 50, 100].filter(function (n) { return n < total; });
        steps.push(total);
        select(box, "Tampilkan", steps.map(function (n) {
          return { value: n, label: n === total ? "semua (" + n + ")" : n + " teratas" };
        }), st.opts.top || 20, function (v) { st.opts.top = v; onChange(); });
      }
    }
  }

  function labelOf(id, spec) {
    var hit = (spec.alternatives || []).filter(function (a) { return a.id === id; })[0];
    return hit ? hit.label : id;
  }

  function buildTable(spec, box) {
    box.textContent = "";
    var table = htm("table", null, box);
    var tr = htm("tr", null, htm("thead", null, table));
    htm("th", null, tr, spec.x.label);
    spec.series.forEach(function (s) { htm("th", null, tr, s.label); });
    var tb = htm("tbody", null, table);
    spec.x.categories.forEach(function (c, i) {
      var r = htm("tr", null, tb);
      htm("td", null, r, c.full || c.label);
      spec.series.forEach(function (s) { htm("td", null, r, BPSChart.fmt(s.values[i])); });
    });
  }

  // buttons ------------------------------------------------------------
  function wireButtons(prefix, getState, chartBox, tableBox) {
    var tbtn = $(prefix + "btn-table");
    tbtn.addEventListener("click", function () {
      tableBox.hidden = !tableBox.hidden;
      tbtn.classList.toggle("on", !tableBox.hidden);
    });
    var svgBtn = $(prefix + "btn-svg");
    if (svgBtn) svgBtn.addEventListener("click", function () {
      var st = getState();
      if (!st.spec) return;
      download(slug(st.spec.title) + ".svg", BPSChart.svgString(chartBox), "image/svg+xml");
    });
    var pngBtn = $(prefix + "btn-png");
    if (pngBtn) pngBtn.addEventListener("click", function () {
      var st = getState();
      if (!st.spec) return;
      var svg = BPSChart.svgString(chartBox);
      var node = chartBox.querySelector("svg");
      var vb = node.getAttribute("viewBox").split(" ");
      var w = +vb[2], h = +vb[3], scale = 2;
      var img = new Image();
      img.onload = function () {
        var cv = document.createElement("canvas");
        cv.width = w * scale; cv.height = h * scale;
        var g = cv.getContext("2d");
        g.scale(scale, scale);
        g.drawImage(img, 0, 0);
        cv.toBlob(function (b) {
          var a = document.createElement("a");
          a.href = URL.createObjectURL(b);
          a.download = slug(st.spec.title) + ".png";
          document.body.appendChild(a); a.click(); a.remove();
        });
      };
      img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
    });
  }

  wireButtons("", function () { return S; }, $("chart"), $("table"));
  wireButtons("f", function () { return F; }, $("fchart"), $("ftable"));

  $("btn-csv").addEventListener("click", function () {
    if (MODE === "live" && S.varId) {
      location.href = API + "/api/data.csv" + qs({ var: S.varId, th: S.th });
    } else if (S.cube) {
      download("data_var" + S.cube.var_id + ".csv", BPSInfer.toCSV(S.cube),
        "text/csv;charset=utf-8");
    }
  });

  // ---------------------------------------------------------------- gallery

  var galleryReady = false;

  function initGallery() {
    if (galleryReady) return;
    galleryReady = true;
    $("g-go").addEventListener("click", runGallery);
  }

  function runGallery() {
    var subject = $("g-subject").value;
    var limit = +$("g-count").value;
    var box = $("gallery");
    box.textContent = "";
    htm("p", "muted", htm("div", "card", box), "memuat daftar variabel…");
    listVars(subject).then(function (vars) {
      box.textContent = "";
      var list = vars.slice(0, limit);
      if (!list.length) {
        htm("p", "muted", htm("div", "card", box),
          "Tidak ada variabel untuk subjek ini pada sumber data yang aktif.");
        return;
      }
      var queue = list.map(function (v) {
        var card = htm("div", "card", box);
        htm("p", "chart-title", card, v.title);
        var meta = htm("p", "chart-sub", card);
        htm("span", null, meta, "var " + v.var_id + (v.unit ? " · " + v.unit : ""));
        var chips = htm("div", "chips", card);
        var plot = htm("div", null, card);
        htm("p", "muted", plot, "menunggu…");
        return { v: v, card: card, chips: chips, plot: plot, done: false };
      });
      pump(queue);
    }).catch(function (e) {
      box.textContent = "";
      htm("p", "err", htm("div", "card", box), e.message);
    });
  }

  function pump(queue) {
    var running = 0;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var item = queue.filter(function (q) { return q.card === en.target; })[0];
        if (en.isIntersecting && item && !item.done) { item.wanted = true; next(); }
      });
    }, { rootMargin: "300px" });
    queue.forEach(function (q) { io.observe(q.card); });
    queue.slice(0, 4).forEach(function (q) { q.wanted = true; });
    next();

    function next() {
      while (running < 2) {
        var item = queue.filter(function (q) { return q.wanted && !q.done && !q.busy; })[0];
        if (!item) return;
        item.busy = true; running++;
        item.plot.textContent = "";
        htm("span", "spinner", htm("p", "muted", item.plot));
        fetchCube(cubeRefFor(item.v, "latest")).then(function (cube) {
          item.done = true; running--;
          var spec = BPSInfer.buildSpec(cube, {});
          item.plot.textContent = "";
          item.chips.textContent = "";
          htm("span", "chip strong", item.chips, spec.chart_label);
          htm("span", "chip", item.chips, spec.structure);
          updateBadge(item.chips, cube.last_update || knownUpdate(item.v.var_id));
          BPSChart.render(item.plot, spec, {
            hidden: new Set(), height: 240, onToggle: function () { }
          });
          next();
        }).catch(function (e) {
          item.done = true; running--;
          item.plot.textContent = "";
          htm("p", "err", item.plot, e.message);
          next();
        });
      }
    }
  }

  // ---------------------------------------------------------------- files

  function loadFiles() {
    var box = $("files");
    box.textContent = "";
    htm("p", "muted", box, "memuat…");
    api("/api/localfiles").then(function (rows) {
      box.textContent = "";
      if (!rows.length) {
        htm("p", "muted", box, "Belum ada CSV tidy di folder aplikasi. " +
          "Jalankan bps_chart.py get --var … atau tambahkan --data-dir.");
        return;
      }
      var table = htm("table", null, box);
      var tr = htm("tr", null, htm("thead", null, table));
      htm("th", null, tr, "Berkas");
      htm("th", "num", tr, "Ukuran");
      var tb = htm("tbody", null, table);
      rows.forEach(function (f) {
        var r = htm("tr", "clk" + (F.file === f.name ? " on" : ""), tb);
        htm("td", null, r, f.name);
        htm("td", "num muted", r, (f.size / 1024).toFixed(0) + " KB");
        r.addEventListener("click", function () {
          F.file = f.name; F.opts = {}; F.hidden = new Set();
          $("card-fchart").hidden = false;
          loadFiles();
          requestFileChart();
        });
      });
    }).catch(function (e) {
      box.textContent = "";
      htm("p", "err", box, e.message);
    });
  }

  function requestFileChart() {
    var box = $("fchart");
    box.classList.add("loading");
    getJSON(API + "/api/cube" + qs({ file: F.file })).then(function (cube) {
      F.cube = cube;
      F.spec = BPSInfer.buildSpec(cube, specOpts(F.opts));
      box.classList.remove("loading");
      paint(F.spec, F, $("fchart-title"), $("fchart-sub"), $("fchart-chips"),
        $("fcontrols"), $("fchart"), $("ftable"), requestFileChart, false);
    }).catch(function (e) {
      box.classList.remove("loading");
      box.textContent = "";
      htm("p", "err", box, e.message);
    });
  }

  // ---------------------------------------------------------------- settings

  var settingsWired = false;

  function loadSettings() {
    $("s-lang").value = SET.lang;
    $("s-key-state").textContent = BPSApi.getKey()
      ? "Kunci tersimpan di browser ini (" + BPSApi.maskKey() + ")."
      : "Belum ada kunci di browser ini.";
    $("s-domain-wrap").hidden = false;

    if (MODE === "live") {
      api("/api/settings").then(function (s) {
        $("s-lang").value = s.lang;
        $("s-status").textContent = s.key_set
          ? "Layanan lokal aktif dengan kunci di .bps_key (" + s.key_masked + ")."
          : "Layanan lokal aktif, tetapi .bps_key masih kosong.";
        fillDomains(s.domain);
      }).catch(function () { });
    } else {
      $("s-status").textContent = MODE === "direct"
        ? "Browser mengambil data langsung dari webapi.bps.go.id."
        : "Sedang memakai data tersimpan di repositori.";
      if (BPSApi.getKey()) fillDomains(SET.domain);
    }

    if (settingsWired) return;
    settingsWired = true;

    $("s-save").addEventListener("click", function () {
      var key = $("s-key").value.trim();
      SET.lang = $("s-lang").value;
      if ($("s-domain").value) SET.domain = $("s-domain").value;
      saveSettings();
      if (key) BPSApi.setKey(key);
      $("s-key").value = "";
      if (MODE === "live") {
        post("/api/settings", {
          domain: SET.domain, lang: SET.lang, key: key
        }).then(function () { CUBES = {}; loadSubjects(); loadSettings(); });
      } else {
        CUBES = {};
        if (BPSApi.getKey() && MODE !== "direct") switchMode("direct");
        else { applyMode(); showModeStatus(); loadSubjects(); }
        loadSettings();
      }
    });

    $("s-forget").addEventListener("click", function () {
      BPSApi.setKey("");
      CUBES = {};
      if (MODE === "direct") switchMode(CATALOG ? "static" : "direct");
      else { applyMode(); showModeStatus(); }
      loadSettings();
    });

    $("s-clear").addEventListener("click", function () {
      CUBES = {};
      if (MODE === "live") {
        post("/api/clear_cache").then(function (d) {
          $("s-status").textContent = "Cache dikosongkan (" + (d.removed || 0) + " berkas).";
        });
      } else {
        $("s-status").textContent = "Cache di browser dikosongkan.";
      }
    });
  }

  var domainsLoaded = false;

  function fillDomains(current) {
    if (domainsLoaded) { $("s-domain").value = current || SET.domain; return; }
    var p = MODE === "live" ? api("/api/domains") : BPSApi.getDomains();
    p.then(function (ds) {
      domainsLoaded = true;
      var sel = $("s-domain");
      sel.textContent = "";
      ds.forEach(function (d) {
        var o = document.createElement("option");
        o.value = d.id; o.textContent = d.id + " — " + d.name;
        sel.appendChild(o);
      });
      sel.value = current || SET.domain;
    }).catch(function () { });
  }

  boot();
})();

/* BPS Dashboard - UI.
 *
 * Talks to the local Python service (bps_dashboard.py) which holds the API key
 * and calls webapi.bps.go.id. When this page is served from GitHub Pages it
 * points at http://127.0.0.1:8766; when served by the app itself it uses the
 * same origin.
 */
(function () {
  "use strict";

  var LOCAL = "http://127.0.0.1:8766";
  var BASE = (location.protocol === "file:" || /github\.io$/.test(location.hostname))
    ? LOCAL : "";

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
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (v === null || v === undefined || v === "") return;
      p.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
    });
    return p.length ? "?" + p.join("&") : "";
  }

  function get(path, params) {
    return fetch(BASE + path + qs(params || {}))
      .then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d && d.error ? d.error : "HTTP " + r.status);
          return d;
        });
      });
  }

  function post(path, body) {
    return fetch(BASE + path, {
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
    var dark = cur ? cur === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
    try { localStorage.setItem("bps-theme", dark ? "light" : "dark"); } catch (e) { }
    redraw();
  });
  try {
    var saved = localStorage.getItem("bps-theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
  } catch (e) { }

  function banner(msg) {
    var b = $("banner");
    b.hidden = !msg;
    b.textContent = msg || "";
  }

  get("/api/health").then(function (d) {
    $("conn").textContent = d.key_set ? "terhubung" : "terhubung · kunci API belum diisi";
    $("conn").classList.add("strong");
    if (!d.key_set) banner("Belum ada kunci API BPS. Isi di tab Pengaturan, atau tulis ke file .bps_key.");
    loadSubjects();
  }).catch(function () {
    $("conn").textContent = "layanan lokal mati";
    banner("Tidak dapat menghubungi layanan lokal di " + LOCAL +
      ". Jalankan `python bps_dashboard.py` (atau klik dua kali \"Start BPS Dashboard.bat\") lalu muat ulang halaman ini.");
  });

  // ---------------------------------------------------------------- state

  var S = {
    subject: null, subjectTitle: "", varId: null, varTitle: "",
    years: [], th: "latest", opts: {}, hidden: new Set(), spec: null
  };
  var F = { file: null, opts: {}, hidden: new Set(), spec: null };

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
    get("/api/subjects").then(function (rows) {
      SUBJECTS = rows;
      renderSubjects();
      var sel = $("g-subject");
      sel.textContent = "";
      rows.slice().sort(function (a, b) { return a.title.localeCompare(b.title); })
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

  function renderSubjects() {
    var q = $("q-subject").value.toLowerCase();
    var rows = SUBJECTS.filter(function (s) {
      return !q || (s.title + " " + s.subcat + " " + s.id).toLowerCase().indexOf(q) >= 0;
    });
    var box = $("subjects");
    box.textContent = "";
    var groups = {};
    rows.forEach(function (s) { (groups[s.subcat] = groups[s.subcat] || []).push(s); });
    var table = htm("table", null, box);
    var thead = htm("thead", null, table);
    var tr = htm("tr", null, thead);
    htm("th", null, tr, "Subjek");
    htm("th", null, tr, "Kategori");
    htm("th", "num", tr, "Tabel");
    var tb = htm("tbody", null, table);
    Object.keys(groups).sort().forEach(function (cat) {
      groups[cat].forEach(function (s) {
        var r = htm("tr", "clk" + (S.subject == s.id ? " on" : ""), tb);
        htm("td", null, r, s.id + " — " + s.title);
        htm("td", "muted", r, cat);
        htm("td", "num muted", r, s.ntabel || "");
        r.addEventListener("click", function () { pickSubject(s); });
      });
    });
    if (!rows.length) htm("p", "muted", box, "Tidak ada subjek yang cocok.");
  }

  // ---------------------------------------------------------------- variables

  var VARS = [];

  function pickSubject(s) {
    S.subject = s.id; S.subjectTitle = s.title;
    renderSubjects();
    $("card-vars").hidden = false;
    $("vars-hint").textContent = "Variabel dinamis di subjek " + s.id + " — " + s.title + ".";
    $("vars").textContent = "";
    htm("p", "muted", $("vars"), "memuat…");
    get("/api/vars", { subject: s.id }).then(function (rows) {
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
    var table = htm("table", null, box);
    var tr = htm("tr", null, htm("thead", null, table));
    htm("th", null, tr, "Variabel");
    htm("th", null, tr, "Satuan");
    htm("th", "num", tr, "ID");
    var tb = htm("tbody", null, table);
    rows.forEach(function (v) {
      var r = htm("tr", "clk" + (S.varId == v.var_id ? " on" : ""), tb);
      htm("td", null, r, v.title);
      htm("td", "muted", r, v.unit || "—");
      htm("td", "num muted", r, v.var_id);
      r.addEventListener("click", function () { pickVar(v); });
    });
    if (!rows.length) htm("p", "muted", box, "Tidak ada variabel yang cocok.");
  }

  function pickVar(v) {
    S.varId = v.var_id; S.varTitle = v.title;
    S.opts = {}; S.hidden = new Set(); S.th = "latest";
    renderVars();
    $("card-chart").hidden = false;
    $("chart-title").textContent = v.title;
    $("chart-sub").textContent = "memuat periode…";
    $("card-chart").scrollIntoView({ behavior: "smooth", block: "start" });
    get("/api/years", { var: v.var_id }).then(function (ys) {
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

  function chartParams(opts, extra) {
    var p = {
      x: opts.x, series: opts.series, chart: opts.chart,
      top: opts.top, sort: opts.sort,
      include_totals: opts.include_totals ? 1 : null
    };
    ["vervar", "turvar", "time"].forEach(function (d) {
      if (opts["pick_" + d]) p["pick_" + d] = opts["pick_" + d];
    });
    return Object.assign(p, extra || {});
  }

  function requestChart() {
    var box = $("chart");
    box.classList.add("loading");
    if (!box.firstChild) {
      box.textContent = "";
      htm("p", "muted", box, "memuat data…");
    }
    get("/api/chart", chartParams(S.opts, { var: S.varId, th: S.th }))
      .then(function (spec) {
        S.spec = spec;
        box.classList.remove("loading");
        paint(spec, S, $("chart-title"), $("chart-sub"), $("chart-chips"),
          $("controls"), $("chart"), $("table"), requestChart, true);
      })
      .catch(function (e) {
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
    if (spec.source && spec.source.rows) {
      htm("span", "chip", elChips, spec.source.rows.toLocaleString("id-ID") + " baris data");
    }

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
      select(box, "Tahun", yopts, st.th, function (v) { st.th = v; st.hidden.clear(); onChange(); });
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
      if (dim.additive && d !== "time") {
        opts.push({ value: "__sum__", label: "▣ Jumlah semua" });
        opts.push({ value: "__avg__", label: "▣ Rata-rata" });
      } else if (d !== "time") {
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
      var lab = htm("label", null, f);
      lab.style.cssText = "display:flex;gap:6px;align-items:center;font-size:13px;padding:6px 0";
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
      spec.series.forEach(function (s) {
        htm("td", null, r, BPSChart.fmt(s.values[i]));
      });
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
      img.src = "data:image/svg+xml;base64," +
        btoa(unescape(encodeURIComponent(svg)));
    });
  }

  wireButtons("", function () { return S; }, $("chart"), $("table"));
  wireButtons("f", function () { return F; }, $("fchart"), $("ftable"));

  $("btn-csv").addEventListener("click", function () {
    if (!S.varId) return;
    location.href = BASE + "/api/data.csv" + qs({ var: S.varId, th: S.th });
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
    var info = htm("div", "card", box);
    htm("p", "muted", info, "memuat daftar variabel…");
    get("/api/vars", { subject: subject }).then(function (vars) {
      box.textContent = "";
      var list = vars.slice(0, limit);
      if (!list.length) { htm("p", "muted", htm("div", "card", box), "Tidak ada variabel."); return; }
      var queue = [];
      list.forEach(function (v) {
        var card = htm("div", "card", box);
        htm("p", "chart-title", card, v.title);
        htm("p", "chart-sub", card, "var " + v.var_id + (v.unit ? " · " + v.unit : ""));
        var chips = htm("div", "chips", card);
        var plot = htm("div", null, card);
        htm("p", "muted", plot, "menunggu…");
        queue.push({ v: v, card: card, chips: chips, plot: plot, done: false });
      });
      pump(queue);
    });
  }

  function pump(queue) {
    var running = 0, i = 0;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var item = queue.filter(function (q) { return q.card === en.target; })[0];
        if (item && !item.done) { item.wanted = true; next(); }
      });
    }, { rootMargin: "300px" });
    queue.forEach(function (q) { io.observe(q.card); });
    // The observer only fires for a visible tab, so the first screenful is
    // requested outright; the rest still wait until they are scrolled near.
    queue.slice(0, 4).forEach(function (q) { q.wanted = true; });
    next();

    function next() {
      while (running < 2) {
        var item = queue.filter(function (q) { return q.wanted && !q.done && !q.busy; })[0];
        if (!item) return;
        item.busy = true; running++;
        item.plot.textContent = "";
        var sp = htm("p", "muted", item.plot);
        htm("span", "spinner", sp);
        get("/api/chart", { var: item.v.var_id, th: "latest" })
          .then(function (spec) {
            item.done = true; running--;
            item.plot.textContent = "";
            item.chips.textContent = "";
            htm("span", "chip strong", item.chips, spec.chart_label);
            htm("span", "chip", item.chips, spec.structure);
            if (spec.subtitle) htm("span", "chip", item.chips, spec.subtitle);
            BPSChart.render(item.plot, spec, {
              hidden: new Set(), height: 240,
              onToggle: function () { }
            });
            next();
          })
          .catch(function (e) {
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
    get("/api/localfiles").then(function (rows) {
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
    get("/api/chart", chartParams(F.opts, { file: F.file })).then(function (spec) {
      F.spec = spec;
      box.classList.remove("loading");
      paint(spec, F, $("fchart-title"), $("fchart-sub"), $("fchart-chips"),
        $("fcontrols"), $("fchart"), $("ftable"), requestFileChart, false);
    }).catch(function (e) {
      box.classList.remove("loading");
      box.textContent = "";
      htm("p", "err", box, e.message);
    });
  }

  // ---------------------------------------------------------------- settings

  var settingsReady = false;

  function loadSettings() {
    get("/api/settings").then(function (s) {
      $("s-lang").value = s.lang;
      $("s-status").textContent = s.key_set
        ? "Kunci API aktif (" + s.key_masked + ")." : "Belum ada kunci API.";
      if (!settingsReady) {
        settingsReady = true;
        get("/api/domains").then(function (ds) {
          var sel = $("s-domain");
          sel.textContent = "";
          ds.forEach(function (d) {
            var o = document.createElement("option");
            o.value = d.id; o.textContent = d.id + " — " + d.name;
            sel.appendChild(o);
          });
          sel.value = s.domain;
        }).catch(function () { });
        $("s-save").addEventListener("click", function () {
          post("/api/settings", {
            domain: $("s-domain").value, lang: $("s-lang").value,
            key: $("s-key").value
          }).then(function () {
            $("s-key").value = "";
            $("s-status").textContent = "Tersimpan. Memuat ulang subjek…";
            loadSubjects();
            loadSettings();
          });
        });
        $("s-clear").addEventListener("click", function () {
          post("/api/clear_cache").then(function (d) {
            $("s-status").textContent = "Cache dikosongkan (" + (d.removed || 0) + " berkas).";
          });
        });
      }
    }).catch(function (e) {
      $("s-status").textContent = e.message;
    });
  }
})();

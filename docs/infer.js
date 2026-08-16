/* BPS Dashboard - chart inference.
 *
 * Every BPS variable arrives as the same cube -- entities (vervar) x categories
 * (turvar) x periods (year x sub-year) -- but the *shape* differs per variable,
 * and that shape decides the chart. This file is the decision, in one place:
 * it runs in the browser, so the live app, the static GitHub Pages build and
 * the exported HTML all reach the same conclusion from the same code.
 *
 *   cube -> summarize()  -> dimensions (sizes, roll-ups, magnitudes)
 *        -> buildSpec()  -> {chart, x, series, color, reason, alternatives}
 *
 * The decision table (after roles are assigned and filters applied):
 *
 *   x = time      1 series, >=3 points ........ line
 *                 1 series, <=2 points ........ bar
 *                 2-8 series, parts of a whole  stacked area / stacked bar
 *                 2-8 series, otherwise ....... multi-line
 *                 9-16 series ................. small multiples
 *                 >16 series .................. heatmap
 *
 *   x = category  1 series, values cross zero .. diverging bar
 *                 1 series, <=8 categories .... bar
 *                 1 series, >8 categories ..... ranked horizontal bar
 *                 2-8 series, parts of a whole  stacked bar (100% for shares)
 *                 2-4 series, otherwise ....... grouped bar
 *                 >8 series ................... heatmap
 *
 * Never more than 8 colour slots: past that the form changes (small multiples
 * or heatmap) rather than the palette growing.
 *
 * Cube: {var_id, title, unit, vervar:[[id,label]], turvar:[[id,label]],
 *        time:[[id,label,full]], values:[vervar][turvar][time] -> number|null}
 */
(function (global) {
  "use strict";

  // Labels BPS uses for a roll-up member. A roll-up must not be stacked with,
  // or ranked against, its own parts.
  var TOTAL_RE = /^(jumlah|total|jumlah\/total|indonesia|nasional|seluruh|semua|jumlah total|total keseluruhan|rata-rata|kumulatif|jan\s*-\s*des|januari\s*-\s*desember|tahunan)\b/i;

  // Units/titles whose values must never be summed: rates, indices, ratios and
  // per-capita figures are not additive across regions or categories.
  var NON_ADDITIVE_RE = /(persen|percent|%|indeks|index|rasio|ratio|rata-rata|average|laju|pertumbuhan|growth|tingkat|per\s|\/\s*orang|per kapita|per capita|jiwa\/km|poin|angka harapan|umur)/i;

  var DEGENERATE_RE = /^(tidak ada|-|n\/a|none)$/i;

  var MAX_SERIES = 8;            // categorical colour slots
  var SMALL_MULTIPLES_MAX = 16;
  var DEFAULT_TOP = 20;
  var HEATMAP_MAX_ROWS = 40;
  var HEATMAP_MAX_COLS = 60;
  var AGG_SUM = "__sum__", AGG_AVG = "__avg__";

  var DIM_LABELS = {
    vervar: "Wilayah / entitas", turvar: "Kategori", time: "Periode"
  };

  var CHART_LABELS = {
    line: "Garis", bar: "Batang", hbar: "Batang horizontal",
    diverging_bar: "Batang divergen", grouped_bar: "Batang berkelompok",
    hbar_grouped: "Batang horizontal berkelompok",
    stacked_bar: "Batang bertumpuk", stacked_bar_100: "Batang bertumpuk 100%",
    stacked_area: "Area bertumpuk", stacked_area_100: "Area bertumpuk 100%",
    small_multiples: "Panel kecil", heatmap: "Heatmap",
    histogram: "Histogram", donut: "Donat", stat: "Angka tunggal"
  };

  var STACKED = {
    stacked_bar: 1, stacked_bar_100: 1, stacked_area: 1, stacked_area_100: 1
  };

  var DIMS = ["vervar", "turvar", "time"];

  function isTotalLabel(s) { return !!s && TOTAL_RE.test(String(s).trim()); }

  /* The bare sub-period name of a time member ("Tahunan", "Januari", "TW I").
     A producer may supply it as a 4th element; otherwise it is the label with
     its year prefix removed, since periods are stored year-first ("2022
     Tahunan"). An annual series has no sub-period at all ("2022"), which
     correctly yields "" -- those must never be treated as roll-ups. */
  function periodName(m) {
    if (m[3]) return String(m[3]).trim();
    var full = String(m[2] || m[1] || "");
    var hit = /^\s*\d{4}\s+(.+)$/.exec(full);
    return hit ? hit[1].trim() : "";
  }

  // ---------------------------------------------------------------- summarize

  function summarize(cube) {
    var n = {
      vervar: cube.vervar.length, turvar: cube.turvar.length,
      time: cube.time.length
    };
    var mag = {
      vervar: new Array(n.vervar).fill(0),
      turvar: new Array(n.turvar).fill(0),
      time: new Array(n.time).fill(0)
    };
    for (var a = 0; a < n.vervar; a++) {
      for (var b = 0; b < n.turvar; b++) {
        var row = cube.values[a][b];
        for (var c = 0; c < n.time; c++) {
          var v = row[c];
          if (v === null || v === undefined) continue;
          var m = Math.abs(v);
          mag.vervar[a] += m; mag.turvar[b] += m; mag.time[c] += m;
        }
      }
    }
    var nonAdditive = NON_ADDITIVE_RE.test((cube.unit || "") + " " + (cube.title || ""));
    var out = { unit: cube.unit || "", title: cube.title || "", additive: !nonAdditive };
    DIMS.forEach(function (dim) {
      var src = cube[dim];
      var members = src.map(function (m, i) {
        var label = dim === "time" ? m[1] : (m[1] || "");
        return {
          id: m[0], label: label, full: dim === "time" ? (m[2] || label) : label,
          // labelTotal: the NAME says roll-up ("Tahunan", "Jumlah", "INDONESIA").
          // A period label is year-prefixed ("2022 Tahunan"), so test its bare
          // sub-period name (m[3]) instead. isTotal may additionally be set
          // later by the numeric heuristic.
          labelTotal: dim === "time"
            ? isTotalLabel(periodName(m)) : isTotalLabel(label),
          isTotal: dim === "time"
            ? isTotalLabel(periodName(m)) : isTotalLabel(label),
          magnitude: mag[dim][i]
        };
      });
      out[dim] = {
        key: dim, label: DIM_LABELS[dim], n: members.length, members: members,
        degenerate: members.length === 1 &&
          (!members[0].label || DEGENERATE_RE.test(members[0].label)),
        additive: !nonAdditive
      };
    });
    return out;
  }

  function describe(dims) {
    var nouns = { vervar: "entitas", turvar: "kategori", time: "periode" };
    var bits = [];
    DIMS.forEach(function (d) {
      if (!dims[d].degenerate && dims[d].n > 0) bits.push(dims[d].n + " " + nouns[d]);
    });
    return bits.length ? bits.join(" x ") : "nilai tunggal";
  }

  // ---------------------------------------------------------------- roles

  function isFree(dims, d) { return dims[d].n > 1 && !dims[d].degenerate; }

  /* Time wins the x axis whenever it varies -- readers expect it there. The
     smaller of the remaining dimensions takes colour (the scarce channel), the
     larger one is held fixed behind a selector. */
  function assignRoles(dims, x, series) {
    var free = DIMS.filter(function (d) { return isFree(dims, d); });
    var noSeries = series === "none";
    if (free.indexOf(x) < 0) x = null;
    if (free.indexOf(series) < 0) series = null;

    if (!x) {
      if (free.indexOf("time") >= 0) x = "time";
      else if (free.length) x = free.indexOf("vervar") >= 0 ? "vervar" : free[0];
      else x = dims.time.n ? "time" : "vervar";
    }
    var rest = free.filter(function (d) { return d !== x; });
    if (!series && rest.length && !noSeries) {
      series = rest.length === 1 ? rest[0]
        : rest.reduce(function (a, b) { return dims[a].n <= dims[b].n ? a : b; });
    }
    if (series === x) series = null;
    var filters = DIMS.filter(function (d) { return d !== x && d !== series; });
    return { x: x, series: series, filters: filters };
  }

  function defaultPick(dims, dim) {
    var ms = dims[dim].members;
    if (!ms.length) return null;
    if (dim === "time") {                                 // latest real period
      for (var t = ms.length - 1; t >= 0; t--) {
        if (!ms[t].labelTotal) return ms[t].id;           // skip "Tahunan" etc.
      }
      return ms[ms.length - 1].id;                        // all are roll-ups
    }
    var real = ms.filter(function (m) { return !m.isTotal; });
    if (!real.length) real = ms;
    return real.reduce(function (a, b) {
      return a.magnitude >= b.magnitude ? a : b;
    }).id;
  }

  // ---------------------------------------------------------------- pivot

  function pivot(cube, dims, xDim, seriesDim, picks) {
    var idx = {};
    DIMS.forEach(function (d) {
      idx[d] = {};
      dims[d].members.forEach(function (m, i) { idx[d][m.id] = i; });
    });
    var keep = {};
    DIMS.forEach(function (d) {
      var p = picks[d];
      if (p === undefined || p === null || p === AGG_SUM || p === AGG_AVG) keep[d] = null;
      else keep[d] = idx[d][p];
    });
    var avg = DIMS.some(function (d) { return picks[d] === AGG_AVG; });

    var grid = {}, counts = {};
    var nv = dims.vervar.n, nt = dims.turvar.n, np = dims.time.n;
    for (var a = 0; a < nv; a++) {
      if (keep.vervar !== null && keep.vervar !== a) continue;
      for (var b = 0; b < nt; b++) {
        if (keep.turvar !== null && keep.turvar !== b) continue;
        var row = cube.values[a][b];
        for (var c = 0; c < np; c++) {
          if (keep.time !== null && keep.time !== c) continue;
          var v = row[c];
          if (v === null || v === undefined) continue;
          var pos = { vervar: a, turvar: b, time: c };
          var sid = seriesDim ? dims[seriesDim].members[pos[seriesDim]].id : "__one__";
          var xid = dims[xDim].members[pos[xDim]].id;
          if (!grid[sid]) { grid[sid] = {}; counts[sid] = {}; }
          grid[sid][xid] = (grid[sid][xid] || 0) + v;
          counts[sid][xid] = (counts[sid][xid] || 0) + 1;
        }
      }
    }
    if (avg) {
      Object.keys(grid).forEach(function (sid) {
        Object.keys(grid[sid]).forEach(function (xid) {
          grid[sid][xid] /= (counts[sid][xid] || 1);
        });
      });
    }
    return grid;
  }

  /* Members whose values equal the sum of the other members.
     BPS does not name every roll-up "Jumlah": var 2534 calls it "PDRB" and var
     1161 calls it "INDONESIA", so it is found numerically, not by label. */
  function numericTotals(grid, rowIds, colIds, tol, hitRatio) {
    tol = tol || 0.02; hitRatio = hitRatio || 0.8;
    var out = {};
    if (rowIds.length < 3) return out;
    rowIds.forEach(function (cand) {
      var others = rowIds.filter(function (r) { return r !== cand; });
      var hits = 0, seen = 0;
      colIds.forEach(function (c) {
        var cv = grid[cand] ? grid[cand][c] : undefined;
        if (cv === undefined || cv === 0) return;
        var s = 0;
        others.forEach(function (o) { s += (grid[o] && grid[o][c]) || 0; });
        seen++;
        if (Math.abs(cv - s) <= tol * Math.abs(cv)) hits++;
      });
      if (seen && hits / seen >= hitRatio) out[cand] = 1;
    });
    return out;
  }

  function transpose(grid) {
    var out = {};
    Object.keys(grid).forEach(function (rid) {
      Object.keys(grid[rid]).forEach(function (cid) {
        (out[cid] = out[cid] || {})[rid] = grid[rid][cid];
      });
    });
    return out;
  }

  /* Stackable only with evidence of a whole: either a sibling equal to the sum
     of the others exists, or the values are percentages adding to 100. Without
     it the categories may be alternative measures of the same thing -- BPS
     ships plenty, e.g. a variable split into "Harga Berlaku" and "Harga
     Konstan" -- and stacking those adds quantities that must never be added. */
  function isPartToWhole(dims, seriesDim, members, nonneg, evidence) {
    if (seriesDim !== "turvar" || members.length < 2) return false;
    if (!dims.additive || !nonneg) return false;
    return !!evidence;
  }

  // ---------------------------------------------------------------- choice

  function chooseChart(xDim, nX, nSeries, partToWhole, crossesZero, shares) {
    if (nX === 1 && nSeries === 1) {
      // one number is not a chart; a one-bar bar chart says nothing more
      return ["stat", "hanya satu nilai -> angka tunggal"];
    }
    if (xDim === "time") {
      if (nSeries <= 1) {
        return nX >= 3
          ? ["line", "1 seri x " + nX + " periode -> tren garis"]
          : ["bar", "hanya " + nX + " periode -> batang lebih jelas dari garis"];
      }
      if (partToWhole) {
        if (nX >= 4) {
          return [shares ? "stacked_area_100" : "stacked_area",
            nSeries + " komponen sepanjang " + nX + " periode -> area bertumpuk"];
        }
        return [shares ? "stacked_bar_100" : "stacked_bar",
          nSeries + " komponen, " + nX + " periode -> batang bertumpuk"];
      }
      if (nSeries <= MAX_SERIES) {
        return ["line", nSeries + " seri sepanjang waktu -> garis ganda"];
      }
      if (nSeries <= SMALL_MULTIPLES_MAX) {
        return ["small_multiples",
          nSeries + " seri melebihi 8 slot warna -> panel kecil"];
      }
      return ["heatmap", nSeries + " seri x " + nX + " periode -> heatmap"];
    }
    if (nSeries <= 1) {
      if (crossesZero) {
        return ["diverging_bar",
          nX + " kategori dengan nilai +/- -> batang divergen dari nol"];
      }
      if (nX > 8) return ["hbar", nX + " kategori -> batang horizontal berperingkat"];
      return ["bar", nX + " kategori -> batang"];
    }
    if (partToWhole) {
      return [shares ? "stacked_bar_100" : "stacked_bar",
        nSeries + " komponen dari satu total -> batang bertumpuk"];
    }
    if (nSeries <= 4 && nX <= 8) {
      return ["grouped_bar", nSeries + " seri x " + nX + " kategori -> batang berkelompok"];
    }
    if (nSeries <= MAX_SERIES) {
      return ["hbar_grouped",
        nSeries + " seri x " + nX + " kategori -> batang horizontal berkelompok"];
    }
    return ["heatmap", nSeries + " seri x " + nX + " kategori -> heatmap"];
  }

  function alternativesFor(chart, xDim, nX, nSeries) {
    if (chart === "stat") return ["stat", "bar"];
    var alts = {};
    alts[chart] = 1;
    function add() {
      for (var i = 0; i < arguments.length; i++) alts[arguments[i]] = 1;
    }
    if (xDim === "time") {
      add("line", "bar");
      if (nSeries > 1) {
        add("small_multiples", "heatmap", "stacked_bar", "stacked_area",
          "stacked_area_100", "grouped_bar");
      }
    } else {
      add("bar", "hbar");
      if (nSeries > 1) add("grouped_bar", "stacked_bar", "stacked_bar_100", "heatmap");
      else {
        add("diverging_bar");
        if (nX >= 15) add("histogram");
        if (nX <= 6) add("donut");
      }
    }
    var order = ["line", "bar", "hbar", "diverging_bar", "grouped_bar",
      "hbar_grouped", "stacked_bar", "stacked_bar_100", "stacked_area",
      "stacked_area_100", "small_multiples", "heatmap", "histogram", "donut"];
    return order.filter(function (c) { return alts[c]; });
  }

  function histogram(values, bins) {
    if (!values.length) return [[], []];
    var lo = Math.min.apply(null, values), hi = Math.max.apply(null, values);
    var fmt = function (n) {
      return new Intl.NumberFormat("id-ID", { maximumSignificantDigits: 4 }).format(n);
    };
    if (lo === hi) {
      return [[{ id: "0", label: fmt(lo), full: fmt(lo) }],
      [{ id: "count", label: "Jumlah entitas", values: [values.length] }]];
    }
    var n = bins || Math.max(6, Math.min(20, Math.floor(Math.sqrt(values.length)) + 1));
    var width = (hi - lo) / n, counts = new Array(n).fill(0);
    values.forEach(function (v) {
      counts[Math.min(n - 1, Math.floor((v - lo) / width))]++;
    });
    var cats = [];
    for (var i = 0; i < n; i++) {
      cats.push({
        id: String(i), label: fmt(lo + i * width),
        full: fmt(lo + i * width) + " – " + fmt(lo + (i + 1) * width)
      });
    }
    return [cats, [{ id: "count", label: "Jumlah entitas", values: counts }]];
  }

  // ---------------------------------------------------------------- spec

  /* opts: {x, series ("none" to drop it), chart, pick:{dim:id|__sum__|__avg__},
            top, sort:"value"|"natural", includeTotals} */
  function buildSpec(cube, opts) {
    opts = opts || {};
    if (!cube || !cube.time || !cube.time.length || !cube.vervar.length) {
      return {
        chart: "empty", chart_label: "", title: (cube && cube.title) || "",
        reason: "Tidak ada data", structure: "", series: [], notes: ["Data kosong."],
        x: { categories: [], label: "", type: "category" }, unit: "",
        alternatives: [], dims: {}, roles: { x: "time", series: null, picks: {} }
      };
    }

    var dims = summarize(cube);
    var roles = assignRoles(dims, opts.x, opts.series);
    var xDim = roles.x, seriesDim = roles.series;

    var picks = {};
    roles.filters.forEach(function (dim) {
      if (!dims[dim].n) return;
      var want = (opts.pick || {})[dim];
      var valid = dims[dim].members.some(function (m) { return m.id === want; }) ||
        want === AGG_SUM || want === AGG_AVG;
      if (want === AGG_SUM && !dims.additive) valid = false;
      picks[dim] = valid ? want : defaultPick(dims, dim);
    });

    var grid = pivot(cube, dims, xDim, seriesDim, picks);

    var xMembers = dims[xDim].members.map(function (m) { return Object.assign({}, m); });
    var seriesMembers = seriesDim
      ? dims[seriesDim].members.map(function (m) { return Object.assign({}, m); })
      : [{ id: "__one__", label: dims.title, full: dims.title, isTotal: false, magnitude: 0 }];

    var presentX = {};
    Object.keys(grid).forEach(function (s) {
      Object.keys(grid[s]).forEach(function (x) { presentX[x] = 1; });
    });
    var keptX = xMembers.filter(function (m) { return presentX[m.id]; });
    if (keptX.length) xMembers = keptX;
    var keptS = seriesMembers.filter(function (m) { return grid[m.id]; });
    if (keptS.length) seriesMembers = keptS;

    // --- roll-up members
    var xIds = xMembers.map(function (m) { return m.id; });
    var sIds = seriesMembers.map(function (m) { return m.id; });
    var numS = seriesDim ? numericTotals(grid, sIds, xIds) : {};
    var numX = numericTotals(transpose(grid), xIds, sIds);
    seriesMembers.forEach(function (m) { m.isTotal = m.isTotal || !!numS[m.id]; });
    xMembers.forEach(function (m) { m.isTotal = m.isTotal || !!numX[m.id]; });

    var hadSeriesTotal = seriesMembers.length > 2 &&
      seriesMembers.some(function (m) { return m.isTotal; });

    var notes = [], dropped = [], droppedTime = [];
    var includeTotals = !!opts.includeTotals;
    // A period roll-up ("Tahunan", "Jan-Des", "Kumulatif") must never sit on the
    // same axis as the months/quarters it summarises — it is not a point in time
    // and its magnitude dwarfs them. For periods trust ONLY the label: a month
    // can legitimately equal the sum of the others, so the numeric heuristic
    // would drop real data.
    var isRollup = function (dim) {
      return dim === "time"
        ? function (m) { return !!m.labelTotal; }
        : function (m) { return !!m.isTotal; };
    };
    if (!includeTotals) {
      var sRollup = isRollup(seriesDim);
      var sParts = seriesMembers.filter(function (m) { return !sRollup(m); });
      if (sParts.length >= 2 && sParts.length < seriesMembers.length) {
        seriesMembers.filter(sRollup).forEach(function (m) {
          (seriesDim === "time" ? droppedTime : dropped).push(m.label);
        });
        seriesMembers = sParts;
      }
      var xRollup = isRollup(xDim);
      var xParts = xMembers.filter(function (m) { return !xRollup(m); });
      if (xParts.length >= 2 && xParts.length < xMembers.length) {
        xMembers.filter(xRollup).forEach(function (m) {
          (xDim === "time" ? droppedTime : dropped).push(m.label);
        });
        xMembers = xParts;
      }
    }
    if (dropped.length) {
      var uniq = dropped.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort();
      notes.push("Baris agregat (" + uniq.join(", ") + ") dikeluarkan agar tidak " +
        "dihitung dua kali — aktifkan \"sertakan total\" untuk menampilkannya.");
    }
    if (droppedTime.length) {
      var uniqT = droppedTime.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort();
      notes.push("Periode agregat (" + uniqT.join(", ") + ") dikeluarkan karena " +
        "merangkum periode lain di sumbu yang sama — aktifkan \"sertakan total\" " +
        "untuk menampilkannya.");
    }

    var keepS = {}; seriesMembers.forEach(function (m) { keepS[m.id] = 1; });
    var keepX = {}; xMembers.forEach(function (m) { keepX[m.id] = 1; });
    var g2 = {};
    Object.keys(grid).forEach(function (sid) {
      if (!keepS[sid]) return;
      g2[sid] = {};
      Object.keys(grid[sid]).forEach(function (xid) {
        if (keepX[xid]) g2[sid][xid] = grid[sid][xid];
      });
    });
    grid = g2;

    var all = [];
    Object.keys(grid).forEach(function (s) {
      Object.keys(grid[s]).forEach(function (x) { all.push(grid[s][x]); });
    });
    var nonneg = all.every(function (v) { return v >= 0; });
    var crossesZero = all.length &&
      Math.min.apply(null, all) < 0 && Math.max.apply(null, all) > 0;

    var shares = false;
    if (/(persen|%)/i.test(dims.unit || "") && seriesMembers.length > 1) {
      var sums = [];
      xMembers.forEach(function (m) {
        var s = 0;
        seriesMembers.forEach(function (sm) { s += (grid[sm.id] && grid[sm.id][m.id]) || 0; });
        if (s) sums.push(s);
      });
      shares = sums.length > 0 && sums.every(function (s) { return s >= 95 && s <= 105; });
    }
    var partToWhole = isPartToWhole(dims, seriesDim, seriesMembers, nonneg,
      hadSeriesTotal || shares);

    // Counts taken before truncation: the alternatives describe the variable,
    // not the current top-N view (a donut of 5 kept-out-of-38 is not a whole).
    var nXAll = xMembers.length, nSeriesAll = seriesMembers.length;
    var chosen = chooseChart(xDim, nXAll, nSeriesAll, partToWhole, crossesZero, shares);
    var chart = chosen[0], reason = chosen[1], autoChart = chart;
    if (opts.chart && opts.chart !== "auto") {
      chart = opts.chart;
      reason = "Dipilih manual: " + (CHART_LABELS[chart] || chart);
    }

    // --- ranking / truncation
    var top = parseInt(opts.top, 10) ||
      (chart === "heatmap" ? HEATMAP_MAX_COLS : DEFAULT_TOP);
    var ranked = { hbar: 1, bar: 1, diverging_bar: 1, hbar_grouped: 1, donut: 1 };
    var sortMode = opts.sort || (ranked[chart] ? "value" : "natural");
    var truncated = null;

    function xTotal(m) {
      var s = 0;
      seriesMembers.forEach(function (sm) {
        s += Math.abs((grid[sm.id] && grid[sm.id][m.id]) || 0);
      });
      return s;
    }
    if (xDim !== "time" && sortMode === "value") {
      xMembers.sort(function (a, b) { return xTotal(b) - xTotal(a); });
    }
    // The time axis is never truncated -- a chopped time series lies about the
    // trend; a category axis with hundreds of members is simply unreadable.
    if (xDim !== "time" && xMembers.length > top && chart !== "histogram") {
      truncated = { shown: top, total: xMembers.length };
      if (chart === "heatmap") {
        xMembers.sort(function (a, b) { return xTotal(b) - xTotal(a); });
        truncated.total = dims[xDim].members.length;
      }
      xMembers = xMembers.slice(0, top);
    }

    function magOf(m) {
      var s = 0;
      Object.keys(grid[m.id] || {}).forEach(function (k) { s += Math.abs(grid[m.id][k]); });
      return s;
    }
    if ((chart === "heatmap" || chart === "small_multiples")) {
      if (seriesMembers.length > HEATMAP_MAX_ROWS) {
        seriesMembers.sort(function (a, b) { return magOf(b) - magOf(a); });
        seriesMembers = seriesMembers.slice(0, HEATMAP_MAX_ROWS);
        notes.push("Menampilkan " + HEATMAP_MAX_ROWS + " seri terbesar.");
      }
    } else if (seriesMembers.length > MAX_SERIES) {
      seriesMembers.sort(function (a, b) { return magOf(b) - magOf(a); });
      seriesMembers = seriesMembers.slice(0, MAX_SERIES);
      notes.push("Hanya " + MAX_SERIES + " seri terbesar diberi warna; gunakan " +
        "heatmap atau panel kecil untuk semuanya.");
    }

    // --- assemble
    var xCats = xMembers.map(function (m) {
      return { id: m.id, label: m.label, full: m.full || m.label };
    });
    var series = seriesMembers.map(function (m) {
      var row = grid[m.id] || {};
      return {
        id: m.id, label: m.label || dims.title,
        values: xCats.map(function (c) {
          var v = row[c.id];
          return v === undefined ? null : v;
        })
      };
    });

    if (chart === "histogram") {
      var vals = [];
      series.forEach(function (s) {
        s.values.forEach(function (v) { if (v !== null) vals.push(v); });
      });
      var h = histogram(vals);
      xCats = h[0]; series = h[1];
    }

    var color = "single";
    if (chart === "heatmap") color = crossesZero ? "diverging" : "sequential";
    else if (chart === "diverging_bar") color = "diverging";
    else if (series.length > 1) color = "categorical";

    var filterText = [];
    Object.keys(picks).forEach(function (dim) {
      var p = picks[dim];
      if (p === AGG_SUM) filterText.push(DIM_LABELS[dim] + ": jumlah semua");
      else if (p === AGG_AVG) filterText.push(DIM_LABELS[dim] + ": rata-rata");
      else {
        var hit = dims[dim].members.filter(function (m) { return m.id === p; })[0];
        var lbl = hit ? (hit.full || hit.label) : p;
        if (lbl && !DEGENERATE_RE.test(String(lbl))) filterText.push(String(lbl));
      }
    });

    var specDims = {};
    DIMS.forEach(function (d) {
      specDims[d] = {
        key: d, label: DIM_LABELS[d], n: dims[d].n,
        degenerate: dims[d].degenerate, additive: dims.additive,
        members: dims[d].members.map(function (m) {
          return { id: m.id, label: m.full || m.label, is_total: m.isTotal };
        })
      };
    });

    return {
      chart: chart, auto_chart: autoChart,
      chart_label: CHART_LABELS[chart] || chart,
      title: dims.title, unit: dims.unit,
      subtitle: filterText.join(" · "),
      structure: describe(dims), reason: reason,
      x: {
        dim: xDim, label: DIM_LABELS[xDim],
        type: xDim === "time" ? "time" : "category", categories: xCats
      },
      y: { label: dims.unit || "Nilai" },
      series_dim: seriesDim, series_label: DIM_LABELS[seriesDim] || "",
      series: series, color: color,
      stacked: !!STACKED[chart], percent: /_100$/.test(chart),
      roles: { x: xDim, series: seriesDim, picks: picks },
      truncated: truncated,
      // period roll-ups count too: the note tells the reader to tick "sertakan
      // total", so the control has to be there when only a period was dropped
      totals_dropped: dropped.concat(droppedTime)
        .filter(function (v, i, a) { return a.indexOf(v) === i; }),
      include_totals: includeTotals,
      notes: notes,
      alternatives: alternativesFor(autoChart, xDim, nXAll, nSeriesAll)
        .map(function (c) { return { id: c, label: CHART_LABELS[c] }; }),
      dims: specDims
    };
  }

  /* Tidy CSV straight from the cube -- the same columns bps_data.py writes, so
     the online build can export without a server. */
  function toCSV(cube) {
    var cols = ["var_id", "variable", "unit", "vervar_id", "vervar", "turvar_id",
      "turvar", "year_id", "year", "period_id", "period", "value"];
    var esc = function (s) {
      s = s === null || s === undefined ? "" : String(s);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var lines = [cols.join(",")];
    cube.vervar.forEach(function (vv, a) {
      cube.turvar.forEach(function (tv, b) {
        cube.time.forEach(function (tt, c) {
          var v = cube.values[a][b][c];
          if (v === null || v === undefined) return;
          var parts = tt[0].split("|");
          var full = tt[2] || tt[1];
          var year = full.split(" ")[0];
          lines.push([cube.var_id, cube.title, cube.unit, vv[0], vv[1], tv[0], tv[1],
            parts[0], year, parts[1], full.slice(year.length).trim() || "Tahun", v]
            .map(esc).join(","));
        });
      });
    });
    return "﻿" + lines.join("\r\n") + "\r\n";
  }

  global.BPSInfer = {
    buildSpec: buildSpec, summarize: summarize, describe: describe,
    toCSV: toCSV, CHART_LABELS: CHART_LABELS, DIM_LABELS: DIM_LABELS
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).BPSInfer;
}

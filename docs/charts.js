/* BPS Dashboard - SVG chart renderer.
 *
 * Draws the chart specs produced by bps_viz.py. No dependencies, no CDN.
 *
 * Marks follow one fixed set of specs: bars <=24px thick with a 4px rounded
 * data-end and a 2px surface gap, 2px lines, >=8px markers ringed in the
 * surface colour, hairline solid gridlines, and text in ink tokens (never in a
 * series colour). Colours come from CSS custom properties so light/dark swap in
 * one place; the categorical order is fixed and never cycled past 8 slots.
 *
 * API:  BPSChart.render(container, spec, {hidden, height, onToggle})
 *       BPSChart.svgString(container) -> standalone SVG text
 */
(function (global) {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";
  var FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  var MAX_BAR = 24, GAP = 2, LINE_W = 2, DOT_R = 4.5;

  // ---------------------------------------------------------------- utils

  function el(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) {
      n.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(n);
    return n;
  }

  function htm(tag, cls, parent, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;   // labels are untrusted data
    if (parent) parent.appendChild(n);
    return n;
  }

  function tokens(root) {
    var cs = getComputedStyle(root);
    function v(name, fb) { return (cs.getPropertyValue(name) || "").trim() || fb; }
    var series = [];
    for (var i = 1; i <= 8; i++) series.push(v("--series-" + i, "#2a78d6"));
    var seq = [];
    for (var j = 1; j <= 7; j++) seq.push(v("--seq-" + j, "#2a78d6"));
    return {
      series: series, seq: seq,
      surface: v("--surface-1", "#fcfcfb"),
      ink: v("--text-primary", "#0b0b0b"),
      ink2: v("--text-secondary", "#52514e"),
      muted: v("--text-muted", "#898781"),
      grid: v("--gridline", "#e1e0d9"),
      axis: v("--baseline", "#c3c2b7"),
      pos: v("--diverge-pos", "#2a78d6"),
      neg: v("--diverge-neg", "#d03b3b"),
      dim: v("--de-emphasis", "#c3c2b7")
    };
  }

  var NF = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
  var NF4 = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 4 });

  function fmt(n) {
    if (n === null || n === undefined || isNaN(n)) return "–";
    return (Math.abs(n) < 1 && n !== 0 ? NF4 : NF).format(n);
  }

  function fmtShort(n) {
    if (n === null || n === undefined || isNaN(n)) return "–";
    var a = Math.abs(n);
    if (a >= 1e12) return NF.format(n / 1e12) + " T";
    if (a >= 1e9) return NF.format(n / 1e9) + " M";
    if (a >= 1e6) return NF.format(n / 1e6) + " jt";
    if (a >= 1e4) return NF.format(n / 1e3) + " rb";
    return fmt(n);
  }

  /* Measured, not estimated: a character-count estimate under-reads uppercase
     region names ("NUSA TENGGARA BARAT") and the label then overruns its
     gutter. Layout decisions all run through this. */
  var _mctx = null, _mcache = Object.create(null);

  function textWidth(s, size) {
    var key = size + "|" + s;
    var hit = _mcache[key];
    if (hit !== undefined) return hit;
    if (!_mctx) _mctx = document.createElement("canvas").getContext("2d");
    _mctx.font = size + "px " + FONT;
    return (_mcache[key] = _mctx.measureText(String(s)).width);
  }

  /* Width to reserve for a column of axis labels, and the budget the text is
     then trimmed to. The two must be derived from the same numbers: reserving
     the widest label but trimming to something narrower silently ellipsizes
     labels that would have fitted. `gap` is the space between the label and
     the plot, `inset` keeps the text off the frame edge. */
  function labelGutter(labels, size, gap, inset, cap) {
    var max = 0;
    labels.forEach(function (s) { max = Math.max(max, textWidth(s, size)); });
    return { width: Math.min(max + gap + inset, cap), gap: gap, inset: inset };
  }

  function gutterBudget(g) { return g.width - g.gap - g.inset; }

  /* Trim to fit, with an ellipsis -- never clip, never overflow. */
  function ellipsize(s, size, maxW) {
    s = String(s);
    if (textWidth(s, size) <= maxW) return s;
    var lo = 0, hi = s.length;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (textWidth(s.slice(0, mid) + "…", size) <= maxW) lo = mid; else hi = mid - 1;
    }
    return lo > 0 ? s.slice(0, lo) + "…" : "";
  }

  function niceTicks(min, max, count) {
    if (min === max) { min = min - 1; max = max + 1; }
    var span = max - min;
    var step = Math.pow(10, Math.floor(Math.log10(span / (count || 5))));
    var err = (span / (count || 5)) / step;
    if (err >= 7.5) step *= 10; else if (err >= 3.5) step *= 5;
    else if (err >= 1.5) step *= 2;
    var lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    var out = [];
    for (var v = lo; v <= hi + step / 2; v += step) out.push(Math.abs(v) < step / 1e6 ? 0 : v);
    return { ticks: out, min: lo, max: hi };
  }

  /* Bar with a 4px rounded data-end and a square baseline end. */
  function barPath(x, y, w, h, r, dir) {
    r = Math.min(r, w / 2, Math.abs(h));
    if (h <= 0.4) return "M" + x + "," + y + "h" + w;
    if (dir === "up")
      return "M" + x + "," + (y + h) + "v" + (-(h - r)) + "a" + r + "," + r + " 0 0 1 " + r + ",-" + r +
        "h" + (w - 2 * r) + "a" + r + "," + r + " 0 0 1 " + r + "," + r + "v" + (h - r) + "z";
    if (dir === "down")
      return "M" + x + "," + y + "v" + (h - r) + "a" + r + "," + r + " 0 0 0 " + r + "," + r +
        "h" + (w - 2 * r) + "a" + r + "," + r + " 0 0 0 " + r + ",-" + r + "v" + (-(h - r)) + "z";
    if (dir === "right")   // x,y = left edge; h = length, w = thickness
      return "M" + x + "," + y + "h" + (h - r) + "a" + r + "," + r + " 0 0 1 " + r + "," + r +
        "v" + (w - 2 * r) + "a" + r + "," + r + " 0 0 1 -" + r + "," + r + "h" + (-(h - r)) + "z";
    return "M" + x + "," + y + "h" + (-(h - r)) + "a" + r + "," + r + " 0 0 0 -" + r + "," + r +
      "v" + (w - 2 * r) + "a" + r + "," + r + " 0 0 0 " + r + "," + r + "h" + (h - r) + "z";
  }

  function lerpColor(a, b, t) {
    function hex(c) {
      c = c.replace("#", "");
      if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
      return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
    }
    var A = hex(a), B = hex(b), o = "#";
    for (var i = 0; i < 3; i++) {
      var v = Math.round(A[i] + (B[i] - A[i]) * t).toString(16);
      o += v.length < 2 ? "0" + v : v;
    }
    return o;
  }

  function rampColor(ramp, t) {
    t = Math.max(0, Math.min(1, t));
    var pos = t * (ramp.length - 1), i = Math.floor(pos);
    if (i >= ramp.length - 1) return ramp[ramp.length - 1];
    return lerpColor(ramp[i], ramp[i + 1], pos - i);
  }

  function luminance(c) {
    c = c.replace("#", "");
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    var r = parseInt(c.slice(0, 2), 16) / 255, g = parseInt(c.slice(2, 4), 16) / 255,
      b = parseInt(c.slice(4, 6), 16) / 255;
    function f(x) { return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  // ---------------------------------------------------------------- tooltip

  function Tip(container) {
    var box = htm("div", "viz-tip", container);
    box.setAttribute("role", "status");
    box.style.display = "none";
    return {
      hide: function () { box.style.display = "none"; },
      show: function (x, y, title, rows) {
        box.textContent = "";
        htm("div", "viz-tip-title", box, title);
        rows.forEach(function (r) {
          var line = htm("div", "viz-tip-row", box);
          var key = htm("span", "viz-tip-key", line);
          key.style.background = r.color || "transparent";
          if (!r.color) key.style.visibility = "hidden";
          htm("span", "viz-tip-val", line, r.value);
          htm("span", "viz-tip-name", line, r.name);
        });
        box.style.display = "block";
        var w = box.offsetWidth, h = box.offsetHeight, cw = container.clientWidth;
        box.style.left = Math.max(4, Math.min(cw - w - 4, x - w / 2)) + "px";
        box.style.top = Math.max(4, y - h - 14) + "px";
      }
    };
  }

  // ---------------------------------------------------------------- legend

  /* A legend is always present for two or more colour classes -- identity is
     never carried by colour alone. Toggling is offered only where hiding a
     class still leaves a readable chart (not on a donut's own slices). */
  function legend(container, items, colors, kind, hidden, onToggle) {
    if (items.length < 2) return;
    var wrap = htm("div", "viz-legend", container);
    wrap.setAttribute("role", "list");
    items.forEach(function (s, i) {
      var off = hidden.has(s.id);
      var b = htm("button", "viz-leg" + (off ? " off" : ""), wrap);
      b.type = "button";
      b.setAttribute("role", "listitem");
      var key = htm("span", kind === "line" ? "viz-key-line" : "viz-key-rect", b);
      key.style.background = colors[i];
      htm("span", null, b, s.label);
      if (onToggle) {
        b.setAttribute("aria-pressed", off ? "false" : "true");
        b.addEventListener("click", function () { onToggle(s.id); });
      } else {
        b.style.cursor = "default";
      }
    });
  }

  // ---------------------------------------------------------------- axes

  function drawGrid(g, t, plot, ticks, scaleY, horizontal) {
    var lastRight = -1e9;
    ticks.forEach(function (v) {
      var p = scaleY(v);
      if (horizontal) {
        el("line", {
          x1: p, x2: p, y1: plot.top, y2: plot.top + plot.h,
          stroke: v === 0 ? t.axis : t.grid, "stroke-width": 1
        }, g);
        // the gridline always draws; its label only when it clears the last one
        var lab = fmtShort(v), half = textWidth(lab, 11) / 2;
        if (p - half < lastRight + 8) return;
        lastRight = p + half;
        el("text", {
          x: p, y: plot.top + plot.h + 16, "text-anchor": "middle",
          fill: t.muted, "font-size": 11, "font-family": FONT
        }, g).textContent = lab;
      } else {
        el("line", {
          x1: plot.left, x2: plot.left + plot.w, y1: p, y2: p,
          stroke: v === 0 ? t.axis : t.grid, "stroke-width": 1
        }, g);
        el("text", {
          x: plot.left - 8, y: p + 4, "text-anchor": "end",
          fill: t.muted, "font-size": 11, "font-family": FONT,
          "font-variant-numeric": "tabular-nums"
        }, g).textContent = fmtShort(v);
      }
    });
  }

  /* Thin the tick labels to what actually fits -- rotated labels still need
     room for their own height, so they thin too (just less aggressively). */
  function labelStep(count, room, per) {
    return Math.max(1, Math.ceil(count / Math.max(1, Math.floor(room / per))));
  }

  function xLabels(g, t, plot, cats, bandW, rotate) {
    var step = labelStep(cats.length, plot.w, rotate ? 15 : 46);
    cats.forEach(function (c, i) {
      if (i % step !== 0 && i !== cats.length - 1) return;
      var x = plot.left + bandW * (i + 0.5);
      if (rotate && x - textWidth(c.label, 11) * 0.77 < 0) return;   // would clip
      var n = el("text", {
        x: x, y: plot.top + plot.h + 18, fill: t.muted,
        "font-size": 11, "font-family": FONT,
        "text-anchor": rotate ? "end" : "middle"
      }, g);
      if (rotate) n.setAttribute("transform", "rotate(-40," + x + "," + (plot.top + plot.h + 18) + ")");
      n.textContent = c.label;
    });
  }

  // ---------------------------------------------------------------- cartesian

  function cartesian(ctx) {
    var spec = ctx.spec, t = ctx.t, svg = ctx.svg, colors = ctx.colors;
    var cats = spec.x.categories, series = ctx.visible;
    var chart = spec.chart;
    var stacked = chart.indexOf("stacked") === 0;
    var pct = /_100$/.test(chart);
    var isArea = chart.indexOf("area") >= 0;
    var isLine = chart === "line";
    var isDiv = chart === "diverging_bar";

    // --- scale
    var vals = [], i, j;
    if (stacked) {
      for (i = 0; i < cats.length; i++) {
        var pos = 0, neg = 0;
        for (j = 0; j < series.length; j++) {
          var v = series[j].values[i] || 0;
          if (v >= 0) pos += v; else neg += v;
        }
        vals.push(pct ? 100 : pos, pct ? 0 : neg);
      }
    } else {
      series.forEach(function (s) {
        s.values.forEach(function (v) { if (v !== null && v !== undefined) vals.push(v); });
      });
    }
    if (!vals.length) vals = [0, 1];
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (lo > 0 && !isLine) lo = 0;                 // bars must start at zero
    if (hi < 0 && !isLine) hi = 0;
    if (isLine && lo === hi) { lo -= 1; hi += 1; }
    var nt = niceTicks(lo, hi, 5);

    // --- layout
    var maxLabel = 0;
    cats.forEach(function (c) { maxLabel = Math.max(maxLabel, textWidth(c.label, 11)); });
    var tickW = 0;
    nt.ticks.forEach(function (v) { tickW = Math.max(tickW, textWidth(fmtShort(v), 11)); });
    var rotate = cats.length * (maxLabel + 10) > ctx.width - tickW - 40;

    /* Direct end-labels need their own gutter, or they run off the frame.
       Reserve only what the widest one needs, capped so the plot keeps most
       of the width; anything that still does not fit is dropped to the legend
       and tooltip rather than clipped. */
    var endLabels = null, gutter = 16;
    if ((isLine || isArea) && !stacked && series.length <= 4) {
      endLabels = series.map(function (s) {
        if (series.length > 1) return s.label;
        for (var k = s.values.length - 1; k >= 0; k--) {
          if (s.values[k] !== null && s.values[k] !== undefined) return fmt(s.values[k]);
        }
        return "";
      });
      var need = 0;
      endLabels.forEach(function (l) { need = Math.max(need, textWidth(l, 11)); });
      gutter = Math.min(need + 14, Math.max(16, ctx.width * 0.24));
    }

    /* A -40 degree label reaches left of its tick by cos(40) * its width, so
       the first one needs that much margin or it is cut off by the frame. */
    var left = tickW + 18;
    if (rotate) left = Math.max(left, Math.min(maxLabel * 0.77 + 4, ctx.width * 0.28));
    var plot = {
      left: left, top: 10,
      w: ctx.width - left - gutter,
      h: ctx.height - 10 - (rotate ? Math.min(90, maxLabel * 0.78 + 24) : 34)
    };
    var scaleY = function (v) {
      return plot.top + plot.h - (v - nt.min) / (nt.max - nt.min) * plot.h;
    };
    var bandW = plot.w / cats.length;

    var g = el("g", {}, svg);
    drawGrid(g, t, plot, nt.ticks, scaleY, false);
    xLabels(g, t, plot, cats, bandW, rotate);
    el("line", {
      x1: plot.left, x2: plot.left + plot.w, y1: scaleY(0), y2: scaleY(0),
      stroke: t.axis, "stroke-width": 1
    }, g);

    // --- marks
    var marks = el("g", {}, svg);
    if (isLine || isArea) {
      var stackTop = cats.map(function () { return 0; });
      var prevTop = cats.map(function () { return scaleY(0); });
      series.forEach(function (s, si) {
        var pts = [], col = colors[ctx.index(s)];
        for (i = 0; i < cats.length; i++) {
          var v = s.values[i];
          if (stacked) {
            var raw = v || 0;
            if (pct) {
              var tot = 0;
              for (j = 0; j < series.length; j++) tot += Math.abs(series[j].values[i] || 0);
              raw = tot ? raw / tot * 100 : 0;
            }
            stackTop[i] += raw;
            pts.push({ x: plot.left + bandW * (i + 0.5), y: scaleY(stackTop[i]), v: raw, ok: true });
          } else {
            pts.push({
              x: plot.left + bandW * (i + 0.5),
              y: v === null || v === undefined ? null : scaleY(v),
              v: v, ok: v !== null && v !== undefined
            });
          }
        }
        if (stacked) {
          var d = "M" + pts[0].x + "," + pts[0].y;
          for (i = 1; i < pts.length; i++) d += "L" + pts[i].x + "," + pts[i].y;
          for (i = pts.length - 1; i >= 0; i--) d += "L" + pts[i].x + "," + prevTop[i];
          el("path", { d: d + "z", fill: col, "fill-opacity": 0.85, stroke: t.surface, "stroke-width": GAP }, marks);
          prevTop = pts.map(function (p) { return p.y; });
        } else {
          if (isArea) {
            var da = "";
            pts.forEach(function (p, k) { if (p.ok) da += (da ? "L" : "M") + p.x + "," + p.y; });
            if (da) {
              da += "L" + pts[pts.length - 1].x + "," + scaleY(Math.max(nt.min, 0)) +
                "L" + pts[0].x + "," + scaleY(Math.max(nt.min, 0)) + "z";
              el("path", { d: da, fill: col, "fill-opacity": 0.1 }, marks);
            }
          }
          var d2 = "", pen = false;
          pts.forEach(function (p) {
            if (!p.ok) { pen = false; return; }
            d2 += (pen ? "L" : "M") + p.x + "," + p.y; pen = true;
          });
          el("path", {
            d: d2, fill: "none", stroke: col, "stroke-width": LINE_W,
            "stroke-linejoin": "round", "stroke-linecap": "round"
          }, marks);
          var last = null;
          pts.forEach(function (p) { if (p.ok) last = p; });
          if (last) {
            el("circle", {
              cx: last.x, cy: last.y, r: DOT_R, fill: col,
              stroke: t.surface, "stroke-width": GAP
            }, marks);
            // Direct end-label, but only where it fits and does not collide:
            // converging lines get the legend + tooltip instead of stacked
            // labels detached from their line.
            if (endLabels) {
              var lbl = endLabels[si];
              var room = ctx.width - (last.x + 8) - 2;
              if (lbl && textWidth(lbl, 11) <= room &&
                  !ctx.placed.some(function (y) { return Math.abs(y - last.y) < 13; })) {
                ctx.placed.push(last.y);
                el("text", {
                  x: last.x + 8, y: last.y + 4, fill: t.ink2,
                  "font-size": 11, "font-family": FONT
                }, marks).textContent = lbl;
              }
            }
          }
        }
      });
    } else {
      // bar family
      var groups = stacked || series.length === 1 ? 1 : series.length;
      var slot = Math.min(MAX_BAR, (bandW - 10) / groups);
      var groupW = slot * groups + GAP * (groups - 1);
      series.forEach(function (s, si) {
        var col = isDiv ? null : colors[ctx.index(s)];
        var acc = cats.map(function () { return 0; });
        for (i = 0; i < cats.length; i++) {
          var v = s.values[i];
          if (v === null || v === undefined) continue;
          var shown = v;
          if (pct) {
            var tot2 = 0;
            for (j = 0; j < series.length; j++) tot2 += Math.abs(series[j].values[i] || 0);
            shown = tot2 ? v / tot2 * 100 : 0;
          }
          var cx = plot.left + bandW * (i + 0.5);
          var x0 = stacked || series.length === 1 ? cx - slot / 2
            : cx - groupW / 2 + si * (slot + GAP);
          var y0, h, dir;
          if (stacked) {
            var base = acc[i];
            acc[i] += shown;
            y0 = scaleY(Math.max(base, acc[i]));
            h = Math.abs(scaleY(acc[i]) - scaleY(base)) - GAP;
            dir = "up";
            if (h < 0.5) continue;
          } else {
            dir = shown >= 0 ? "up" : "down";
            y0 = shown >= 0 ? scaleY(shown) : scaleY(0);
            h = Math.abs(scaleY(shown) - scaleY(0));
          }
          el("path", {
            d: barPath(x0, y0, slot, h, 4, dir),
            fill: isDiv ? (v >= 0 ? t.pos : t.neg) : col
          }, marks);
          // value on the cap when there is room and few enough bars
          if (!stacked && ctx.showValues && series.length === 1 &&
              cats.length <= 14 && slot >= 18) {
            var label = fmtShort(v);
            if (textWidth(label, 10) <= slot + bandW * 0.4) {
              el("text", {
                x: x0 + slot / 2, y: shown >= 0 ? y0 - 6 : y0 + h + 13,
                "text-anchor": "middle", fill: t.ink2, "font-size": 10,
                "font-family": FONT, "font-variant-numeric": "tabular-nums"
              }, marks).textContent = label;
            }
          }
        }
      });
    }

    // --- hover: nearest band, one tooltip listing every series
    hover(ctx, plot, function (mx) {
      var i = Math.max(0, Math.min(cats.length - 1, Math.floor((mx - plot.left) / bandW)));
      return { index: i, x: plot.left + bandW * (i + 0.5) };
    }, cats, series, colors, isLine || isArea, plot);

    ctx.plotHeight = plot.top + plot.h;
  }

  function hover(ctx, plot, locate, cats, series, colors, crosshair) {
    var svg = ctx.svg, t = ctx.t;
    var line = crosshair ? el("line", {
      y1: plot.top, y2: plot.top + plot.h, stroke: t.axis,
      "stroke-width": 1, opacity: 0
    }, svg) : null;
    var band = el("rect", {
      x: plot.left, y: plot.top, width: plot.w, height: plot.h,
      fill: "transparent", "pointer-events": "all"
    }, svg);
    function at(mx, my) {
      var hit = locate(mx, my);
      if (line) { line.setAttribute("x1", hit.x); line.setAttribute("x2", hit.x); line.setAttribute("opacity", 1); }
      var rows = series.map(function (s) {
        return {
          color: colors[ctx.index(s)], name: s.label,
          value: fmt(s.values[hit.index]) + (ctx.spec.unit ? " " + ctx.spec.unit : "")
        };
      });
      ctx.tip.show(hit.x, my, cats[hit.index].full || cats[hit.index].label, rows);
    }
    band.addEventListener("pointermove", function (e) {
      var r = svg.getBoundingClientRect();
      at((e.clientX - r.left) * ctx.width / r.width, (e.clientY - r.top) * ctx.height / r.height);
    });
    band.addEventListener("pointerleave", function () {
      ctx.tip.hide(); if (line) line.setAttribute("opacity", 0);
    });
  }

  // ---------------------------------------------------------------- horizontal

  function horizontal(ctx) {
    var spec = ctx.spec, t = ctx.t, svg = ctx.svg, colors = ctx.colors;
    var cats = spec.x.categories, series = ctx.visible;
    // More than one series always splits the band. Drawing them at the same y
    // would pile the bars (and their value labels) on top of each other and
    // show only the last one -- which is what a manually forced "hbar" on a
    // multi-series variable used to do.
    var grouped = spec.chart === "hbar_grouped" || series.length > 1;
    var isDiv = spec.chart === "diverging_bar";

    var vals = [];
    series.forEach(function (s) {
      s.values.forEach(function (v) { if (v !== null && v !== undefined) vals.push(v); });
    });
    if (!vals.length) vals = [0, 1];
    var lo = Math.min(0, Math.min.apply(null, vals));
    var hi = Math.max(0, Math.max.apply(null, vals));

    var gut = labelGutter(cats.map(function (c) { return c.label; }), 11, 10, 2,
      Math.max(90, ctx.width * 0.34));
    var labelW = gut.width;
    var plot = { left: labelW, top: 6, w: ctx.width - labelW - 46, h: ctx.height - 34 };
    // tick count follows the room available, not a fixed number
    var nt = niceTicks(lo, hi, Math.max(2, Math.min(5, Math.floor(plot.w / 80))));
    var bandH = plot.h / cats.length;
    var scaleX = function (v) {
      return plot.left + (v - nt.min) / (nt.max - nt.min) * plot.w;
    };

    var g = el("g", {}, svg);
    drawGrid(g, t, plot, nt.ticks, scaleX, true);

    var marks = el("g", {}, svg);
    var groups = grouped ? series.length : 1;
    var slot = Math.min(MAX_BAR, (bandH - 8) / groups);
    var groupH = slot * groups + GAP * (groups - 1);
    var zero = scaleX(0);

    cats.forEach(function (c, i) {
      var cy = plot.top + bandH * (i + 0.5);
      var n = el("text", {
        x: plot.left - gut.gap, y: cy + 4, "text-anchor": "end", fill: t.ink2,
        "font-size": 11, "font-family": FONT
      }, g);
      n.textContent = ellipsize(c.label, 11, gutterBudget(gut));
      if (n.textContent !== c.label) el("title", {}, n).textContent = c.full || c.label;

      series.forEach(function (s, si) {
        var v = s.values[i];
        if (v === null || v === undefined) return;
        var y0 = grouped ? cy - groupH / 2 + si * (slot + GAP) : cy - slot / 2;
        var len = Math.abs(scaleX(v) - zero);
        var dir = v >= 0 ? "right" : "left";
        el("path", {
          d: barPath(v >= 0 ? zero : zero, y0, slot, len, 4, dir),
          fill: isDiv ? (v >= 0 ? t.pos : t.neg) : colors[ctx.index(s)]
        }, marks);
        // Tip values only on a single series, only when the rows are tall
        // enough for the text, and only where they fit between the bar end and
        // the frame -- never back over the category gutter.
        if (!grouped && ctx.showValues && bandH >= 16) {
          var label = fmtShort(v);
          var lx = v >= 0 ? zero + len + 6 : zero - len - 6;
          var lw = textWidth(label, 10);
          if ((v >= 0 ? lx + lw : lx) < ctx.width - 2 &&
              (v >= 0 ? lx : lx - lw) > plot.left + 4) {
            el("text", {
              x: lx, y: cy + 4, "text-anchor": v >= 0 ? "start" : "end",
              fill: t.ink2, "font-size": 10, "font-family": FONT,
              "font-variant-numeric": "tabular-nums"
            }, marks).textContent = label;
          }
        }
      });
    });

    hover(ctx, plot, function (mx, my) {
      var i = Math.max(0, Math.min(cats.length - 1, Math.floor((my - plot.top) / bandH)));
      return { index: i, x: mx };
    }, cats, series, colors, false, plot);

    ctx.plotHeight = plot.top + plot.h;
  }

  // ---------------------------------------------------------------- heatmap

  function heatmap(ctx) {
    var spec = ctx.spec, t = ctx.t, svg = ctx.svg;
    var cats = spec.x.categories, series = ctx.visible;
    var vals = [];
    series.forEach(function (s) {
      s.values.forEach(function (v) { if (v !== null && v !== undefined) vals.push(v); });
    });
    if (!vals.length) vals = [0, 1];
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var diverging = lo < 0 && hi > 0;
    var mag = Math.max(Math.abs(lo), Math.abs(hi)) || 1;

    var gut = labelGutter(series.map(function (s) { return s.label; }), 11, 8, 2,
      Math.max(90, ctx.width * 0.3));
    var labelW = gut.width;
    var botLabel = 0;
    cats.forEach(function (c) { botLabel = Math.max(botLabel, textWidth(c.label, 10)); });
    var rotate = cats.length * (botLabel + 8) > ctx.width - labelW;
    var plot = {
      left: labelW, top: 6, w: ctx.width - labelW - 12,
      h: ctx.height - (rotate ? Math.min(80, botLabel * 0.75 + 18) : 26)
    };
    var cw = plot.w / cats.length, ch = plot.h / series.length;

    function color(v) {
      if (v === null || v === undefined) return "transparent";
      if (diverging) {
        return v >= 0 ? lerpColor(t.surface, t.pos, Math.abs(v) / mag)
          : lerpColor(t.surface, t.neg, Math.abs(v) / mag);
      }
      return rampColor(t.seq, (v - lo) / (hi - lo || 1));
    }

    var g = el("g", {}, svg);
    var rowStep = labelStep(series.length, plot.h, 13);
    series.forEach(function (s, r) {
      var y = plot.top + ch * r;
      if (r % rowStep === 0) {
        var n = el("text", {
          x: plot.left - gut.gap, y: y + ch / 2 + 4, "text-anchor": "end", fill: t.ink2,
          "font-size": 11, "font-family": FONT
        }, g);
        n.textContent = ellipsize(s.label, 11, gutterBudget(gut));
        if (n.textContent !== s.label) el("title", {}, n).textContent = s.label;
      }
      cats.forEach(function (c, i) {
        var v = s.values[i];
        el("rect", {
          x: plot.left + cw * i + 1, y: y + 1,
          width: Math.max(1, cw - GAP), height: Math.max(1, ch - GAP),
          rx: 2, fill: color(v)
        }, g);
      });
    });
    var step = labelStep(cats.length, plot.w, rotate ? 15 : 46);
    cats.forEach(function (c, i) {
      if (i % step !== 0 && i !== cats.length - 1) return;
      var x = plot.left + cw * (i + 0.5);
      if (rotate && x - textWidth(c.label, 10) * 0.77 < 0) return;
      var n = el("text", {
        x: x, y: plot.top + plot.h + 14, fill: t.muted, "font-size": 10,
        "font-family": FONT, "text-anchor": rotate ? "end" : "middle"
      }, g);
      if (rotate) n.setAttribute("transform", "rotate(-40," + x + "," + (plot.top + plot.h + 14) + ")");
      n.textContent = c.label;
    });

    var band = el("rect", {
      x: plot.left, y: plot.top, width: plot.w, height: plot.h,
      fill: "transparent", "pointer-events": "all"
    }, svg);
    band.addEventListener("pointermove", function (e) {
      var r = svg.getBoundingClientRect();
      var mx = (e.clientX - r.left) * ctx.width / r.width;
      var my = (e.clientY - r.top) * ctx.height / r.height;
      var ci = Math.max(0, Math.min(cats.length - 1, Math.floor((mx - plot.left) / cw)));
      var ri = Math.max(0, Math.min(series.length - 1, Math.floor((my - plot.top) / ch)));
      ctx.tip.show(plot.left + cw * (ci + 0.5), my,
        series[ri].label + " · " + (cats[ci].full || cats[ci].label),
        [{ color: color(series[ri].values[ci]), name: spec.unit || "",
           value: fmt(series[ri].values[ci]) }]);
    });
    band.addEventListener("pointerleave", function () { ctx.tip.hide(); });

    // scale legend (a heatmap is colour-only, so it always ships one)
    var sc = htm("div", "viz-scale", ctx.container);
    htm("span", null, sc, fmtShort(diverging ? -mag : lo));
    var bar = htm("span", "viz-scale-bar", sc);
    var stops = [];
    for (var k = 0; k <= 10; k++) {
      stops.push(color(diverging ? -mag + (2 * mag) * k / 10 : lo + (hi - lo) * k / 10));
    }
    bar.style.background = "linear-gradient(90deg," + stops.join(",") + ")";
    htm("span", null, sc, fmtShort(diverging ? mag : hi));
    ctx.plotHeight = plot.top + plot.h;
  }

  // ---------------------------------------------------------------- donut

  function donut(ctx) {
    var spec = ctx.spec, t = ctx.t, svg = ctx.svg, colors = ctx.colors;
    var cats = spec.x.categories;
    var s = ctx.visible[0];
    if (!s) return;
    var total = 0;
    s.values.forEach(function (v) { if (v > 0) total += v; });
    var cx = ctx.width / 2, cy = ctx.height / 2, R = Math.min(cx, cy) - 30, r0 = R * 0.58;
    var a = -Math.PI / 2;
    var g = el("g", {}, svg);
    cats.forEach(function (c, i) {
      var v = s.values[i];
      if (!v || v <= 0) return;
      var sweep = v / total * Math.PI * 2, a2 = a + sweep;
      var big = sweep > Math.PI ? 1 : 0;
      var d = "M" + (cx + R * Math.cos(a)) + "," + (cy + R * Math.sin(a)) +
        "A" + R + "," + R + " 0 " + big + " 1 " + (cx + R * Math.cos(a2)) + "," + (cy + R * Math.sin(a2)) +
        "L" + (cx + r0 * Math.cos(a2)) + "," + (cy + r0 * Math.sin(a2)) +
        "A" + r0 + "," + r0 + " 0 " + big + " 0 " + (cx + r0 * Math.cos(a)) + "," + (cy + r0 * Math.sin(a)) + "z";
      var col = colors[i % colors.length];
      var p = el("path", { d: d, fill: col, stroke: t.surface, "stroke-width": GAP }, g);
      var mid = (a + a2) / 2, pctv = v / total * 100;
      if (pctv >= 6) {
        var lr = (R + r0) / 2;
        el("text", {
          x: cx + lr * Math.cos(mid), y: cy + lr * Math.sin(mid) + 4,
          "text-anchor": "middle", "font-size": 11, "font-family": FONT,
          fill: luminance(col) > 0.45 ? "#0b0b0b" : "#ffffff"
        }, g).textContent = NF.format(pctv) + "%";
      }
      p.addEventListener("pointermove", function (e) {
        var rc = svg.getBoundingClientRect();
        ctx.tip.show((e.clientX - rc.left) * ctx.width / rc.width,
          (e.clientY - rc.top) * ctx.height / rc.height,
          c.full || c.label,
          [{ color: col, name: spec.unit || "", value: fmt(v) },
           { color: null, name: "dari total", value: NF.format(pctv) + "%" }]);
      });
      p.addEventListener("pointerleave", function () { ctx.tip.hide(); });
      a = a2;
    });
    el("text", {
      x: cx, y: cy - 4, "text-anchor": "middle", fill: t.ink,
      "font-size": 18, "font-family": FONT, "font-weight": 600
    }, g).textContent = fmtShort(total);
    el("text", {
      x: cx, y: cy + 14, "text-anchor": "middle", fill: t.muted,
      "font-size": 11, "font-family": FONT
    }, g).textContent = "total";
    ctx.plotHeight = ctx.height;
  }

  // ---------------------------------------------------------------- stat

  /* One number is the chart. Proportional figures (never tabular-nums) at
     display size, in the same sans as everything else. */
  function stat(ctx) {
    var spec = ctx.spec, t = ctx.t, svg = ctx.svg;
    var v = ctx.visible[0].values[0];
    var cx = ctx.width / 2;
    // Laid out from the top with explicit gaps: a 48px figure's em box is much
    // taller than its digits, so centring the three lines lets the boxes touch.
    var cap = spec.x.categories[0];
    el("text", {
      x: cx, y: 34, "text-anchor": "middle", fill: t.muted,
      "font-size": 12, "font-family": FONT
    }, svg).textContent = (cap.full || cap.label || "");
    el("text", {
      x: cx, y: 100, "text-anchor": "middle", fill: t.ink,
      "font-size": 48, "font-weight": 600, "font-family": FONT
    }, svg).textContent = fmt(v);
    if (spec.unit) {
      el("text", {
        x: cx, y: 134, "text-anchor": "middle", fill: t.ink2,
        "font-size": 13, "font-family": FONT
      }, svg).textContent = spec.unit;
    }
    ctx.plotHeight = ctx.height;
  }

  // ---------------------------------------------------------------- small multiples

  function smallMultiples(ctx) {
    var spec = ctx.spec, t = ctx.t, svg = ctx.svg, colors = ctx.colors;
    var cats = spec.x.categories, series = ctx.visible;
    var cols = ctx.width < 520 ? 2 : (ctx.width < 800 ? 3 : 4);
    var rows = Math.ceil(series.length / cols);
    var cw = ctx.width / cols, ch = ctx.height / rows;
    var vals = [];
    series.forEach(function (s) {
      s.values.forEach(function (v) { if (v !== null && v !== undefined) vals.push(v); });
    });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (lo === hi) { lo -= 1; hi += 1; }

    series.forEach(function (s, k) {
      var gx = (k % cols) * cw, gy = Math.floor(k / cols) * ch;
      var pad = { l: 8, r: 8, t: 24, b: 16 };
      var pw = cw - pad.l - pad.r, ph = ch - pad.t - pad.b;
      var g = el("g", {}, svg);
      el("text", {
        x: gx + pad.l, y: gy + 14, fill: t.ink2, "font-size": 11, "font-family": FONT
      }, g).textContent = ellipsize(s.label, 11, pw - 46);
      el("line", {
        x1: gx + pad.l, x2: gx + pad.l + pw, y1: gy + pad.t + ph, y2: gy + pad.t + ph,
        stroke: t.grid, "stroke-width": 1
      }, g);
      var col = colors[ctx.index(s)];
      var d = "", pen = false, lastPt = null;
      s.values.forEach(function (v, i) {
        if (v === null || v === undefined) { pen = false; return; }
        var x = gx + pad.l + (cats.length === 1 ? pw / 2 : pw * i / (cats.length - 1));
        var y = gy + pad.t + ph - (v - lo) / (hi - lo) * ph;
        d += (pen ? "L" : "M") + x + "," + y; pen = true;
        lastPt = { x: x, y: y, v: v };
      });
      el("path", {
        d: d, fill: "none", stroke: col, "stroke-width": LINE_W,
        "stroke-linejoin": "round", "stroke-linecap": "round"
      }, g);
      if (lastPt) {
        el("circle", {
          cx: lastPt.x, cy: lastPt.y, r: 3.5, fill: col,
          stroke: t.surface, "stroke-width": GAP
        }, g);
        el("text", {
          x: gx + cw - pad.r, y: gy + 14, "text-anchor": "end", fill: t.muted,
          "font-size": 10, "font-family": FONT, "font-variant-numeric": "tabular-nums"
        }, g).textContent = fmtShort(lastPt.v);
      }
      var hit = el("rect", {
        x: gx, y: gy, width: cw, height: ch, fill: "transparent", "pointer-events": "all"
      }, svg);
      hit.addEventListener("pointermove", function (e) {
        var rc = svg.getBoundingClientRect();
        var mx = (e.clientX - rc.left) * ctx.width / rc.width;
        var my = (e.clientY - rc.top) * ctx.height / rc.height;
        var i = Math.round((mx - gx - pad.l) / (pw / Math.max(1, cats.length - 1)));
        i = Math.max(0, Math.min(cats.length - 1, i));
        ctx.tip.show(mx, my, s.label + " · " + (cats[i].full || cats[i].label),
          [{ color: col, name: spec.unit || "", value: fmt(s.values[i]) }]);
      });
      hit.addEventListener("pointerleave", function () { ctx.tip.hide(); });
    });
    ctx.plotHeight = ctx.height;
  }

  // ---------------------------------------------------------------- render

  /* Bars go horizontal once the category labels stop fitting under a column --
     the same threshold the inference uses to prefer a ranked bar. */
  function isHorizontal(spec) {
    if (spec.chart === "hbar" || spec.chart === "hbar_grouped") return true;
    return spec.chart === "diverging_bar" && spec.x.categories.length > 8;
  }

  function autoHeight(spec, width) {
    if (isHorizontal(spec)) {
      // any multi-series horizontal bar is drawn grouped, so the band has to
      // be tall enough for one bar per series
      var per = spec.series.length > 1 ? 16 * spec.series.length + 14 : 30;
      return Math.max(220, spec.x.categories.length * per + 40);
    }
    if (spec.chart === "heatmap") {
      return Math.max(240, spec.series.length * 22 + 60);
    }
    if (spec.chart === "small_multiples") {
      var cols = width < 520 ? 2 : (width < 800 ? 3 : 4);
      return Math.ceil(spec.series.length / cols) * 130;
    }
    if (spec.chart === "donut") return 360;
    if (spec.chart === "stat") return 150;
    return Math.max(280, Math.min(460, width * 0.5));
  }

  function render(container, spec, opts) {
    opts = opts || {};
    container.textContent = "";
    container.classList.add("viz-root");
    if (!spec || spec.chart === "empty" || !spec.series || !spec.series.length) {
      htm("p", "viz-empty", container, (spec && spec.reason) || "Tidak ada data untuk digambar.");
      return;
    }
    var hidden = opts.hidden || new Set();
    var t = tokens(container);
    var width = Math.max(300, container.clientWidth || 720);
    var height = opts.height || autoHeight(spec, width);

    // On a donut the slices ARE the categories, so identity (and colour) sits
    // on the x members; everywhere else it sits on the series.
    var isDonut = spec.chart === "donut";
    var classes = isDonut ? spec.x.categories : spec.series;
    var colors = classes.map(function (s, i) {
      if (isDonut) return t.series[i % 8];
      if (spec.color === "single" || spec.color === "diverging") return t.series[0];
      if (spec.color === "sequential") return rampColor(t.seq, i / Math.max(1, classes.length - 1));
      return t.series[i % 8];                       // fixed order, never cycled past 8
    });

    var plotBox = htm("div", "viz-plot", container);
    var svg = el("svg", {
      viewBox: "0 0 " + width + " " + height, width: "100%", height: height,
      role: "img", "aria-label": (spec.title || "") + " — " + (spec.chart_label || spec.chart)
    }, plotBox);
    el("title", {}, svg).textContent = (spec.title || "") + " (" + (spec.chart_label || "") + ")";

    var visible = spec.series.filter(function (s) { return !hidden.has(s.id); });
    if (!visible.length) visible = spec.series;

    var ctx = {
      spec: spec, svg: svg, t: t, colors: colors, width: width, height: height,
      container: plotBox, visible: visible, placed: [],
      showValues: opts.showValues !== false,
      index: function (s) { return spec.series.indexOf(s); },
      tip: Tip(plotBox)
    };

    if (spec.chart === "stat") stat(ctx);
    else if (spec.chart === "heatmap") heatmap(ctx);
    else if (spec.chart === "donut") donut(ctx);
    else if (spec.chart === "small_multiples") smallMultiples(ctx);
    else if (isHorizontal(spec)) horizontal(ctx);
    else cartesian(ctx);

    // Small multiples name every panel already, and a heatmap's colour means
    // magnitude (its scale bar is the legend) -- a series legend there would
    // claim an identity encoding the chart does not use.
    if (spec.chart !== "small_multiples" && spec.chart !== "heatmap") {
      var kind = (!isDonut && (spec.chart === "line" || spec.chart === "area"))
        ? "line" : "rect";
      legend(container, classes, colors, kind, hidden,
        isDonut ? null : (opts.onToggle || function () { }));
    }

    if (spec.truncated) {
      htm("p", "viz-note", container,
        "Menampilkan " + spec.truncated.shown + " dari " + spec.truncated.total +
        " kategori (urut nilai terbesar).");
    }
    (spec.notes || []).forEach(function (n) { htm("p", "viz-note", container, n); });
  }

  function svgString(container) {
    var svg = container.querySelector("svg");
    if (!svg) return "";
    var clone = svg.cloneNode(true);
    var t = tokens(container);
    clone.setAttribute("xmlns", NS);
    var bg = document.createElementNS(NS, "rect");
    bg.setAttribute("width", "100%"); bg.setAttribute("height", "100%");
    bg.setAttribute("fill", t.surface);
    clone.insertBefore(bg, clone.firstChild);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
  }

  global.BPSChart = {
    render: render, svgString: svgString, fmt: fmt, fmtShort: fmtShort,
    autoHeight: autoHeight
  };
})(window);

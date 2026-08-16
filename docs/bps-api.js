/* BPS WebAPI, straight from the browser.
 *
 * webapi.bps.go.id sends permissive CORS headers, so the published page can
 * call it directly and always show current data -- no server, no local machine.
 *
 * The key is the VISITOR'S OWN: it is typed into Settings, kept in this
 * browser's localStorage, and sent only to webapi.bps.go.id. Nothing is
 * committed to the repository and no key is shared between visitors. (Anyone
 * with access to this browser profile can read it back, which is why the local
 * service, where the key stays in a file on disk, remains the option for a
 * shared machine.)
 *
 * Produces the same cube shape as bps_api.to_cube, so docs/infer.js cannot tell
 * where the data came from.
 */
(function (global) {
  "use strict";

  var BASE = "https://webapi.bps.go.id/v1/api";
  var KEY_STORE = "bps-api-key";
  var LU_STORE = "bps-last-update";

  function getKey() {
    try { return localStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; }
  }

  function setKey(k) {
    try {
      if (k) localStorage.setItem(KEY_STORE, k.trim());
      else localStorage.removeItem(KEY_STORE);
    } catch (e) { }
  }

  function maskKey() {
    var k = getKey();
    return k ? k.slice(0, 4) + "…" + k.slice(-4) : "";
  }

  // BPS embeds markup and entities in labels ("<b>A. Pintu Udara</b>", "&amp;").
  // Decoding happens inside a detached <textarea>, where the parser treats the
  // content as raw text -- no elements are created, nothing can execute.
  var _decoder = null;
  function clean(s) {
    if (s === null || s === undefined) return "";
    var t = String(s).replace(/<[^>]+>/g, "");
    if (!_decoder) _decoder = document.createElement("textarea");
    _decoder.innerHTML = t;
    return _decoder.value.replace(/\s+/g, " ").trim();
  }

  function shortPeriod(p) {
    p = (p || "").trim();
    if (!p || p.toLowerCase() === "tahun") return "";
    return p.replace(/^Triwulan\s+/i, "TW ").replace(/^Semester\s+/i, "Sem ")
      .replace(/^Kuartal\s+/i, "TW ").slice(0, 12);
  }

  function request(url) {
    return fetch(url).then(function (r) {
      return r.json().then(function (d) {
        if (d && d.status === "Error") {
          throw new Error(d.message || "BPS API menolak permintaan ini.");
        }
        return d;
      }, function () { throw new Error("Jawaban BPS tidak dapat dibaca (HTTP " + r.status + ")."); });
    }, function () {
      throw new Error("Tidak dapat menghubungi webapi.bps.go.id. Periksa koneksi internet.");
    });
  }

  function settings(opts) {
    opts = opts || {};
    return {
      domain: opts.domain || "0000", lang: opts.lang || "ind",
      perpage: opts.perpage || 100
    };
  }

  /* Walk every page of a list endpoint. */
  function listAll(model, filt, opts) {
    var s = settings(opts);
    var key = getKey();
    if (!key) return Promise.reject(new Error("Kunci API BPS belum diisi."));
    var seg = filt ? filt + "/" : "";
    var out = [];
    function page(n) {
      var url = BASE + "/list/model/" + model + "/lang/" + s.lang + "/domain/" +
        s.domain + "/" + seg + "perpage/" + s.perpage + "/page/" + n + "/key/" + key + "/";
      return request(url).then(function (d) {
        var data = d.data;
        if (!(Array.isArray(data) && data.length > 1 && data[1] && data[1].length)) return out;
        out = out.concat(data[1]);
        var pages = (data[0] && data[0].pages) || 1;
        return n >= pages ? out : page(n + 1);
      });
    }
    return page(1);
  }

  function getSubjects(opts) {
    return listAll("subjectcsa", "", opts).then(function (rows) {
      return rows.map(function (r) {
        return {
          id: String(r.sub_id), title: clean(r.title),
          subcat: clean(r.subcat) || "Lainnya", ntabel: r.ntabel
        };
      });
    });
  }

  function getVars(subject, opts) {
    return listAll("var", "subjectcsa/" + subject, opts).then(function (rows) {
      return rows.map(function (r) {
        return {
          var_id: String(r.var_id), title: clean(r.title),
          unit: clean(r.unit || ""), sub_name: r.sub_name || ""
        };
      });
    });
  }

  function getYears(varId, opts) {
    return listAll("th", "var/" + varId, opts).then(function (rows) {
      return rows.map(function (r) { return { th_id: String(r.th_id), th: r.th }; });
    });
  }

  function getDomains() {
    var key = getKey();
    if (!key) return Promise.reject(new Error("Kunci API BPS belum diisi."));
    return request(BASE + "/domain/type/all/key/" + key + "/").then(function (d) {
      var rows = Array.isArray(d.data) && d.data.length > 1 ? d.data[1] : [];
      return rows.map(function (r) {
        return { id: String(r.domain_id), name: r.domain_name };
      });
    });
  }

  function fetchRaw(varId, th, opts) {
    var s = settings(opts);
    var key = getKey();
    if (!key) return Promise.reject(new Error("Kunci API BPS belum diisi."));
    return request(BASE + "/list/model/data/lang/" + s.lang + "/domain/" + s.domain +
      "/var/" + varId + "/th/" + th + "/key/" + key + "/");
  }

  /* Reconstruct the cube from one data response.
     key = [vervar][var][turvar][tahun][turtahun] -> value in datacontent. */
  function addResponse(acc, d) {
    if (!d || d["data-availability"] !== "available") return acc;
    var v = d["var"][0];
    var varId = String(v.val);
    acc.var_id = varId;
    acc.title = acc.title || clean(v.label);
    acc.unit = acc.unit || clean(v.unit || "");
    if (d.last_update && d.last_update > (acc.last_update || "")) {
      acc.last_update = d.last_update;
    }
    var vervar = d.vervar || [];
    var turvar = (d.turvar && d.turvar.length) ? d.turvar : [{ val: "", label: "" }];
    var tahun = d.tahun || [];
    var turtahun = (d.turtahun && d.turtahun.length) ? d.turtahun : [{ val: "", label: "" }];
    var dc = d.datacontent || {};

    vervar.forEach(function (vv) {
      var id = String(vv.val);
      if (!(id in acc._v)) { acc._v[id] = acc.vervar.length; acc.vervar.push([id, clean(vv.label)]); }
    });
    turvar.forEach(function (tv) {
      var id = String(tv.val);
      if (!(id in acc._t)) { acc._t[id] = acc.turvar.length; acc.turvar.push([id, clean(tv.label)]); }
    });
    tahun.forEach(function (ty) {
      turtahun.forEach(function (tt) {
        var id = String(ty.val) + "|" + String(tt.val);
        if (id in acc._p) return;
        var short = shortPeriod(clean(tt.label));
        var label = short ? clean(ty.label) + " " + short : clean(ty.label);
        var full = short ? clean(ty.label) + " " + clean(tt.label) : clean(ty.label);
        // Keep the bare sub-period name ("Januari", "Triwulan I", "Tahunan")
        // alongside the year-prefixed label: the chart layer needs it to spot a
        // period roll-up, which "2022 Tahunan" would hide.
        acc._p[id] = { label: label, full: full, sub: clean(tt.label),
          sort: [parseInt(ty.val, 10) || 0, parseInt(tt.val, 10) || 0] };
        acc._porder.push(id);
      });
    });

    vervar.forEach(function (vv) {
      turvar.forEach(function (tv) {
        tahun.forEach(function (ty) {
          turtahun.forEach(function (tt) {
            var k = String(vv.val) + varId + String(tv.val) + String(ty.val) + String(tt.val);
            if (!(k in dc)) return;
            var num = typeof dc[k] === "number" ? dc[k] : parseFloat(String(dc[k]).replace(",", "."));
            if (num === null || isNaN(num)) return;
            acc._cells.push([String(vv.val), String(tv.val),
              String(ty.val) + "|" + String(tt.val), num]);
          });
        });
      });
    });
    return acc;
  }

  function newAcc() {
    return {
      var_id: "", title: "", unit: "", last_update: "",
      vervar: [], turvar: [], time: [], values: [],
      _v: {}, _t: {}, _p: {}, _porder: [], _cells: []
    };
  }

  function finishCube(acc) {
    acc._porder.sort(function (a, b) {
      var A = acc._p[a].sort, B = acc._p[b].sort;
      return A[0] - B[0] || A[1] - B[1];
    });
    var pidx = {};
    acc.time = acc._porder.map(function (id, i) {
      pidx[id] = i;
      return [id, acc._p[id].label, acc._p[id].full, acc._p[id].sub];
    });

    /* BPS declares every member of every dimension in the response, including
       combinations it holds no data for. Keeping those would seat empty rows,
       phantom legend entries and empty periods in the chart -- and can change
       which chart gets picked -- so a member survives only if some cell of it
       carries a value. (This is what the Python side does by deriving the cube
       from decoded rows.) */
    var useV = {}, useT = {}, useP = {};
    acc._cells.forEach(function (c) {
      useV[acc._v[c[0]]] = 1; useT[acc._t[c[1]]] = 1; useP[pidx[c[2]]] = 1;
    });
    function compact(list, used) {
      var map = {}, out = [];
      list.forEach(function (m, i) {
        if (used[i]) { map[i] = out.length; out.push(m); }
      });
      return { list: out, map: map };
    }
    var V = compact(acc.vervar, useV);
    var T = compact(acc.turvar, useT);
    var P = compact(acc.time, useP);
    acc.vervar = V.list; acc.turvar = T.list; acc.time = P.list;

    acc.values = acc.vervar.map(function () {
      return acc.turvar.map(function () { return new Array(acc.time.length).fill(null); });
    });
    acc._cells.forEach(function (c) {
      acc.values[V.map[acc._v[c[0]]]][T.map[acc._t[c[1]]]][P.map[pidx[c[2]]]] = c[3];
    });
    var rows = acc._cells.length;
    delete acc._v; delete acc._t; delete acc._p; delete acc._porder; delete acc._cells;
    acc.source = { rows: rows, live: true };
    return acc;
  }

  /* One cube for a variable across one or more periods. */
  function getCube(varId, ths, opts) {
    var list = Array.isArray(ths) ? ths.slice() : [ths];
    var acc = newAcc();
    function step(i) {
      if (i >= list.length) return Promise.resolve(finishCube(acc));
      return fetchRaw(varId, list[i], opts).then(function (d) {
        addResponse(acc, d);
        if (d && d.last_update) rememberUpdate(varId, d.last_update);
        return step(i + 1);
      });
    }
    return step(0);
  }

  function getCubeLatest(varId, opts) {
    return getYears(varId, opts).then(function (ys) {
      if (!ys.length) throw new Error("Variabel ini tidak punya periode.");
      return getCube(varId, [ys[ys.length - 1].th_id], opts);
    });
  }

  /* last_update cache, so a variable list can show badges without refetching. */
  function loadUpdates() {
    try { return JSON.parse(localStorage.getItem(LU_STORE) || "{}"); }
    catch (e) { return {}; }
  }

  function rememberUpdate(varId, when) {
    try {
      var all = loadUpdates();
      all[varId] = when;
      localStorage.setItem(LU_STORE, JSON.stringify(all));
    } catch (e) { }
  }

  function getUpdate(varId) { return loadUpdates()[varId] || null; }

  /* Read only as far as `last_update`, which sits near the top of the response,
     then abort -- a data cube can be megabytes and the timestamp is all we
     want here. Falls back to a normal read where streaming is unavailable. */
  function fetchLastUpdate(varId, th, opts) {
    var s = settings(opts);
    var key = getKey();
    var url = BASE + "/list/model/data/lang/" + s.lang + "/domain/" + s.domain +
      "/var/" + varId + "/th/" + th + "/key/" + key + "/";
    return fetch(url).then(function (r) {
      if (!r.body || !r.body.getReader) {
        return r.json().then(function (d) { return d && d.last_update; });
      }
      var reader = r.body.getReader();
      var dec = new TextDecoder();
      var buf = "";
      function pump(n) {
        if (n > 12) { reader.cancel(); return null; }        // ~12 chunks is plenty
        return reader.read().then(function (res) {
          if (res.done) return match(buf);
          buf += dec.decode(res.value, { stream: true });
          var hit = match(buf);
          if (hit) { reader.cancel(); return hit; }
          return pump(n + 1);
        });
      }
      function match(s) {
        var m = /"last_update"\s*:\s*"([^"]*)"/.exec(s);
        return m ? m[1] : null;
      }
      return pump(0);
    });
  }

  /* The latest th_id per variable, cached: knowing which period to ask about
     is half the cost of an update check, and the period list almost never
     changes. */
  var TH_STORE = "bps-th-cache";
  var TH_TTL = 7 * 24 * 3600 * 1000;

  function loadTh() {
    try { return JSON.parse(localStorage.getItem(TH_STORE) || "{}"); }
    catch (e) { return {}; }
  }

  function latestTh(varId, opts) {
    var all = loadTh(), hit = all[varId];
    if (hit && Date.now() - hit.at < TH_TTL) return Promise.resolve(hit.th);
    return getYears(varId, opts).then(function (ys) {
      if (!ys.length) return null;
      var th = ys[ys.length - 1].th_id;
      try {
        all[varId] = { th: th, at: Date.now() };
        localStorage.setItem(TH_STORE, JSON.stringify(all));
      } catch (e) { }
      return th;
    });
  }

  /* last_update for one variable, remembered for next time. */
  function updateFor(varId, opts) {
    return latestTh(varId, opts).then(function (th) {
      if (!th) return null;
      return fetchLastUpdate(varId, th, opts);
    }).then(function (when) {
      if (when) rememberUpdate(varId, when);
      return when || null;
    });
  }

  /* Fetch last_update for many variables, a few at a time.
     `onProgress(done, total, varId, when)` fires per variable so a table can
     fill in as answers arrive instead of waiting for the whole sweep, and
     `shouldStop()` lets the caller abandon it. */
  function checkUpdates(vars, opts, onProgress, shouldStop) {
    var queue = vars.slice(), done = 0, results = {};
    function worker() {
      if (shouldStop && shouldStop()) return Promise.resolve();
      var v = queue.shift();
      if (!v) return Promise.resolve();
      var id = v.var_id;
      return updateFor(id, opts).then(function (when) {
        if (when) results[id] = when;
        done++;
        if (onProgress) onProgress(done, vars.length, id, when);
      }, function () {
        done++;
        if (onProgress) onProgress(done, vars.length, id, null);
      }).then(worker);
    }
    var pool = [];
    for (var i = 0; i < Math.min(4, vars.length); i++) pool.push(worker());
    return Promise.all(pool).then(function () { return results; });
  }

  global.BPSApi = {
    getKey: getKey, setKey: setKey, maskKey: maskKey,
    getSubjects: getSubjects, getVars: getVars, getYears: getYears,
    getDomains: getDomains, getCube: getCube, getCubeLatest: getCubeLatest,
    checkUpdates: checkUpdates, updateFor: updateFor,
    getUpdate: getUpdate, rememberUpdate: rememberUpdate,
    clean: clean
  };
})(window);

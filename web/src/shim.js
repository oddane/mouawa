/* Mouawa native bridge: implements the page runtime Mouawa expects (claude.use('db' | 'user' | 'assets'))
   on top of Supabase, and connects the page to the React Native shell. Loaded before Mouawa's own script. */
(function () {
  'use strict';
  var CFG = window.MOUAWA_CONFIG || {};
  var RN = window.ReactNativeWebView;
  var post = function (m) { try { if (RN) RN.postMessage(JSON.stringify(m)); } catch (e) {} };
  window.MOUAWA_NATIVE = true;
  window.mouawaPost = post;
  /* In the app, the shell remounts the page (WKWebView can't reliably reload an inline page). */
  window.mouawaReload = function () { if (RN) post({ t: 'reload' }); else location.reload(); };

  /* Storage that survives app restarts: the shell injects saved values as MOUAWA_STORE and saves every change. */
  var store = Object.assign({}, window.MOUAWA_STORE || {});
  var mouawaStore = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); post({ t: 'store', k: k, v: String(v) }); if (!RN) try { localStorage.setItem(k, v); } catch (e) {} },
    removeItem: function (k) { delete store[k]; post({ t: 'store', k: k, v: null }); if (!RN) try { localStorage.removeItem(k); } catch (e) {} }
  };
  if (!RN) { try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); store[k] = localStorage.getItem(k); } } catch (e) {} }
  window.mouawaStore = mouawaStore;

  /* Native niceties */
  try { navigator.vibrate = function (p) { post({ t: 'haptic', p: p }); return true; }; } catch (e) {}
  if (RN) {
    try { navigator.share = function (d) { post({ t: 'share', title: d && d.title, text: d && d.text, url: d && d.url }); return Promise.resolve(); }; } catch (e) {}
    window.open = function (url) { if (url) post({ t: 'open', url: String(url) }); return null; };
  }
  var lastTheme = '';
  function sendTheme() {
    var b = document.body; if (!b) return;
    var bg = getComputedStyle(b).backgroundColor || '#fff';
    var m = bg.match(/\d+(\.\d+)?/g) || [255, 255, 255];
    var lum = (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) / 255;
    var key = bg + (lum < 0.5);
    if (key !== lastTheme) { lastTheme = key; post({ t: 'theme', bg: bg, dark: lum < 0.5 }); }
  }
  window.mouawaSendTheme = sendTheme;
  document.addEventListener('DOMContentLoaded', function () {
    sendTheme();
    new MutationObserver(sendTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mesa', 'style', 'class'] });
    try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { setTimeout(sendTheme, 50); }); } catch (e) {}
    setTimeout(sendTheme, 600);
  });

  if (!window.supabase || !window.supabase.createClient || !CFG.url) { window.MOUAWA_OFFLINE = true; return; }
  var sb = window.supabase.createClient(CFG.url, CFG.key, {
    auth: { storage: mouawaStore, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'implicit' }
  });
  window.mouawaSB = sb;

  /* Email links (confirm sign-up, reset password) open the app with tokens in the URL. */
  window.__mouawaDeepLink = function (url) {
    try {
      var s = String(url || ''), q = (s.split('#')[1] || '') + '&' + ((s.split('?')[1] || '').split('#')[0]);
      var p = {}; q.split('&').forEach(function (kv) { var i = kv.indexOf('='); if (i > 0) p[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' ')); });
      if (p.error_description) { mouawaStore.setItem('mouawa-flash', p.error_description); window.mouawaReload(); return; }
      if (p.access_token && p.refresh_token) {
        sb.auth.setSession({ access_token: p.access_token, refresh_token: p.refresh_token }).then(function () {
          if (p.type === 'recovery') mouawaStore.setItem('mouawa-recovery', '1');
          if (p.type === 'signup' || p.type === 'email') mouawaStore.setItem('mouawa-flash', 'Email confirmed. Welcome to Mouawa.');
          if (p.type === 'email_change') mouawaStore.setItem('mouawa-flash', 'Your new email is confirmed.');
          mouawaStore.setItem('mouawa-fresh', '1');
          window.mouawaReload();
        });
      }
    } catch (e) {}
  };

  /* ---------- db: Mouawa's document API over the docs table ---------- */
  var E = function (e) { var x = new Error((e && e.message) || 'Request failed'); x.code = (e && e.code) || 'error'; if (/quota|exceed/i.test(x.message)) x.code = 'quota_exceeded'; if (/permission|policy|42501/.test(x.message + x.code)) x.code = 'permission_denied'; return x; };
  var clean = function (d) { return JSON.parse(JSON.stringify(d === undefined ? {} : d)); };
  var parentOf = function (p) { return p.replace(/\/[^/]+$/, ''); };
  var idOf = function (p) { return p.split('/').pop(); };
  var getPath = function (o, f) { return String(f).split('.').reduce(function (v, k) { return v == null ? v : v[k]; }, o); };
  function docSnap(path, data) { return { id: idOf(path), ref: { path: path }, exists: data !== undefined && data !== null, data: function () { return data == null ? undefined : data; } }; }

  /* One realtime channel for the whole table; listeners filter by collection or path. */
  var listeners = new Set(), channel = null;
  function ensureChannel() {
    if (channel) return;
    channel = sb.channel('mouawa-docs').on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, function (ch) {
      var row = ch.new && ch.new.path ? ch.new : null, old = ch.old || {};
      var path = row ? row.path : old.path; if (!path) return;
      var coll = row ? row.coll : parentOf(path);
      listeners.forEach(function (l) { l(ch.eventType, path, coll, row ? row.data : null); });
    }).subscribe();
  }
  sb.auth.onAuthStateChange(function (ev) {
    if ((ev === 'SIGNED_IN' || ev === 'TOKEN_REFRESHED') && channel) { try { sb.realtime.setAuth(); } catch (e) {} }
  });

  function docRef(path) {
    return {
      id: idOf(path), path: path,
      get: function () {
        return sb.from('docs').select('path,data').eq('path', path).maybeSingle().then(function (r) { if (r.error) throw E(r.error); return docSnap(path, r.data ? r.data.data : undefined); });
      },
      set: function (d) { return sb.rpc('doc_set', { p_path: path, p_data: clean(d) }).then(function (r) { if (r.error) throw E(r.error); }); },
      update: function (d) {
        return sb.rpc('doc_merge', { p_path: path, p_patch: clean(d) }).then(function (r) {
          if (r.error) { var x = E(r.error); if (/not_found/.test(r.error.message)) x.code = 'not_found'; throw x; }
        });
      },
      delete: function () { return sb.from('docs').delete().eq('path', path).then(function (r) { if (r.error) throw E(r.error); }); },
      onSnapshot: function (cb, onErr) {
        var alive = true, ready = false, queued = [], cur;
        var emit = function () { if (alive) cb(docSnap(path, cur)); };
        var l = function (type, p, c, data) {
          if (p !== path) return;
          if (!ready) { queued.push([type, data]); return; }
          cur = type === 'DELETE' ? undefined : data; emit();
        };
        listeners.add(l); ensureChannel();
        docRef(path).get().then(function (s) {
          cur = s.data(); ready = true;
          queued.forEach(function (q) { cur = q[0] === 'DELETE' ? undefined : q[1]; }); queued = [];
          emit();
        }).catch(function (e) { if (onErr) onErr(e); });
        return function () { alive = false; listeners.delete(l); };
      }
    };
  }

  function query(coll, q) {
    q = q || { where: [] };
    var api = {
      where: function (f, op, v) { return query(coll, Object.assign({}, q, { where: q.where.concat([[f, op, v]]) })); },
      orderBy: function (f, dir) { return query(coll, Object.assign({}, q, { order: [f, dir === 'desc' ? 'desc' : 'asc'] })); },
      limit: function (n) { return query(coll, Object.assign({}, q, { limit: n })); },
      doc: function (id) { return docRef(coll + '/' + id); },
      get: function () { return fetchAll().then(function (m) { return snapOf(m); }); },
      onSnapshot: function (cb, onErr) {
        var alive = true, ready = false, queued = [], map = new Map(), t = null;
        var emit = function () { if (!alive) return; clearTimeout(t); t = setTimeout(function () { if (alive) cb(snapOf(map)); }, 16); };
        var apply = function (type, path, data) { if (type === 'DELETE') map.delete(path); else map.set(path, data); };
        var l = function (type, path, c, data) {
          if (c !== coll) return;
          if (!ready) { queued.push([type, path, data]); return; }
          apply(type, path, data); emit();
        };
        listeners.add(l); ensureChannel();
        fetchAll().then(function (m) {
          map = m; ready = true; queued.forEach(function (x) { apply(x[0], x[1], x[2]); }); queued = [];
          if (alive) cb(snapOf(map));
        }).catch(function (e) { if (onErr) onErr(e); });
        return function () { alive = false; listeners.delete(l); };
      }
    };
    function match(d) {
      return q.where.every(function (w) {
        var v = getPath(d, w[0]);
        if (w[1] === 'array-contains') return Array.isArray(v) && v.indexOf(w[2]) >= 0;
        if (w[1] === '==') return v === w[2];
        if (w[1] === '!=') return v !== w[2];
        if (w[1] === '>') return v > w[2]; if (w[1] === '>=') return v >= w[2];
        if (w[1] === '<') return v < w[2]; if (w[1] === '<=') return v <= w[2];
        if (w[1] === 'in') return (w[2] || []).indexOf(v) >= 0;
        return true;
      });
    }
    function snapOf(map) {
      var docs = [];
      map.forEach(function (data, path) { if (data && match(data)) docs.push(docSnap(path, data)); });
      if (q.order) {
        var f = q.order[0], s = q.order[1] === 'desc' ? -1 : 1;
        docs.sort(function (a, b) { var x = getPath(a.data(), f), y = getPath(b.data(), f); return x === y ? 0 : (x == null ? -1 : y == null ? 1 : x < y ? -1 : 1) * s; });
      }
      if (q.limit) docs = docs.slice(0, q.limit);
      return { docs: docs, size: docs.length, empty: !docs.length, forEach: function (fn) { docs.forEach(fn); } };
    }
    function fetchAll() {
      var out = new Map(), page = 1000;
      var step = function (from) {
        var r = sb.from('docs').select('path,data').eq('coll', coll);
        q.where.forEach(function (w) { if (w[1] === 'array-contains' && !/\./.test(w[0])) r = r.contains('data->' + w[0], JSON.stringify([w[2]])); });
        if (q.order && !/\./.test(q.order[0])) r = r.order('data->' + q.order[0], { ascending: q.order[1] !== 'desc', nullsFirst: false });
        else r = r.order('path');
        return r.range(from, from + page - 1).then(function (res) {
          if (res.error) throw E(res.error);
          (res.data || []).forEach(function (row) { out.set(row.path, row.data); });
          var enough = q.limit && out.size >= q.limit;
          if ((res.data || []).length === page && !enough && from < 20000) return step(from + page);
          return out;
        });
      };
      return step(0);
    }
    return api;
  }

  var db = { doc: docRef, collection: function (c) { return query(c); } };

  /* ---------- user ---------- */
  var user = {
    me: function () {
      return sb.auth.getSession().then(function (r) {
        var s = r.data && r.data.session; if (!s) return null;
        var md = s.user.user_metadata || {};
        return { id: s.user.id, name: md.name || '', email: s.user.email || '' };
      });
    },
    id: function () { return user.me().then(function (m) { return m ? m.id : null; }); },
    profiles: function () { return Promise.resolve({}); },
    isOwner: function () { return sb.rpc('is_admin').then(function (r) { return !!r.data; }); }
  };

  /* ---------- assets: photos and videos in Supabase Storage ---------- */
  var assets = {
    upload: function (blob) {
      var id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
      return sb.storage.from('blobs').upload(id, blob, { contentType: blob.type || 'application/octet-stream', upsert: false, cacheControl: '31536000' })
        .then(function (r) { if (r.error) throw E(r.error); return { id: id }; });
    }
  };

  var caps = { db: db, user: user, assets: assets };
  window.claude = { use: function (name) { return new Promise(function (res) { setTimeout(function () { res(caps[name] || null); }, 0); }); } };
})();

'use strict';
/* ============================================================
   巷伴 後端（Vercel Serverless Function）
   一支檔案處理所有請求：/api/app?op=<動作>
   資料存放：Vercel Blob（私有 JSON 檔）；測試時可用記憶體（XB_STORE=memory）
   環境變數：
     BLOB_READ_WRITE_TOKEN  連接 Blob 儲存空間時 Vercel 自動加入
     ADMIN_PASSWORD         管理者密碼（你自己設定）
     SESSION_SECRET         （選填）簽發登入憑證用；沒設就由 Blob token 衍生
   ============================================================ */
var crypto = require('crypto');

var VERSION = '1.0.0';
var SAMPLE_SLOTS = 3;
var RES_DAYS = 90, ADM_HOURS = 8;
var MAX_FAILS = 5, LOCK_MIN = 15;

/* ---------- 小工具 ---------- */
function E(http, code, extra) { var e = new Error(code); e.http = http; e.code = code; e.extra = extra || {}; return e; }
function now() { return Date.now(); }
function sha(s, alg) { return crypto.createHash(alg || 'sha256').update(String(s)).digest('hex'); }
function rid(n) { var a = 'abcdefghijklmnopqrstuvwxyz0123456789', b = crypto.randomBytes(n), s = ''; for (var i = 0; i < n; i++) s += a[b[i] % 36]; return s; }
function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Buffer.from(s, 'base64'); }
function tseq(a, b) { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); }
var CTRL = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]', 'g');
function clean(s, max) {
  s = String(s == null ? '' : s).replace(CTRL, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, max).join('');
}
function cleanList(a, n, each) {
  var out = [];
  (Array.isArray(a) ? a : []).forEach(function (x) {
    x = clean(x, each); if (!x || out.length >= n) return;
    if (out.some(function (y) { return y.toLowerCase() === x.toLowerCase(); })) return;
    out.push(x);
  });
  return out;
}
function nickKey(name) { return sha(String(name).normalize('NFKC').toLowerCase().replace(/\s+/g, ''), 'sha1'); }
function normPw(x) { return String(x == null ? '' : x).replace(/[\s-]/g, '').toLowerCase(); }
function okId(x) { return typeof x === 'string' && /^[a-z0-9]{3,24}$/.test(x); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ---------- 儲存層 ---------- */
var MEM = {}, memSeq = 0;
function useMem() { return process.env.XB_STORE === 'memory'; }
var blobLib = null, ACCESS = null;
function BL() { return blobLib || (blobLib = require('@vercel/blob')); }
function storeReady() { return useMem() || !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID); }

async function detectAccess() {
  if (ACCESS) return ACCESS;
  var first = null;
  for (var a of ['private', 'public']) {
    try {
      await BL().put('v1/probe.json', '{"t":' + now() + '}', { access: a, contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60 });
      ACCESS = a; return a;
    } catch (e) { first = first || e; }
  }
  throw first;
}
async function sGet(p) {
  if (!storeReady()) throw E(503, 'nostore');
  if (useMem()) { var m = MEM[p]; return m ? { data: JSON.parse(m.s), etag: m.e } : null; }
  var acc = await detectAccess(), r;
  try { r = await BL().get(p, { access: acc, useCache: false }); }
  catch (e) { if (/not.?found|404/i.test(String(e && (e.name + ' ' + e.message)))) return null; throw e; }
  if (!r || !r.stream) return null;
  var txt = await new Response(r.stream).text();
  return { data: JSON.parse(txt), etag: r.blob && r.blob.etag };
}
async function sPut(p, data, opt) {
  opt = opt || {};
  if (!storeReady()) throw E(503, 'nostore');
  var s = JSON.stringify(data);
  if (useMem()) {
    var cur = MEM[p];
    if (opt.create && cur) throw E(409, 'exists');
    if (opt.ifMatch && (!cur || cur.e !== opt.ifMatch)) throw E(409, 'conflict');
    var e = 'e' + (++memSeq); MEM[p] = { s: s, e: e }; return e;
  }
  var acc = await detectAccess();
  var o = { access: acc, contentType: 'application/json', addRandomSuffix: false, cacheControlMaxAge: 60 };
  if (opt.ifMatch) o.ifMatch = opt.ifMatch; else o.allowOverwrite = !opt.create;
  try { var r = await BL().put(p, s, o); return r && r.etag; }
  catch (err) {
    var t = String(err && (err.name + ' ' + err.message));
    if (/PreconditionFailed/i.test(t)) throw E(409, 'conflict');
    if (/already exists/i.test(t)) throw E(409, 'exists');
    throw err;
  }
}
async function sDel(p) {
  if (!storeReady()) throw E(503, 'nostore');
  if (useMem()) { delete MEM[p]; return; }
  await detectAccess();
  try { await BL().del(p); } catch (e) { if (!/not.?found|404/i.test(String(e && (e.name + ' ' + e.message)))) throw e; }
}
async function sList(prefix) {
  if (!storeReady()) throw E(503, 'nostore');
  if (useMem()) return Object.keys(MEM).filter(function (k) { return k.indexOf(prefix) === 0; }).sort();
  await detectAccess();
  var out = [], cursor;
  for (var i = 0; i < 20; i++) {
    var r = await BL().list({ prefix: prefix, limit: 1000, cursor: cursor });
    r.blobs.forEach(function (b) { out.push(b.pathname); });
    if (!r.hasMore) break; cursor = r.cursor;
  }
  return out.sort();
}
/* 讀-改-寫（用 etag 避免兩個人同時寫時互相蓋掉）*/
async function update(path, fn, init) {
  for (var i = 0; i < 8; i++) {
    var cur = await sGet(path), data = cur ? cur.data : init();
    var r = await fn(data);
    if (r === false) return false;
    try { await sPut(path, data, cur ? { ifMatch: cur.etag } : { create: true }); return true; }
    catch (e) { if (e.code !== 'conflict' && e.code !== 'exists') throw e; await sleep(30 + Math.random() * 120); }
  }
  throw E(503, 'busy');
}

/* ---------- 密碼與登入憑證 ---------- */
var SECRET = null;
function secret() { return SECRET; }
async function ensureSecret() {
  if (SECRET) return SECRET;
  if (process.env.SESSION_SECRET) return (SECRET = process.env.SESSION_SECRET);
  if (process.env.BLOB_READ_WRITE_TOKEN) return (SECRET = 'xb|' + process.env.BLOB_READ_WRITE_TOKEN);
  if (useMem()) return (SECRET = 'dev-secret');
  if (!storeReady()) return null;
  /* 新版 Vercel Blob 沒有 token：第一次使用時，在私有儲存空間裡產生一把只有伺服器讀得到的隨機金鑰 */
  for (var i = 0; i < 3; i++) {
    var c = await sGet('v1/secret.json');
    if (c && c.data && c.data.k) return (SECRET = 'xb2|' + c.data.k);
    try { await sPut('v1/secret.json', { k: crypto.randomBytes(32).toString('hex') }, { create: true }); }
    catch (e) { if (e.code !== 'exists') throw e; }
  }
  return null;
}
function sign(payload) {
  var sec = secret(); if (!sec) throw E(503, 'nosecret');
  var b = b64u(JSON.stringify(payload));
  return b + '.' + b64u(crypto.createHmac('sha256', sec).update(b).digest());
}
function verify(tok) {
  var sec = secret(); if (!sec || typeof tok !== 'string') return null;
  var i = tok.indexOf('.'); if (i < 1) return null;
  var b = tok.slice(0, i), sg = tok.slice(i + 1);
  if (!tseq(sg, b64u(crypto.createHmac('sha256', sec).update(b).digest()))) return null;
  try { var p = JSON.parse(unb64u(b).toString('utf8')); return p && p.exp > now() ? p : null; } catch (e) { return null; }
}
function pbkdf(pin, salt) {
  return new Promise(function (ok, no) { crypto.pbkdf2(String(pin), salt, 120000, 32, 'sha256', function (e, k) { e ? no(e) : ok(k.toString('hex')); }); });
}
function authOf(req, role) {
  var h = req.headers && (req.headers.authorization || req.headers.Authorization) || '';
  var p = verify(h.replace(/^Bearer\s+/i, ''));
  if (!p) throw E(401, 'auth');
  if (role && p.r !== role) throw E(403, 'role');
  return p;
}

/* ---------- 資料整理 ---------- */
var TIMES = ['平日上午', '平日下午', '週末', '都可以'];
function cleanProfile(p) {
  p = p || {};
  var name = clean(p.name, 12);
  return {
    name: name, job: clean(p.job, 20), skills: cleanList(p.skills, 8, 14), wants: cleanList(p.wants, 8, 14),
    about: clean(p.about, 40), time: TIMES.indexOf(p.time) >= 0 ? p.time : '都可以',
    av: /^[a-z0-9_-]{1,20}$/i.test(String(p.av)) ? String(p.av) : 'xiaoqi',
    style: [0, 1, 2].indexOf(p.style) >= 0 ? p.style : 0,
    sign: clean(p.sign, 10) || (name + '的家'), greet: clean(p.greet, 30) || '歡迎來坐坐。',
    decor: ['flower', 'tree', 'none'].indexOf(p.decor) >= 0 ? p.decor : 'flower'
  };
}
function pubList(idx) { return Object.keys(idx.items).map(function (id) { var o = Object.assign({}, idx.items[id]); o.id = id; return o; }); }
async function getIdx() { var c = await sGet('v1/idx.json'); return c ? c.data : { v: 1, items: {} }; }
function pickSlot(items, want, max) {
  var used = {}; Object.keys(items).forEach(function (k) { if (items[k].slot != null) used[items[k].slot] = 1; });
  max = Math.max(SAMPLE_SLOTS + 1, Math.min(60, max | 0 || 12));
  if (want >= SAMPLE_SLOTS && want < max && !used[want]) return want;
  for (var s = SAMPLE_SLOTS; s < max; s++) if (!used[s]) return s;
  return SAMPLE_SLOTS + Math.floor(Math.random() * (max - SAMPLE_SLOTS));
}
async function wipeResident(id) {
  var a = await sGet('v1/auth/' + id + '.json');
  await update('v1/idx.json', function (d) { if (!d.items[id]) return false; delete d.items[id]; }, function () { return { v: 1, items: {} }; });
  if (a && a.data.key) await sDel('v1/nick/' + a.data.key + '.json');
  await sDel('v1/auth/' + id + '.json'); await sDel('v1/prog/' + id + '.json'); await sDel('v1/msg/' + id + '.json');
}
function remainMin(t) { return Math.max(1, Math.ceil((t - now()) / 60000)); }

/* ---------- 各個動作 ---------- */
var OPS = {};

OPS.health = async function (req, body, q) {
  var out = { ok: true, version: VERSION, storeConfigured: storeReady(), adminSet: !!process.env.ADMIN_PASSWORD, secretOk: false, node: process.version };
  var pw = normPw(process.env.ADMIN_PASSWORD || '');
  out.adminWeak = !!pw && (pw.length < 8 || pw === 'xiangban');
  out.storage = { ok: false };
  out.ok = false;
  if (!out.storeConfigured) { out.storage.error = '還沒有連接 Blob 儲存空間（找不到 BLOB_STORE_ID 或 BLOB_READ_WRITE_TOKEN）'; return out; }
  try {
    var t = 'x' + now();
    await sPut('v1/health/probe.json', { t: t });
    var g = await sGet('v1/health/probe.json');
    if (!g || g.data.t !== t) throw new Error('寫入後讀回來的內容不一致');
    var l = await sList('v1/health/'); if (l.indexOf('v1/health/probe.json') < 0) throw new Error('列表找不到剛寫入的檔案');
    await sDel('v1/health/probe.json');
    out.storage = { ok: true, access: useMem() ? 'memory' : ACCESS };
    await ensureSecret(); out.secretOk = !!secret();
    var idx = await getIdx(); out.residents = Object.keys(idx.items).length;
  } catch (e) { out.storage = { ok: false, error: String(e && e.message || e).slice(0, 300) }; }
  out.ok = out.storage.ok && out.adminSet && out.secretOk;
  return out;
};

OPS.nick = async function (req, body) {
  var name = clean(body.name, 12); if (!name) throw E(400, 'name');
  var c = await sGet('v1/nick/' + nickKey(name) + '.json');
  return { free: !c };
};

OPS.register = async function (req, body) {
  var prof = cleanProfile(body.profile || {});
  prof.name = clean(body.name || prof.name, 12);
  if (!prof.name) throw E(400, 'name');
  if (!/^\d{4}$/.test(String(body.pin))) throw E(400, 'pin');
  var key = nickKey(prof.name), id = 'r' + rid(10);
  try { await sPut('v1/nick/' + key + '.json', { id: id }, { create: true }); }
  catch (e) { if (e.code === 'exists') throw E(409, 'nick'); throw e; }
  try {
    var salt = crypto.randomBytes(16).toString('hex'), h = await pbkdf(body.pin, salt);
    await sPut('v1/auth/' + id + '.json', { nick: prof.name, key: key, salt: salt, h: h, fails: 0, lock: 0, ts: now(), last: 0 }, { create: true });
    await update('v1/idx.json', function (d) {
      prof.slot = pickSlot(d.items, body.slot | 0, body.slotMax); prof.ts = now(); d.items[id] = prof;
    }, function () { return { v: 1, items: {} }; });
  } catch (e) {
    await sDel('v1/nick/' + key + '.json').catch(function () { }); await sDel('v1/auth/' + id + '.json').catch(function () { });
    throw e;
  }
  return { token: sign({ r: 'res', id: id, exp: now() + RES_DAYS * 864e5 }), id: id, profile: prof };
};

OPS.login = async function (req, body) {
  var name = clean(body.name, 12), pin = String(body.pin || '');
  if (!name || !/^\d{4}$/.test(pin)) throw E(401, 'bad');
  var nk = await sGet('v1/nick/' + nickKey(name) + '.json');
  if (!nk) { await pbkdf(pin, 'x'); throw E(401, 'bad'); }
  var id = nk.data.id, cur = await sGet('v1/auth/' + id + '.json');
  if (!cur) throw E(401, 'bad');
  var a = cur.data;
  if (a.lock > now()) throw E(423, 'locked', { mins: remainMin(a.lock) });
  var h = await pbkdf(pin, a.salt);
  if (!tseq(h, a.h)) {
    a.fails = (a.fails || 0) + 1; var left = MAX_FAILS - a.fails;
    if (a.fails >= MAX_FAILS) { a.lock = now() + LOCK_MIN * 60000; a.fails = 0; left = 0; }
    await sPut('v1/auth/' + id + '.json', a).catch(function () { });
    throw E(401, 'bad', { left: left, locked: left === 0 });
  }
  if (a.fails || a.lock) { a.fails = 0; a.lock = 0; await sPut('v1/auth/' + id + '.json', a).catch(function () { }); }
  var idx = await getIdx(), prof = idx.items[id];
  if (!prof) throw E(401, 'bad');
  var pg = await sGet('v1/prog/' + id + '.json');
  return { token: sign({ r: 'res', id: id, exp: now() + RES_DAYS * 864e5 }), id: id, profile: Object.assign({ id: id }, prof), progress: pg ? pg.data : null };
};

OPS.me = async function (req) {
  var p = authOf(req, 'res'), idx = await getIdx(), prof = idx.items[p.id];
  if (!prof) throw E(401, 'gone');
  var pg = await sGet('v1/prog/' + p.id + '.json');
  return { id: p.id, profile: Object.assign({ id: p.id }, prof), progress: pg ? pg.data : null };
};

OPS.save = async function (req, body) {
  var p = authOf(req, 'res'), id = p.id, out = {};
  if (body.progress) {
    var js = JSON.stringify(body.progress);
    if (js.length > 20000) throw E(413, 'big');
    await sPut('v1/prog/' + id + '.json', JSON.parse(js)); out.progress = true;
  }
  if (body.profile) {
    var np = cleanProfile(body.profile); if (!np.name) throw E(400, 'name');
    var au = await sGet('v1/auth/' + id + '.json'); if (!au) throw E(401, 'gone');
    var nk = nickKey(np.name), oldKey = au.data.key;
    if (nk !== oldKey) {
      try { await sPut('v1/nick/' + nk + '.json', { id: id }, { create: true }); }
      catch (e) { if (e.code === 'exists') throw E(409, 'nick'); throw e; }
    }
    var saved = null;
    var ok = await update('v1/idx.json', function (d) {
      var o = d.items[id]; if (!o) return false;
      np.slot = o.slot; np.ts = o.ts; d.items[id] = np; saved = np;
    }, function () { return { v: 1, items: {} }; });
    if (!ok) { if (nk !== oldKey) await sDel('v1/nick/' + nk + '.json'); throw E(401, 'gone'); }
    if (nk !== oldKey) { au.data.key = nk; au.data.nick = np.name; await sPut('v1/auth/' + id + '.json', au.data); await sDel('v1/nick/' + oldKey + '.json'); }
    out.profile = Object.assign({ id: id }, saved);
  }
  return out;
};

OPS.residents = async function (req) {
  var p = authOf(req), idx = await getIdx();
  if (p.r === 'res' && !idx.items[p.id]) throw E(401, 'gone');
  return { items: pubList(idx) };
};

OPS.msgs = async function (req, body) {
  var p = authOf(req); if (!okId(body.to)) throw E(400, 'to');
  var c = await sGet('v1/msg/' + body.to + '.json');
  return { items: (c ? c.data.items : []).slice(-30).reverse() };
};

OPS.say = async function (req, body) {
  var p = authOf(req, 'res'), to = body.to, text = clean(body.text, 60);
  if (!okId(to) || !text) throw E(400, 'msg');
  var idx = await getIdx();
  if (!idx.items[p.id]) throw E(401, 'gone');
  if (!idx.items[to]) throw E(404, 'to');
  var au = await sGet('v1/auth/' + p.id + '.json');
  if (au && au.data.last && now() - au.data.last < 3000) throw E(429, 'slow');
  if (au) { au.data.last = now(); await sPut('v1/auth/' + p.id + '.json', au.data).catch(function () { }); }
  var m = { id: now() + '-' + rid(4), from: p.id, text: text, ts: now() };
  await update('v1/msg/' + to + '.json', function (d) { d.items.push(m); if (d.items.length > 100) d.items = d.items.slice(-100); }, function () { return { items: [] }; });
  return { ok: true, msg: m };
};

OPS.chpin = async function (req, body) {
  var p = authOf(req, 'res');
  if (!/^\d{4}$/.test(String(body.newPin))) throw E(400, 'pin');
  var cur = await sGet('v1/auth/' + p.id + '.json'); if (!cur) throw E(401, 'gone');
  var a = cur.data;
  if (a.lock > now()) throw E(423, 'locked', { mins: remainMin(a.lock) });
  if (!tseq(await pbkdf(body.pin, a.salt), a.h)) {
    a.fails = (a.fails || 0) + 1; if (a.fails >= MAX_FAILS) { a.lock = now() + LOCK_MIN * 60000; a.fails = 0; }
    await sPut('v1/auth/' + p.id + '.json', a).catch(function () { });
    throw E(401, 'bad');
  }
  a.salt = crypto.randomBytes(16).toString('hex'); a.h = await pbkdf(body.newPin, a.salt); a.fails = 0; a.lock = 0;
  await sPut('v1/auth/' + p.id + '.json', a);
  return { ok: true };
};

OPS.delme = async function (req) {
  var p = authOf(req, 'res'); await wipeResident(p.id); return { ok: true };
};

/* ----- 管理者 ----- */
async function admLimit(req) {
  var ip = String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || 'local').split(',')[0].trim();
  return 'v1/rl/adm-' + sha(ip, 'sha1') + '.json';
}
OPS.adm_login = async function (req, body) {
  var pw = process.env.ADMIN_PASSWORD; if (!pw) throw E(503, 'noadmin');
  var key = await admLimit(req), cur = await sGet(key), st = cur ? cur.data : { n: 0, until: 0 };
  if (st.until > now()) throw E(423, 'locked', { mins: remainMin(st.until) });
  var ok = tseq(sha(normPw(body.password)), sha(normPw(pw)));
  if (!ok) {
    await sleep(400); st.n = (st.n || 0) + 1;
    if (st.n >= MAX_FAILS) { st.until = now() + LOCK_MIN * 60000; st.n = 0; }
    await sPut(key, st).catch(function () { });
    throw E(401, 'bad', { left: st.until > now() ? 0 : MAX_FAILS - st.n });
  }
  if (st.n || st.until) await sPut(key, { n: 0, until: 0 }).catch(function () { });
  return { token: sign({ r: 'adm', exp: now() + ADM_HOURS * 3600e3 }), hours: ADM_HOURS };
};
OPS.adm_list = async function (req) {
  authOf(req, 'adm');
  var idx = await getIdx(), files = await sList('v1/msg/'), msgs = [];
  var rows = await Promise.all(files.slice(0, 400).map(function (f) { return sGet(f).catch(function () { return null; }); }));
  rows.forEach(function (c, i) {
    if (!c) return; var to = files[i].replace(/^v1\/msg\//, '').replace(/\.json$/, '');
    c.data.items.forEach(function (m) { msgs.push({ id: m.id, to: to, from: m.from, text: m.text, ts: m.ts }); });
  });
  msgs.sort(function (a, b) { return b.ts - a.ts; });
  return { items: pubList(idx), msgs: msgs.slice(0, 500) };
};
OPS.adm_del_res = async function (req, body) {
  authOf(req, 'adm'); if (!okId(body.id)) throw E(400, 'id'); await wipeResident(body.id); return { ok: true };
};
OPS.adm_del_msg = async function (req, body) {
  authOf(req, 'adm'); if (!okId(body.to) || typeof body.id !== 'string') throw E(400, 'id');
  await update('v1/msg/' + body.to + '.json', function (d) { var n = d.items.length; d.items = d.items.filter(function (m) { return m.id !== body.id; }); if (d.items.length === n) return false; }, function () { return { items: [] }; });
  return { ok: true };
};
OPS.adm_reset_pin = async function (req, body) {
  authOf(req, 'adm'); if (!okId(body.id)) throw E(400, 'id');
  var cur = await sGet('v1/auth/' + body.id + '.json'); if (!cur) throw E(404, 'none');
  var pin = String(crypto.randomInt(0, 10000)).padStart(4, '0'), salt = crypto.randomBytes(16).toString('hex');
  cur.data.salt = salt; cur.data.h = await pbkdf(pin, salt); cur.data.fails = 0; cur.data.lock = 0;
  await sPut('v1/auth/' + body.id + '.json', cur.data);
  return { pin: pin };
};

/* ---------- 入口 ---------- */
async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  var raw = typeof req.body === 'string' ? req.body : await new Promise(function (ok, no) {
    var b = []; req.on('data', function (c) { b.push(c); if (Buffer.concat(b).length > 60000) { no(E(413, 'big')); req.destroy && req.destroy(); } }); req.on('end', function () { ok(Buffer.concat(b).toString('utf8')); }); req.on('error', no);
  });
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { throw E(400, 'json'); }
}
function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(obj));
}
async function handler(req, res) {
  try {
    var q = req.query; if (!q) { try { q = Object.fromEntries(new URL(req.url, 'http://x').searchParams); } catch (e) { q = {}; } }
    var op = String(q.op || ''), fn = OPS[op];
    if (!fn) return send(res, 404, { error: 'op' });
    if (op !== 'health' && req.method !== 'POST') return send(res, 405, { error: 'method' });
    var body = await readBody(req);
    if (op !== 'health') { await ensureSecret(); }
    var out = await fn(req, body, q);
    send(res, 200, out);
  } catch (e) {
    if (e && e.http) return send(res, e.http, Object.assign({ error: e.code }, e.extra || {}));
    console.error('xb api error', e && e.stack || e);
    send(res, 500, { error: 'server', detail: String(e && e.message || e).slice(0, 200) });
  }
}
module.exports = handler;
module.exports._mem = MEM;
module.exports._ops = OPS;

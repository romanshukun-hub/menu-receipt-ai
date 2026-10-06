// Restaurant pages and short share links: a menu prepared in the app (dishes already translated into every language) is kept on the server
// as rdata:<name>, and guests open it with ?r=<name>.
// Setup (Vercel > Project > Storage): connect an Upstash Redis database (adds KV_REST_API_URL / KV_REST_API_TOKEN)
// or a Blob store (adds BLOB_READ_WRITE_TOKEN), and set ADMIN_KEY in Environment Variables - only someone with that
// code can create or update pages. Settings take effect after the next deployment.
// GET /api/rest?diag=1 tells which of these the server sees (never their values).
const crypto = require('crypto');

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const fail = (res, status, code, error) => res.status(status).json({ error, code });
const isAdmin = k => { const a = (process.env.ADMIN_KEY || '').trim(); if (!a || typeof k !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(k.trim()); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const tries = new Map(); // best-effort limit on wrong codes, per instance

// storage: Upstash Redis (REST) if connected, else Vercel Blob
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = async cmd => { const r = await fetch(RURL, { method: 'POST', headers: { Authorization: `Bearer ${RTOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error(j.error || 'storage'); return j.result; };
const store = {
  ready: () => !!(RURL && RTOK) || !!process.env.BLOB_READ_WRITE_TOKEN,
  // keys: "rdata:<page>" (restaurant pages), "share:<code>" (a shared menu or bill, kept for 90 days)
  async get(k) {
    if (RURL && RTOK) return await redis(['GET', k]);
    const { head } = require('@vercel/blob'); let meta; try { meta = await head(k.replace(':', '/') + '.json'); } catch (e) { return null; }
    const r = await fetch(meta.url, { cache: 'no-store' }); return r.ok ? await r.text() : null;
  },
  async set(k, body, ttl) {
    if (RURL && RTOK) return await redis(ttl ? ['SET', k, body, 'EX', ttl] : ['SET', k, body]);
    const { put } = require('@vercel/blob');
    await put(k.replace(':', '/') + '.json', body, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 });
  }
};
// a business account's key is its phone number's last 9 digits, so "050-123-4567", "+972 50 123 4567" and "0501234567" match
const phoneKey = p => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 9 && d.length <= 15 ? d.slice(-9) : null; };
const hashPw = pw => { const salt = crypto.randomBytes(16); return { salt: salt.toString('hex'), hash: crypto.scryptSync(pw, salt, 32).toString('hex') }; };
const sessPhone = async t => typeof t === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(t) && RURL && RTOK ? await redis(['GET', `sess:${t}`]) : null;
const CODE = /^[A-Za-z0-9]{8,12}$/, shares = new Map(); // shares: best-effort limit on new share links, per instance
const newCode = () => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789', b = crypto.randomBytes(10); let s = ''; for (const x of b) s += a[x % a.length]; return s; };

// Live bill split: "live:<code>:bill" holds the packed bill, "live:<code>" holds {"v": version, "st": split state}.
// A change is saved only on top of the version it was made from (compare-and-set in one Redis script); otherwise the
// current state comes back and the app merges its own changes into it and tries again. Kept for 7 days.
const LIVE_TTL = 7 * 86400;
const CAS = `local cur=redis.call('GET',KEYS[1]) if not cur then return {-1,''} end local d=cjson.decode(cur)
if tonumber(d.v)~=tonumber(ARGV[1]) then return {0,cur} end local nv=tonumber(d.v)+1
redis.call('SET',KEYS[1],'{"v":'..nv..',"st":'..ARGV[2]..'}','EX',ARGV[3]) redis.call('EXPIRE',KEYS[2],ARGV[3]) return {nv,''}`;

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      if (req.query.diag) return res.status(200).json({ adminKey: !!(process.env.ADMIN_KEY || '').trim(), redis: !!(RURL && RTOK), blob: !!process.env.BLOB_READ_WRITE_TOKEN });
      // a live split: the whole bill when opening it, then only the state (and only when it changed since "since")
      if (req.query.live) {
        const code = String(req.query.live);
        if (!CODE.test(code) || !(RURL && RTOK)) return fail(res, 404, 'none', 'Not found.');
        res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex');
        const doc = await redis(['GET', `live:${code}`]); if (!doc) return fail(res, 404, 'none', 'Not found.');
        const d = JSON.parse(doc), since = parseInt(req.query.since);
        if (!isNaN(since)) return res.status(200).json(d.v > since ? d : { v: d.v });
        const packed = await redis(['GET', `live:${code}:bill`]); if (!packed) return fail(res, 404, 'none', 'Not found.');
        return res.status(200).json({ packed, v: d.v, st: d.st });
      }
      // opening a short share link (?s=<code>): the packed menu or bill
      if (req.query.share) {
        const code = String(req.query.share);
        if (!CODE.test(code) || !store.ready()) return fail(res, 404, 'none', 'Not found.');
        const v = await store.get(`share:${code}`);
        if (!v) return fail(res, 404, 'none', 'Not found.');
        res.setHeader('Cache-Control', 'private, max-age=300'); res.setHeader('X-Robots-Tag', 'noindex');
        return res.status(200).json({ packed: v });
      }
      // a guest opening a page
      const slug = String(req.query.slug || '');
      if (!SLUG.test(slug)) return fail(res, 400, 'slug', 'Invalid page name.');
      if (!store.ready()) return fail(res, 404, 'none', 'Not found.');
      const body = await store.get(`rdata:${slug}`);
      if (!body) return fail(res, 404, 'none', 'Not found.');
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
      res.setHeader('X-Robots-Tag', 'noindex');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(body);
    }
    if (req.method !== 'POST') return fail(res, 405, 'method', 'Method not allowed');
    const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim(), now = Date.now();
    // live split: start one (the bill and its split so far) or save a change to one
    if ((req.body || {}).live !== undefined) {
      const b = req.body; if (!(RURL && RTOK)) return fail(res, 503, 'config', 'Live split is not available.');
      const st = JSON.stringify(b.st || {}); if (st.length > 60000 || typeof b.st !== 'object') return fail(res, 400, 'data', 'Invalid split.');
      if (b.live === 'new') {
        const packed = b.packed;
        if (typeof packed !== 'string' || packed.length < 10 || packed.length > 300000 || !/^[zj][A-Za-z0-9_-]+$/.test(packed)) return fail(res, 400, 'data', 'Invalid bill.');
        const recent = (shares.get(ip) || []).filter(t => now - t < 600000);
        if (recent.length >= 30) return fail(res, 429, 'rate', 'Too many share links. Try again later.');
        shares.set(ip, [...recent, now]);
        const code = newCode();
        await redis(['SET', `live:${code}:bill`, packed, 'EX', LIVE_TTL]);
        await redis(['SET', `live:${code}`, JSON.stringify({ v: 1, st: b.st }), 'EX', LIVE_TTL]);
        return res.status(200).json({ code, v: 1 });
      }
      const code = String(b.live); if (!CODE.test(code)) return fail(res, 400, 'data', 'Invalid split.');
      const r = await redis(['EVAL', CAS, '2', `live:${code}`, `live:${code}:bill`, String(parseInt(b.base) || 0), st, String(LIVE_TTL)]);
      if (r[0] === -1) return fail(res, 404, 'none', 'Not found.');
      if (r[0] === 0) { const d = JSON.parse(r[1]); return res.status(409).json({ ok: false, v: d.v, st: d.st }); }
      return res.status(200).json({ ok: true, v: r[0] });
    }
    // a short link for sharing a menu or a bill (anyone may create one): the packed text is kept for 90 days under a random code
    if ((req.body || {}).share !== undefined) {
      const packed = req.body.share;
      if (!store.ready()) return fail(res, 503, 'config', 'Short links are not available.');
      if (typeof packed !== 'string' || packed.length < 10 || packed.length > 300000 || !/^[zj][A-Za-z0-9_-]+$/.test(packed)) return fail(res, 400, 'data', 'Invalid share.');
      const recent = (shares.get(ip) || []).filter(t => now - t < 600000);
      if (recent.length >= 30) return fail(res, 429, 'rate', 'Too many share links. Try again later.');
      shares.set(ip, [...recent, now]);
      const code = newCode(); await store.set(`share:${code}`, packed, 90 * 86400);
      return res.status(200).json({ code });
    }
    const { key, slug, data, check, edit } = req.body || {};
    // the manager code (?admin= in the app) - checked, with a limit on wrong tries
    if (check) {
      const bad = (tries.get(ip) || []).filter(t => now - t < 600000);
      if (bad.length >= 10) return fail(res, 429, 'rate', 'Too many attempts. Try again later.');
      if (!isAdmin(key)) { tries.set(ip, [...bad, now]); return fail(res, 403, 'key', 'Wrong manager code.'); }
      return res.status(200).json({ ok: true, storage: store.ready() });
    }
    if (!(RURL && RTOK)) return fail(res, 500, 'config', 'Page storage is not connected.');
    // ---- business accounts: phone number + password ----
    // "acct:<phone>" = {salt, hash (scrypt), pages: [{slug, title}]}; signing in gives a session ("sess:<token>" = phone, 90 days).
    // The first sign-in with a new number creates the account with the password given.
    const acct = (req.body || {}).acct;
    if (acct) {
      const b = req.body;
      if (acct === 'pages') { const ph = await sessPhone(b.sess); if (!ph) return fail(res, 401, 'sess', 'Please sign in again.'); const a = JSON.parse(await redis(['GET', `acct:${ph}`]) || '{}'); return res.status(200).json({ pages: a.pages || [] }); }
      const ph = phoneKey(b.phone); if (!ph) return fail(res, 400, 'phone', 'Enter a valid phone number.');
      const pw = String(b.password || '');
      if (acct === 'reset') { // the manager sets a new password for a business that forgot it
        if (!isAdmin(key)) return fail(res, 403, 'key', 'Wrong manager code.');
        if (pw.length < 6) return fail(res, 400, 'password', 'The password must have at least 6 characters.');
        const a = JSON.parse(await redis(['GET', `acct:${ph}`]) || 'null'); if (!a) return fail(res, 404, 'none', 'No account with this number.');
        await redis(['SET', `acct:${ph}`, JSON.stringify({ ...a, ...hashPw(pw) })]); return res.status(200).json({ ok: true });
      }
      if (acct !== 'login') return fail(res, 400, 'data', 'Invalid request.');
      // wrong passwords: at most 10 per number (and 30 per network) in 15 minutes
      const lim = async (k, max) => { const n = await redis(['INCR', k]); if (n === 1) await redis(['EXPIRE', k, 900]); return n > max; };
      const a = JSON.parse(await redis(['GET', `acct:${ph}`]) || 'null');
      let created = false;
      if (!a) {
        if (pw.length < 6) return fail(res, 400, 'password', 'Choose a password with at least 6 characters.');
        await redis(['SET', `acct:${ph}`, JSON.stringify({ ...hashPw(pw), pages: [], created: now })]); created = true;
      } else {
        if (await redis(['GET', `rl:login:${ph}`]) > 10 || await redis(['GET', `rl:loginip:${ip}`]) > 30) return fail(res, 429, 'rate', 'Too many wrong passwords. Try again in 15 minutes.');
        const h = crypto.scryptSync(pw, Buffer.from(a.salt, 'hex'), 32);
        if (!crypto.timingSafeEqual(h, Buffer.from(a.hash, 'hex'))) { await lim(`rl:login:${ph}`, 10); await lim(`rl:loginip:${ip}`, 30); return fail(res, 403, 'password', 'Wrong phone number or password.'); }
      }
      const tok = crypto.randomBytes(24).toString('base64url'); await redis(['SET', `sess:${tok}`, ph, 'EX', 90 * 86400]);
      return res.status(200).json({ sess: tok, created, pages: (a && a.pages) || [] });
    }
    // Restaurant pages, from the business link (?biz), by a signed-in business: a new page gets a random address and
    // belongs to that account; only its account (or the manager, or the phone that made it before accounts existed) can update it.
    if (!data || typeof data !== 'object' || !Array.isArray(data.items) || !data.items.length || data.items.length > 600 || typeof data.tr !== 'object') return fail(res, 400, 'data', 'Invalid menu.');
    const admin = isAdmin(key), ph = await sessPhone(req.body.sess);
    if (!admin && !ph) return fail(res, 401, 'sess', 'Please sign in again.');
    let page = slug, token = edit;
    if (page) {
      if (typeof page !== 'string' || !SLUG.test(page)) return fail(res, 400, 'slug', 'Invalid page.');
      const owner = await redis(['GET', `redit:${page}`]), acctOwner = await redis(['GET', `rowner:${page}`]);
      const byToken = owner && typeof edit === 'string' && edit.length === owner.length && crypto.timingSafeEqual(Buffer.from(edit), Buffer.from(owner));
      if (!admin && !byToken && !(ph && acctOwner === ph)) return fail(res, 403, 'key', 'This page belongs to another account.');
      if (ph && !acctOwner) await redis(['SET', `rowner:${page}`, ph]); // a page made before accounts joins the account that updates it
    } else {
      // new pages: at most 10 an hour from one network (the manager is not limited)
      if (!admin) { const n = await redis(['INCR', `rl:page:${ip}`]); if (n === 1) await redis(['EXPIRE', `rl:page:${ip}`, 3600]); if (n > 10) return fail(res, 429, 'rate', 'Too many new pages. Try again in an hour.'); }
      do page = newCode().toLowerCase().slice(0, 8); while (await redis(['EXISTS', `rdata:${page}`]));
      token = crypto.randomBytes(18).toString('base64url');
      await redis(['SET', `redit:${page}`, token]);
      if (ph) await redis(['SET', `rowner:${page}`, ph]);
    }
    const body = JSON.stringify({ ...data, slug: page, updated: now });
    if (body.length > 2e6) return fail(res, 413, 'size', 'The menu is too large.');
    await store.set(`rdata:${page}`, body);
    // the account's list of pages (with the restaurant's name), so they can be found again from any phone
    if (ph) { const a = JSON.parse(await redis(['GET', `acct:${ph}`]) || 'null'); if (a) { const pages = (a.pages || []).filter(p => p.slug !== page); pages.unshift({ slug: page, title: String(data.title || '').slice(0, 80), updated: now }); await redis(['SET', `acct:${ph}`, JSON.stringify({ ...a, pages })]); } }
    return res.status(200).json({ ok: true, slug: page, edit: token });
  } catch (e) {
    return fail(res, 500, 'failed', 'Saving the page failed. Please try again.');
  }
};

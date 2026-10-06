// Restaurant pages: a menu prepared in the app (dishes already translated into every language) is kept on the server
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
  async get(slug) {
    if (RURL && RTOK) return await redis(['GET', `rdata:${slug}`]);
    const { head } = require('@vercel/blob'); let meta; try { meta = await head(`rdata/${slug}.json`); } catch (e) { return null; }
    const r = await fetch(meta.url, { cache: 'no-store' }); return r.ok ? await r.text() : null;
  },
  async set(slug, body) {
    if (RURL && RTOK) return await redis(['SET', `rdata:${slug}`, body]);
    const { put } = require('@vercel/blob');
    await put(`rdata/${slug}.json`, body, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 });
  }
};

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      if (req.query.diag) return res.status(200).json({ adminKey: !!(process.env.ADMIN_KEY || '').trim(), redis: !!(RURL && RTOK), blob: !!process.env.BLOB_READ_WRITE_TOKEN });
      // a guest opening a page
      const slug = String(req.query.slug || '');
      if (!SLUG.test(slug)) return fail(res, 400, 'slug', 'Invalid page name.');
      if (!store.ready()) return fail(res, 404, 'none', 'Not found.');
      const body = await store.get(slug);
      if (!body) return fail(res, 404, 'none', 'Not found.');
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
      res.setHeader('X-Robots-Tag', 'noindex');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(body);
    }
    if (req.method !== 'POST') return fail(res, 405, 'method', 'Method not allowed');
    const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim(), now = Date.now();
    const bad = (tries.get(ip) || []).filter(t => now - t < 600000);
    if (bad.length >= 10) return fail(res, 429, 'rate', 'Too many attempts. Try again later.');
    const { key, slug, data, check } = req.body || {};
    if (!(process.env.ADMIN_KEY || '').trim()) return fail(res, 500, 'config', 'ADMIN_KEY is not set on the server (or the site was not redeployed after setting it).');
    if (!isAdmin(key)) { tries.set(ip, [...bad, now]); return fail(res, 403, 'key', 'Wrong manager code.'); }
    if (check) return res.status(200).json({ ok: true, storage: store.ready() });
    if (!store.ready()) return fail(res, 500, 'config', 'Page storage is not connected (connect Upstash Redis or a Blob store to the project in Vercel, then redeploy).');
    if (typeof slug !== 'string' || !SLUG.test(slug)) return fail(res, 400, 'slug', 'Use lowercase English letters, digits and dashes.');
    if (!data || typeof data !== 'object' || !Array.isArray(data.items) || !data.items.length || typeof data.tr !== 'object') return fail(res, 400, 'data', 'Invalid menu.');
    const body = JSON.stringify({ ...data, slug, updated: now });
    if (body.length > 2e6) return fail(res, 413, 'size', 'The menu is too large.');
    await store.set(slug, body);
    return res.status(200).json({ ok: true, slug });
  } catch (e) {
    return fail(res, 500, 'failed', 'Saving the page failed. Please try again.');
  }
};

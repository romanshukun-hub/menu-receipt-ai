// Restaurant pages: a menu prepared in the app (dishes already translated into every language) is kept in Vercel Blob
// storage as rdata/<name>.json, and guests open it with ?r=<name>.
// Setup (Vercel > Project > Storage): create a Blob store and connect it to this project (adds BLOB_READ_WRITE_TOKEN),
// and set ADMIN_KEY in Environment Variables - only someone with that code can create or update pages.
const { put, head } = require('@vercel/blob');
const crypto = require('crypto');

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const fail = (res, status, code, error) => res.status(status).json({ error, code });
const isAdmin = k => { const a = process.env.ADMIN_KEY || ''; if (!a || typeof k !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(k); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const tries = new Map(); // best-effort limit on wrong codes, per instance

module.exports = async (req, res) => {
  try {
    // a guest opening a page
    if (req.method === 'GET') {
      const slug = String(req.query.slug || '');
      if (!SLUG.test(slug)) return fail(res, 400, 'slug', 'Invalid page name.');
      if (!process.env.BLOB_READ_WRITE_TOKEN) return fail(res, 404, 'none', 'Not found.');
      let meta; try { meta = await head(`rdata/${slug}.json`); } catch (e) { return fail(res, 404, 'none', 'Not found.'); }
      const r = await fetch(meta.url, { cache: 'no-store' });
      if (!r.ok) return fail(res, 404, 'none', 'Not found.');
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
      res.setHeader('X-Robots-Tag', 'noindex');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(await r.text());
    }
    if (req.method !== 'POST') return fail(res, 405, 'method', 'Method not allowed');
    const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim(), now = Date.now();
    const bad = (tries.get(ip) || []).filter(t => now - t < 600000);
    if (bad.length >= 10) return fail(res, 429, 'rate', 'Too many attempts. Try again later.');
    const { key, slug, data, check } = req.body || {};
    if (!isAdmin(key)) { tries.set(ip, [...bad, now]); return fail(res, 403, 'key', 'Wrong manager code.'); }
    if (check) return res.status(200).json({ ok: true, storage: !!process.env.BLOB_READ_WRITE_TOKEN });
    if (!process.env.BLOB_READ_WRITE_TOKEN) return fail(res, 500, 'config', 'Page storage is not connected (create a Blob store in Vercel and connect it to the project).');
    if (typeof slug !== 'string' || !SLUG.test(slug)) return fail(res, 400, 'slug', 'Use lowercase English letters, digits and dashes.');
    if (!data || typeof data !== 'object' || !Array.isArray(data.items) || !data.items.length || typeof data.tr !== 'object') return fail(res, 400, 'data', 'Invalid menu.');
    const body = JSON.stringify({ ...data, slug, updated: now });
    if (body.length > 2e6) return fail(res, 413, 'size', 'The menu is too large.');
    await put(`rdata/${slug}.json`, body, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 });
    return res.status(200).json({ ok: true, slug });
  } catch (e) {
    return fail(res, 500, 'failed', 'Saving the page failed. Please try again.');
  }
};

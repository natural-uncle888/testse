// /.netlify/functions/list-posts.js
import { v2 as cloudinary } from 'cloudinary';

// Cloudinary 管理端認證（需在 Netlify 設定環境變數）
cloudinary.config({
  cloud_name: process.env.CLD_CLOUD_NAME,
  api_key: process.env.CLD_API_KEY,
  api_secret: process.env.CLD_API_SECRET,
});

// ---- CORS & utils ----
const CORS_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
};

function sendJSON(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}
function preflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
function errorJSON(err, status = 500) {
  const msg =
    (err && (err.message || err.error?.message)) ||
    String(err) ||
    'Unknown error';
  try { console.error('[list-posts] error:', err); } catch {}
  return new Response(JSON.stringify({ error: msg }), { status, headers: CORS_HEADERS });
}

// ----（無外部套件的）HS256 JWT 驗證：用 ADMIN_JWT_SECRET ----
import crypto from 'crypto';
function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function b64urlJson(str) {
  const pad = str.length % 4 === 2 ? '==' : str.length % 4 === 3 ? '=' : '';
  const s = str.replace(/-/g,'+').replace(/_/g,'/') + pad;
  return JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
}
function verifyJWT(token, secret) {
  try {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    const header = b64urlJson(h);
    if (header.alg !== 'HS256') return null;
    const expected = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64')
                      .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    if (expected !== s) return null;
    const payload = b64urlJson(p);
    if (payload.exp && Date.now() >= payload.exp * 1000) return null;
    return payload;
  } catch { return null; }
}
function requireAdmin(request) {
  const auth = request.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const secret = process.env.ADMIN_JWT_SECRET || '';
  if (!secret) return null;
  const payload = verifyJWT(m[1], secret);
  return payload && payload.role === 'admin' ? payload : null;
}

// ---- Main handler ----
export default async (request) => {
  // CORS
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'GET') return sendJSON({ error: 'Method not allowed' }, 405);

  try {
    const url = new URL(request.url);
    const showHidden = url.searchParams.get('showHidden') === '1';

    // 需要看「包含隱藏」清單 → 必須為管理員
    if (showHidden && !requireAdmin(request)) {
      return sendJSON({ error: 'Unauthorized' }, 401);
    }

    const cloud = process.env.CLD_CLOUD_NAME;
    const items = [];
    let nextCursor;

    // 抓出所有 raw 類型、public_id 為 collages/<slug>/data 的 JSON
    do {
      const res = await cloudinary.search
        .expression('resource_type:raw AND public_id:collages/*/data')
        .max_results(100)
        .next_cursor(nextCursor)
        .execute();

      for (const r of res.resources || []) {
        const m = /^collages\/([^/]+)\/data$/.exec(r.public_id || '');
        if (!m) continue;
        const slug = m[1];

        // 讀回 data.json
        const dataUrl = `https://res.cloudinary.com/${cloud}/raw/upload/collages/${slug}/data.json`;
        const resp = await fetch(dataUrl);
        if (!resp.ok) continue;

        const data = await resp.json().catch(() => null);
        if (!data) continue;

        // 舊資料若無 visible 欄位 → 視為 true
        const isVisible = data.visible !== false;
        if (!showHidden && !isVisible) continue;

        items.push({
          slug,
          title: data.title || '',
          date: data.date || data.created_at || '',
          tags: data.tags || [],
          items: data.items || [],
          created_at: data.created_at || '',
          visible: isVisible,
          preview:
            data.preview ||
            (Array.isArray(data.items) && data.items[0] ? data.items[0].url : null),
        });
      }

      nextCursor = res.next_cursor || undefined;
    } while (nextCursor);

    // 新到舊
    items.sort(
      (a, b) =>
        new Date(b.date || b.created_at || 0) - new Date(a.date || a.created_at || 0)
    );

    return sendJSON({ items });
  } catch (e) {
    return errorJSON(e, 500);
  }
};

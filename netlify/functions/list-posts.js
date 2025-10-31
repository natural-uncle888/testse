// /.netlify/functions/list-posts.js
import { v2 as cloudinary } from 'cloudinary';
import crypto from 'crypto';

cloudinary.config({
  cloud_name: process.env.CLD_CLOUD_NAME,
  api_key: process.env.CLD_API_KEY,
  api_secret: process.env.CLD_API_SECRET,
});

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
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: CORS_HEADERS,
  });
}

// ===== JWT 驗證 (和 create-post.js 同邏輯，用 ADMIN_JWT_SECRET 做 HS256) =====
function base64urlDecodeToJson(str) {
  const pad = str.length % 4 === 2 ? '==' : str.length % 4 === 3 ? '=' : '';
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
}

function verifyJWT(token, secret) {
  try {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;

    const header = base64urlDecodeToJson(h);
    if (header.alg !== 'HS256') return null;

    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${h}.${p}`)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    if (expected !== s) return null;

    const payload = base64urlDecodeToJson(p);

    // 過期時間 (exp 是秒)
    if (payload.exp && Date.now() >= payload.exp * 1000) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function requireAdmin(request) {
  const auth = request.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;

  const secret = process.env.ADMIN_JWT_SECRET || '';
  if (!secret) return null;

  const payload = verifyJWT(m[1], secret);
  if (!payload) return null;
  if (payload.role !== 'admin') return null;

  return payload;
}

// ===== Handler =====
export default async (request) => {
  // CORS
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'GET') {
    return sendJSON({ error: 'Method not allowed' }, 405);
  }

  try {
    const url = new URL(request.url);
    const showHidden = url.searchParams.get('showHidden') === '1';

    // 如果要顯示隱藏作品，必須是管理員
    if (showHidden && !requireAdmin(request)) {
      return sendJSON({ error: 'Unauthorized' }, 401);
    }

    const cloud = process.env.CLD_CLOUD_NAME;
    const items = [];
    let nextCursor;

    // 🔥 關鍵修正點：
    // 用 public_id:collages/*/data 來抓所有子資料夾底下的 data.json (resource_type=raw)
    do {
      const res = await cloudinary.search
        .expression('resource_type:raw AND public_id:collages/*/data')
        .max_results(100)
        .next_cursor(nextCursor)
        .execute();

      for (const r of res.resources || []) {
        // r.public_id 會像 "collages/case-907375/data"
        const m = /^collages\/([^/]+)\/data$/.exec(r.public_id || '');
        if (!m) continue;
        const slug = m[1];

        // 撈回實際的 data.json 內容
        const dataUrl = `https://res.cloudinary.com/${cloud}/raw/upload/collages/${encodeURIComponent(
          slug
        )}/data.json`;

        const resp = await fetch(dataUrl);
        if (!resp.ok) continue;

        const data = await resp.json().catch(() => null);
        if (!data) continue;

        // 舊資料可能沒 visible，當成 true
        const isVisible = data.visible !== false;

        // 如果不是 showHidden 模式，而且作品是隱藏的，就跳過
        if (!showHidden && !isVisible) {
          continue;
        }

        // 準備回前端顯示的內容
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
            (Array.isArray(data.items) && data.items[0]
              ? data.items[0].url
              : null),
        });
      }

      nextCursor = res.next_cursor || undefined;
    } while (nextCursor);

    // 最新在前
    items.sort(
      (a, b) =>
        new Date(b.date || b.created_at || 0) -
        new Date(a.date || a.created_at || 0)
    );

    return sendJSON({ items });
  } catch (e) {
    return errorJSON(e, 500);
  }
};

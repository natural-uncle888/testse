// /.netlify/functions/list-posts.js
import { v2 as cloudinary } from 'cloudinary';
import crypto from 'crypto';

// --- Cloudinary 設定（用 Netlify 環境變數）---
cloudinary.config({
  cloud_name: process.env.CLD_CLOUD_NAME,
  api_key: process.env.CLD_API_KEY,
  api_secret: process.env.CLD_API_SECRET,
});

// --- CORS ---
const CORS_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
};

function sendJSON(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS,
  });
}

function preflight() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

function errorJSON(err, status = 500) {
  const msg =
    (err && (err.message || err.error?.message)) ||
    String(err) ||
    'Unknown error';
  try {
    console.error('[list-posts] error:', err);
  } catch {}
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: CORS_HEADERS,
  });
}

// --- JWT 驗證：跟 create-post.js 同一套 HS256，用 ADMIN_JWT_SECRET ---
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

    // 檢查過期 (exp 單位是秒)
    if (payload.exp && Date.now() >= payload.exp * 1000) return null;

    return payload;
  } catch {
    return null;
  }
}

function requireAdmin(request) {
  const authHeader = request.headers.get('authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;

  const secret = process.env.ADMIN_JWT_SECRET || '';
  if (!secret) return null;

  const payload = verifyJWT(m[1], secret);
  if (!payload) return null;
  if (payload.role !== 'admin') return null;

  return payload;
}

// --- 主 handler ---
export default async (request) => {
  // CORS 預檢
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'GET') {
    return sendJSON({ error: 'Method not allowed' }, 405);
  }

  try {
    const url = new URL(request.url);
    const showHidden = url.searchParams.get('showHidden') === '1';

    // 如果要看隱藏作品，就必須是管理員
    if (showHidden && !requireAdmin(request)) {
      return sendJSON({ error: 'Unauthorized' }, 401);
    }

    const cloud = process.env.CLD_CLOUD_NAME;

    // 我們要做的事：
    // 1. 列出所有 resource_type=raw 的檔案，prefix='collages/'
    // 2. 把 public_id 長得像 "collages/<slug>/data" 的挑出來
    // 3. 對每個 slug 去抓 data.json 真正內容
    const items = [];
    let nextCursor;

    do {
      // 這是 Cloudinary Admin API
      // 這裡不用 search expression，而是用 prefix='collages/'
      const res = await cloudinary.api.resources({
        resource_type: 'raw',
        type: 'upload',
        prefix: 'collages/',
        max_results: 100,
        next_cursor: nextCursor,
      });

      for (const r of res.resources || []) {
        // 例：r.public_id = "collages/case-907375/data"
        const match = /^collages\/([^/]+)\/data$/.exec(r.public_id || '');
        if (!match) continue;

        const slug = match[1];

        // 讀回對應的 data.json
        const dataUrl = `https://res.cloudinary.com/${cloud}/raw/upload/collages/${encodeURIComponent(
          slug
        )}/data.json`;

        const resp = await fetch(dataUrl);
        if (!resp.ok) continue;

        const data = await resp.json().catch(() => null);
        if (!data) continue;

        // 舊資料可能沒有 visible 欄位，預設為 true
        const isVisible = data.visible !== false;

        // 如果不是 showHidden，且這筆是隱藏的，就跳過
        if (!showHidden && !isVisible) continue;

        items.push({
          slug,
          title: data.title || data.titile || '', // 兼容你那筆 typo "titile"
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

    // 依時間新到舊排序
    items.sort(
      (a, b) =>
        new Date(b.date || b.created_at || 0) -
        new Date(a.date || a.created_at || 0)
    );

    return sendJSON({ items }, 200);
  } catch (err) {
    return errorJSON(err, 500);
  }
};

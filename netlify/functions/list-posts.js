// /.netlify/functions/list-posts.js
import { v2 as cloudinary } from 'cloudinary';
import jwt from 'jsonwebtoken';

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
  const message =
    (err && (err.message || err.error?.message)) ||
    String(err) ||
    'Unknown error';
  try {
    console.error('[list-posts] error:', err);
  } catch (_) {}
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: CORS_HEADERS,
  });
}

// 驗證 JWT（同 create-post.js）
function requireAdmin(request) {
  const authHeader = request.headers.get('authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const decoded = jwt.verify(m[1], process.env.ADMIN_JWT_SECRET);
    if (decoded && decoded.role === 'admin') return decoded;
  } catch (_) {}
  return null;
}

export default async (request) => {
  // CORS 預檢
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'GET') {
    return sendJSON({ error: 'Method not allowed' }, 405);
  }

  try {
    const url = new URL(request.url);
    const showHidden = url.searchParams.get('showHidden') === '1';

    let isAdmin = null;
    if (showHidden) {
      isAdmin = requireAdmin(request);
      if (!isAdmin) {
        return sendJSON({ error: 'Unauthorized' }, 401);
      }
    }

    const cloud = process.env.CLD_CLOUD_NAME;
    const items = [];
    let nextCursor;

    // 掃 Cloudinary 裡所有 collages/<slug>/data.json (resource_type: raw)
    do {
      const res = await cloudinary.search
        .expression(
          'resource_type:raw AND folder:collages AND filename:data'
        )
        .max_results(100)
        .next_cursor(nextCursor)
        .execute();

      for (const r of res.resources || []) {
        // public_id 例子： "collages/some-slug/data"
        const m = /^collages\/([^/]+)\/data$/.exec(r.public_id || '');
        if (!m) continue;
        const slug = m[1];

        // 把 data.json 抓回來
        const dataUrl = `https://res.cloudinary.com/${cloud}/raw/upload/collages/${slug}/data.json`;
        const resp = await fetch(dataUrl);
        if (!resp.ok) continue;
        const data = await resp.json().catch(() => null);
        if (!data) continue;

        // 舊資料可能沒有 visible，預設當作 true
        const isVisible = data.visible !== false;

        // 如果不是 showHidden 且該作品是隱藏的，就略過
        if (!showHidden && !isVisible) {
          continue;
        }

        // 準備卡片需要的基本資訊
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

    // 新到舊排序
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

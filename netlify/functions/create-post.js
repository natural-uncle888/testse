// /.netlify/functions/create-post.js
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
  'access-control-allow-methods': 'POST,OPTIONS',
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

// 解析並驗證 Bearer token -> 回傳 payload 或 null
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
  if (request.method !== 'POST') {
    return sendJSON({ error: 'Method not allowed' }, 405);
  }

  // 檢查管理員登入
  const admin = requireAdmin(request);
  if (!admin) {
    return sendJSON({ error: 'Unauthorized' }, 401);
  }

  try {
    // 讀 body
    let body = null;
    try {
      body = await request.json();
    } catch {
      return sendJSON({ error: 'Invalid JSON body' }, 400);
    }

    const { title, date, tags, slug, items } = body || {};

    if (!slug || !slug.trim()) {
      return sendJSON({ error: 'slug required' }, 400);
    }
    if (!Array.isArray(items) || items.length === 0) {
      return sendJSON({ error: 'items required' }, 400);
    }

    // 封面圖（第一張圖）
    const previewUrl = items[0]?.url || null;

    // ✅ 新格式：帶 visible: true
    const record = {
      slug,
      title,
      date,
      tags,
      items, // [{url, caption}, ...]
      created_at: new Date().toISOString(),
      preview: previewUrl,
      visible: true,
    };

    // 上傳 JSON 到 Cloudinary (raw)
    const jsonBase64 = Buffer.from(JSON.stringify(record)).toString('base64');

    await cloudinary.uploader.upload(
      `data:application/json;base64,${jsonBase64}`,
      {
        resource_type: 'raw',
        public_id: `collages/${slug}/data`,
        overwrite: true,
        format: 'json',
      }
    );

    return sendJSON({ ok: true, slug });
  } catch (err) {
    return sendJSON(
      {
        error:
          (err && (err.message || err.error?.message)) ||
          String(err) ||
          'Unknown error',
      },
      500
    );
  }
};

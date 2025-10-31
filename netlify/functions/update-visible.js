// /.netlify/functions/update-visible.js
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

// 驗證管理員 JWT
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

  // 檢查權限
  const admin = requireAdmin(request);
  if (!admin) {
    return sendJSON({ error: 'Unauthorized' }, 401);
  }

  // parse body
  let body = null;
  try {
    body = await request.json();
  } catch (_) {
    return sendJSON({ error: 'Invalid JSON body' }, 400);
  }

  const slug = body?.slug?.trim();
  // 注意：visible 可能是 boolean false，所以不能用簡單的 truthy 判斷
  const newVisibleRaw = body?.visible;
  const newVisible = newVisibleRaw === false ? false : true;
  // 如果 body.visible 是 false -> newVisible = false
  // 其他情況(包括 true / undefined) 我們一律當 true

  if (!slug) {
    return sendJSON({ error: 'slug required' }, 400);
  }

  // 1. 把舊的 data.json 抓回來
  const cloud = process.env.CLD_CLOUD_NAME;
  const dataUrl = `https://res.cloudinary.com/${cloud}/raw/upload/collages/${slug}/data.json`;
  const resp = await fetch(dataUrl);
  if (!resp.ok) {
    return sendJSON({ error: 'data.json not found for slug ' + slug }, 404);
  }

  let data;
  try {
    data = await resp.json();
  } catch (_) {
    return sendJSON({ error: 'Invalid data.json format' }, 500);
  }

  // 2. 改 visible
  data.visible = newVisible;

  // 3. 上傳回 Cloudinary 覆蓋
  const jsonBase64 = Buffer.from(JSON.stringify(data)).toString('base64');
  await cloudinary.uploader.upload(
    `data:application/json;base64,${jsonBase64}`,
    {
      resource_type: 'raw',
      public_id: `collages/${slug}/data`,
      overwrite: true,
      format: 'json',
    }
  );

  return sendJSON({ ok: true, slug, visible: newVisible });
};

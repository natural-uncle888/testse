import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLD_CLOUD_NAME,
  api_key: process.env.CLD_API_KEY,
  api_secret: process.env.CLD_API_SECRET,
});

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' } });
}

function errorJSON(err, status = 500) {
  const message = (err && (err.message || err.error?.message)) || undefined;
  const payload = { error: message || err || 'Unknown error' };
  try { console.error('[list-posts] error:', err); } catch {}
  return json(payload, status);
}

export default async (_request) => {
  try {
    if (!process.env.CLD_CLOUD_NAME || !process.env.CLD_API_KEY || !process.env.CLD_API_SECRET) {
      return errorJSON('Missing Cloudinary env vars (CLD_CLOUD_NAME / CLD_API_KEY / CLD_API_SECRET)', 500);
    }

    const items = [];
    let nextCursor = undefined;

    // 使用 Admin API 列出 raw 資源（避免 Search API 權限或索引問題）
    // 逐頁抓取 collages/ 前綴
    do {
      const res = await cloudinary.api.resources({
        resource_type: 'raw',
        type: 'upload',
        prefix: 'collages/',
        max_results: 100,
        next_cursor: nextCursor,
      });

      const resources = res.resources || [];
      for (const r of resources) {
        const pid = r.public_id || '';
        // 接受 collages/{slug}/data 或 collages/{slug}/data.json
        const m = pid.match(/^collages\/([^/]+)\/data(?:\.json)?$/i);
        if (!m) continue;
        const slug = m[1];

        // 依 public_id 是否已含 .json 來決定取檔 URL
        const hasExt = /\.json$/i.test(pid);
        const cloud = process.env.CLD_CLOUD_NAME;
        const url = `https://res.cloudinary.com/${cloud}/raw/upload/${encodeURIComponent(pid + (hasExt ? '' : '.json'))}`;

        const resp = await fetch(url);
        if (!resp.ok) continue;
        const data = await resp.json().catch(() => null);
        if (!data) continue;

        items.push({
          slug,
          title: data.title || slug,
          date: data.date || data.created_at,
          created_at: data.created_at,
          tags: data.tags || [],
          cover: data.cover || (Array.isArray(data.items) && data.items[0]?.url) || null,
          preview: data.preview || null,
        });
      }

      nextCursor = res.next_cursor || undefined;
    } while (nextCursor);

    items.sort((a,b)=> new Date(b.date || b.created_at || 0) - new Date(a.date || a.created_at || 0));

    return json({ items });
  } catch (e) {
    return errorJSON(e, 500);
  }
}

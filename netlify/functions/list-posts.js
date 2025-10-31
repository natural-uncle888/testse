import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLD_CLOUD_NAME,
  api_key: process.env.CLD_API_KEY,
  api_secret: process.env.CLD_API_SECRET,
});

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization'
    }
  });
}

function errorJSON(err, status = 500) {
  const message = (err && (err.message || err.error?.message)) || undefined;
  const payload = { error: message || err || 'Unknown error' };
  try { console.error('[list-posts] error:', err); } catch {}
  return json(payload, status);
}

export default async (request) => {
  try {
    // 確認 Cloudinary 環境變數
    if (!process.env.CLD_CLOUD_NAME || !process.env.CLD_API_KEY || !process.env.CLD_API_SECRET) {
      return errorJSON('Missing Cloudinary env vars (CLD_CLOUD_NAME / CLD_API_KEY / CLD_API_SECRET)', 500);
    }

    const items = [];
    let nextCursor = undefined;

    // 逐頁列出 collages/ 底下全部 raw 檔
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
        // 只吃 collages/{slug}/data 或 collages/{slug}/data.json
        const m = /^collages\/([^/]+)\/data(?:\.json)?$/i.exec(pid);
        if (!m) continue;
        const slug = m[1];

        // 把這個 slug 的 data.json 抓回來
        const hasExt = /\.json$/i.test(pid);
        const cloud = process.env.CLD_CLOUD_NAME;
        const url = `https://res.cloudinary.com/${cloud}/raw/upload/${encodeURIComponent(pid + (hasExt ? '' : '.json'))}`;

        const resp = await fetch(url);
        if (!resp.ok) continue;
        const data = await resp.json().catch(() => null);
        if (!data) continue;

        // 取得封面圖：盡可能給前端一個 thumb
        const derivedPreview =
          data.preview ||          // 新格式
          data.cover ||            // 舊格式常用 cover
          (Array.isArray(data.items) && data.items[0]?.url) || // 有 items[] 的話
          null;

        items.push({
          slug,
          title: data.title || data.titile || slug, // 兼容舊資料打錯 key 'titile'
          date: data.date || data.created_at,
          created_at: data.created_at,
          tags: data.tags || [],
          items: Array.isArray(data.items) ? data.items : [],
          visible: data.visible !== false, // 沒寫就當作 true
          preview: derivedPreview,         // 前端會用這個畫縮圖
        });
      }

      nextCursor = res.next_cursor || undefined;
    } while (nextCursor);

    // 依日期排序（新到舊）
    items.sort(
      (a,b) =>
        new Date(b.date || b.created_at || 0) -
        new Date(a.date || a.created_at || 0)
    );

    return json({ items });
  } catch (e) {
    return errorJSON(e, 500);
  }
}

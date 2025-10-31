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
    if (!process.env.CLD_CLOUD_NAME || !process.env.CLD_API_KEY || !process.env.CLD_API_SECRET) {
      return errorJSON('Missing Cloudinary env vars', 500);
    }

    // 第一步：列出 collages/ 底下所有 raw 檔案（分頁抓完）
    const rawResources = [];
    let nextCursor;

    do {
      const res = await cloudinary.api.resources({
        resource_type: 'raw',
        type: 'upload',
        prefix: 'collages/',
        max_results: 100,
        next_cursor: nextCursor,
      });

      rawResources.push(...(res.resources || []));
      nextCursor = res.next_cursor || undefined;
    } while (nextCursor);

    // 第二步：從 rawResources 抽出「確實是作品的 data 檔」 -> 得到 slug 清單
    // 會長成 [{ slug, publicIdFull }, ...]
    const targets = [];
    for (const r of rawResources) {
      const pid = r.public_id || '';
      const m = /^collages\/([^/]+)\/data(?:\.json)?$/i.exec(pid);
      if (!m) continue;
      const slug = m[1];
      const hasExt = /\.json$/i.test(pid);
      const cloud = process.env.CLD_CLOUD_NAME;

      const dataUrl = `https://res.cloudinary.com/${cloud}/raw/upload/${encodeURIComponent(
        pid + (hasExt ? '' : '.json')
      )}`;

      targets.push({ slug, dataUrl });
    }

    // 第三步：平行發請求去抓所有 data.json
    const results = await Promise.all(
      targets.map(async ({ slug, dataUrl }) => {
        try {
          const resp = await fetch(dataUrl);
          if (!resp.ok) return null;
          const data = await resp.json().catch(() => null);
          if (!data) return null;

          // 統一出 front-end 需要的欄位
          const previewUrl =
            data.preview ||
            data.cover ||
            (Array.isArray(data.items) && data.items[0]?.url) ||
            null;

          return {
            slug,
            title: data.title || data.titile || slug,
            date: data.date || data.created_at,
            created_at: data.created_at,
            tags: data.tags || [],
            items: Array.isArray(data.items) ? data.items : [],
            visible: data.visible !== false,
            preview: previewUrl,
          };
        } catch (_err) {
          return null;
        }
      })
    );

    // 第四步：把 null 過濾掉並排序
    const items = results
      .filter(Boolean)
      .sort(
        (a, b) =>
          new Date(b.date || b.created_at || 0) -
          new Date(a.date || a.created_at || 0)
      );

    return json({ items });
  } catch (e) {
    return errorJSON(e, 500);
  }
}

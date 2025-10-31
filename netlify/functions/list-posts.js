// /.netlify/functions/list-posts.js
import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLD_CLOUD_NAME,
  api_key: process.env.CLD_API_KEY,
  api_secret: process.env.CLD_API_SECRET,
});

// 小工具：回傳 JSON + CORS
function sendJSON(data, status = 200) {
  return new Response(JSON.stringify(data), {
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
  const msg =
    (err && (err.message || err.error?.message)) ||
    String(err) ||
    'Unknown error';
  try { console.error('[list-posts] error:', err); } catch {}
  return sendJSON({ error: msg }, status);
}

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization'
      }
    });
  }
  if (request.method !== 'GET') {
    return sendJSON({ error: 'Method not allowed' }, 405);
  }

  try {
    const cloud = process.env.CLD_CLOUD_NAME;
    if (!cloud || !process.env.CLD_API_KEY || !process.env.CLD_API_SECRET) {
      return errorJSON('Missing Cloudinary env vars', 500);
    }

    // 1. 把 collages/ 底下所有 raw 檔列出來（分頁撈完）
    const rawResources = [];
    let nextCursor = undefined;

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

    // 2. 整理出每個 slug 最「代表」的 data 檔
    //
    // 有些舊資料可能同一個 slug 有 data.json / data 兩份，我們要選一份最合理的：
    //   - 同一個 slug 只選 1 筆
    //   - 優先選 public_id 沒帶 .json 的版本 (collages/slug/data)
    //   - 如果同時有多個版本，就選 version 最大的（最新）
    //
    // 結果放在 map: slug -> { slug, public_id, version }
    const bySlug = new Map();

    for (const r of rawResources) {
      const pid = r.public_id || '';        // e.g. "collages/case-927128/data"
      const ver = r.version;                // Cloudinary version (number)
      const m = /^collages\/([^/]+)\/data(?:\.json)?$/i.exec(pid);
      if (!m) continue;
      const slug = m[1];

      const current = bySlug.get(slug);
      if (!current) {
        bySlug.set(slug, { slug, public_id: pid, version: ver });
      } else {
        // 如果已經有一筆，挑更新的
        const currentHasJson = /\.json$/i.test(current.public_id);
        const incomingHasJson = /\.json$/i.test(pid);

        // 規則：
        // 1. 如果現在的是 .json、但新的不是 .json，優先新的（我們偏好 canonical: collages/slug/data）
        // 2. 否則就挑 version 較大的
        let replace = false;
        if (currentHasJson && !incomingHasJson) {
          replace = true;
        } else if (ver > current.version) {
          replace = true;
        }

        if (replace) {
          bySlug.set(slug, { slug, public_id: pid, version: ver });
        }
      }
    }

    // 3. 平行抓每個 slug 的 data.json
    const targets = Array.from(bySlug.values()); // [{slug, public_id, version}, ...]

    const results = await Promise.all(
      targets.map(async ({ slug, public_id, version }) => {
        try {
          // Cloudinary raw URL 可以加 version: /raw/upload/v<version>/<public_id>[.json]
          const hasExt = /\.json$/i.test(public_id);
          const url = `https://res.cloudinary.com/${cloud}/raw/upload/v${version}/${encodeURIComponent(
            public_id + (hasExt ? '' : '.json')
          )}`;

          const resp = await fetch(url);
          if (!resp.ok) return null;

          const data = await resp.json().catch(() => null);
          if (!data) return null;

          // 決定縮圖：先用 data.preview，其次 data.cover，其次 items[0].url
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
            visible: data.visible !== false, // 沒寫就當 true
            preview: previewUrl,
          };
        } catch (_) {
          return null;
        }
      })
    );

    // 4. 過濾掉抓失敗的，並依日期新到舊排序
    const items = results
      .filter(Boolean)
      .sort(
        (a, b) =>
          new Date(b.date || b.created_at || 0) -
          new Date(a.date || a.created_at || 0)
      );

    // 回傳給前端
    return sendJSON({ items });
  } catch (e) {
    return errorJSON(e, 500);
  }
};

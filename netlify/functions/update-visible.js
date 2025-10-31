import { v2 as cloudinary } from 'cloudinary';
import crypto from 'crypto';

// Cloudinary config
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

// ----- 簡單版 JWT 驗證，跟 list-posts 同一套 -----
function b64json(str) {
  const pad = str.length % 4 === 2 ? '==' : str.length % 4 === 3 ? '=' : '';
  const s = str.replace(/-/g,'+').replace(/_/g,'/') + pad;
  return JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
}
function verifyJWT(token, secret) {
  try {
    const [h,p,s] = token.split('.');
    if(!h||!p||!s) return null;
    const header = b64json(h);
    if(header.alg!=='HS256') return null;
    const expected = crypto.createHmac('sha256',secret)
      .update(`${h}.${p}`)
      .digest('base64')
      .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    if(expected!==s) return null;
    const payload = b64json(p);
    if(payload.exp && Date.now()>=payload.exp*1000) return null;
    return payload;
  } catch {
    return null;
  }
}
function requireAdmin(request){
  const ah = request.headers.get('authorization')||'';
  const m = ah.match(/^Bearer\s+(.+)$/i);
  if(!m) return null;
  const secret = process.env.ADMIN_JWT_SECRET||'';
  if(!secret) return null;
  const payload = verifyJWT(m[1], secret);
  if(!payload) return null;
  if(payload.role!=='admin') return null;
  return payload;
}

export default async (request) => {
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'POST') {
    return sendJSON({ error:'Method not allowed' },405);
  }

  // 權限
  const admin = requireAdmin(request);
  if (!admin) {
    return sendJSON({ error:'Unauthorized' },401);
  }

  // 解析 body
  let body;
  try {
    body = await request.json();
  } catch {
    return sendJSON({ error:'Invalid JSON body' },400);
  }

  const slug = body?.slug?.trim();
  const newVisible = body?.visible === false ? false : true;
  if(!slug){
    return sendJSON({ error:'slug required' },400);
  }

  try {
    const cloud = process.env.CLD_CLOUD_NAME;

    // 1. 找出對應 slug 的 data 檔 public_id
    //    例如 collages/slug/data 或 collages/slug/data.json
    const res = await cloudinary.api.resources({
      resource_type:'raw',
      type:'upload',
      prefix:`collages/${slug}/`,
      max_results:10,
    });

    let targetPid = null;
    for(const r of res.resources || []){
      const pid = r.public_id || '';
      if (/^collages\/[^/]+\/data(?:\.json)?$/i.test(pid)){
        targetPid = pid;
        break;
      }
    }
    if(!targetPid){
      return sendJSON({ error:'data.json not found for slug '+slug },404);
    }

    // 2. 下載現有 data.json
    const hasExt = /\.json$/i.test(targetPid);
    const dataUrl = `https://res.cloudinary.com/${cloud}/raw/upload/${encodeURIComponent(
      targetPid + (hasExt ? '' : '.json')
    )}`;

    const resp = await fetch(dataUrl);
    if(!resp.ok){
      return sendJSON({ error:'cannot fetch current data.json' },500);
    }

    const data = await resp.json().catch(()=>null);
    if(!data){
      return sendJSON({ error:'bad data.json format' },500);
    }

    // 3. 修改 visible
    data.visible = newVisible;

    // 4. 重新上傳覆蓋同一個 public_id
    const jsonBase64 = Buffer.from(JSON.stringify(data)).toString('base64');

    await cloudinary.uploader.upload(
      `data:application/json;base64,${jsonBase64}`,
      {
        resource_type:'raw',
        public_id: targetPid.replace(/\.json$/i,''),
        overwrite:true,
        format:'json',
      }
    );

    return sendJSON({ ok:true, slug, visible:newVisible });
  } catch (err){
    return sendJSON({
      error:(err && (err.message || err.error?.message)) || String(err) || 'Unknown error'
    },500);
  }
};

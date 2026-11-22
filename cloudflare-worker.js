/**
 * 지수 관측소 v5.0 — Cloudflare Workers 실시간 중계 서버
 *
 * [Cloudflare 대시보드 설정 방법]
 * 1. Workers & Pages -> Create Worker -> 이 파일 전체 붙여넣기 -> Deploy
 * 2. Worker Settings -> Variables and Secrets -> Add (Type: Secret)
 *    - KIS_APP_KEY    : 한국투자증권 실전투자 App Key
 *    - KIS_APP_SECRET : 한국투자증권 실전투자 App Secret
 *    - (선택) KIS_FUTURES_CODE : 특정 코스피200 선물 단축코드 수동 지정 시
 */

const KIS_BASE = 'https://openapi.koreainvestment.com:9443';
const ALLOWED_ORIGINS = [
  'https://yanggun1219.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : 'https://yanggun1219.github.io';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8'
  };
}

function getKstNow() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(kst.getUTCDate()).padStart(2, '0');
  const hh = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  const ss = String(kst.getUTCSeconds()).padStart(2, '0');
  return { date: `${yyyy}-${mm}-${dd}`, stamp: `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} KST`, year: yyyy, month: Number(mm), day: Number(dd) };
}

async function getKisToken(env) {
  const cache = caches.default;
  const cacheKey = new Request('https://kis-token-cache.internal/v1/token');
  const cached = await cache.match(cacheKey);
  if (cached) {
    const data = await cached.json();
    if (data && data.access_token) return data.access_token;
  }

  const res = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: env.KIS_APP_KEY,
      appsecret: env.KIS_APP_SECRET
    })
  });
  if (!res.ok) throw new Error(`KIS token HTTP ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('KIS access_token missing');

  // 20시간 캐싱 (1분당 1회 발급 제한 보호)
  await cache.put(
    cacheKey,
    new Response(JSON.stringify({ access_token: data.access_token }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=72000' }
    })
  );
  return data.access_token;
}

function buildFuturesCandidates(env, kst) {
  const cands = [];
  if (env.KIS_FUTURES_CODE) cands.push(String(env.KIS_FUTURES_CODE).trim());
  const qMonths = [3, 6, 9, 12];
  const nextQs = [];
  for (const qm of qMonths) {
    if (qm > kst.month || (qm === kst.month && kst.day <= 14)) nextQs.push([kst.year, qm]);
  }
  nextQs.push([kst.year + 1, 3]);
  const monthHex = { 3: '3', 6: '6', 9: '9', 12: 'C' };
  const yearOld = { 2025: 'W', 2026: 'X', 2027: 'Y', 2028: 'Z' };
  for (const [qy, qm] of nextQs.slice(0, 2)) {
    const y1 = String(qy).slice(-1);
    const mm = String(qm).padStart(2, '0');
    cands.push(`A01${y1}${monthHex[qm]}`, `A01${y1}${mm}`);
    if (yearOld[qy]) cands.push(`101${yearOld[qy]}${mm}`);
  }
  return [...new Set(cands)];
}

async function fetchKisIndex(token, env, code) {
  const url = `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-index-price?FID_COND_MRKT_DIV_CODE=U&FID_INPUT_ISCD=${code}`;
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      authorization: `Bearer ${token}`,
      appkey: env.KIS_APP_KEY,
      appsecret: env.KIS_APP_SECRET,
      tr_id: 'FHPUP02100000',
      custtype: 'P'
    }
  });
  if (!res.ok) return null;
  const json = await res.json();
  if (json.rt_cd !== '0' || !json.output) return null;
  const price = Number(json.output.bstp_nmix_prpr);
  const pct = Number(json.output.bstp_nmix_prdy_ctrt);
  if (!Number.isFinite(price) || price <= 0) return null;
  return { close: Number(price.toFixed(2)), pct: Number.isFinite(pct) ? Number(pct.toFixed(2)) : 0 };
}

async function fetchKisFutures(token, env, kst) {
  const cands = buildFuturesCandidates(env, kst);
  for (const code of cands) {
    const url = `${KIS_BASE}/uapi/domestic-futureoption/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=F&FID_INPUT_ISCD=${code}`;
    try {
      const res = await fetch(url, {
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          authorization: `Bearer ${token}`,
          appkey: env.KIS_APP_KEY,
          appsecret: env.KIS_APP_SECRET,
          tr_id: 'FHMIF10000000',
          custtype: 'P'
        }
      });
      if (!res.ok) continue;
      const json = await res.json();
      if (json.rt_cd !== '0' || !json.output1) continue;
      const out1 = json.output1;
      const price = Number(out1.futs_prpr || out1.stck_prpr);
      if (!Number.isFinite(price) || price <= 0) continue;
      const pct = Number(out1.futs_prdy_ctrt || 0);
      const basisRaw = out1.mrkt_basis ?? out1.basis ?? (json.output3 && json.output3.mrkt_basis);
      const basis = basisRaw !== undefined && basisRaw !== '' && Number.isFinite(Number(basisRaw))
        ? Number(Number(basisRaw).toFixed(2))
        : null;
      return {
        K200: Number(price.toFixed(2)),
        K200_pct: Number(pct.toFixed(2)),
        K200_basis: basis,
        K200_code: code,
        K200_name: (out1.hts_kor_isnm || `코스피200 선물 (${code})`).trim()
      };
    } catch (_) {
      continue;
    }
  }
  return null;
}

async function fetchYahooQuote(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta || !Number.isFinite(meta.regularMarketPrice)) return null;
    const price = Number(meta.regularMarketPrice);
    const prev = Number(meta.chartPreviousClose || meta.previousClose || price);
    const pct = prev > 0 ? ((price / prev) - 1) * 100 : 0;
    return { price: Number(price.toFixed(2)), pct: Number(pct.toFixed(2)) };
  } catch (_) {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/live' && url.pathname !== '/') {
      return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers });
    }

    // 60초 응답 캐시 (연타 방지)
    const cache = caches.default;
    const respCacheKey = new Request('https://kis-live-cache.internal/v1/live');
    const cachedResp = await cache.match(respCacheKey);
    if (cachedResp) {
      const body = await cachedResp.text();
      return new Response(body, { status: 200, headers });
    }

    const kst = getKstNow();
    const indices = {};
    const futures = { updatedKst: kst.stamp };
    const warnings = [];

    // 1) KIS 실전투자 API 조회
    if (env.KIS_APP_KEY && env.KIS_APP_SECRET) {
      try {
        const token = await getKisToken(env);
        const [kospi, kosdaq, k200] = await Promise.all([
          fetchKisIndex(token, env, '0001'),
          fetchKisIndex(token, env, '1001'),
          fetchKisFutures(token, env, kst)
        ]);
        if (kospi) indices.KOSPI = kospi;
        if (kosdaq) indices.KOSDAQ = kosdaq;
        if (k200) Object.assign(futures, k200);
      } catch (err) {
        warnings.push(`KIS 조회 지연: ${err.message}`);
      }
    } else {
      warnings.push('KIS Secret 미설정');
    }

    // 2) 해외 선물·원자재·환율 조회 (야후 파이낸스)
    const [nq, es, cl, gc, krw] = await Promise.all([
      fetchYahooQuote('NQ=F'),
      fetchYahooQuote('ES=F'),
      fetchYahooQuote('CL=F'),
      fetchYahooQuote('GC=F'),
      fetchYahooQuote('KRW=X')
    ]);
    if (nq) { futures.NQ = nq.price; futures.NQ_pct = nq.pct; }
    if (es) { futures.ES = es.price; futures.ES_pct = es.pct; }
    if (cl) { futures.CL = cl.price; futures.CL_pct = cl.pct; }
    if (gc) { futures.GC = gc.price; futures.GC_pct = gc.pct; }
    if (krw) indices.USDKRW = krw.price;

    const payload = JSON.stringify({
      dateKst: kst.date,
      updatedKst: kst.stamp,
      indices,
      futures,
      warnings
    });

    await cache.put(
      respCacheKey,
      new Response(payload, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' } })
    );

    return new Response(payload, { status: 200, headers });
  }
};

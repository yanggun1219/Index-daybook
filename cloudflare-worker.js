const KIS_BASE = 'https://openapi.koreainvestment.com:9443';
const ALLOWED_ORIGINS = [
  'https://yanggun1219.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
];

const POS_WORDS = ['rally', 'surge', 'gain', 'rise', 'jump', 'beat', 'cut', 'dovish', 'cooling', 'growth', 'record', 'up', 'rebound', 'bull', 'soar', 'boost', '상승', '반등', '호조', '강세', '완화', '최고', '급등', '돌파', '기대', '순매수'];
const NEG_WORDS = ['drop', 'fall', 'plunge', 'slump', 'crash', 'fear', 'inflation', 'hawkish', 'tariff', 'war', 'risk', 'down', 'selloff', 'bear', 'sink', 'tumble', '하락', '급락', '우려', '약세', '관세', '충격', '폭락', '위기', '경계', '순매도', '긴축'];

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

async function fetchBtcPerp() {
  // 1) Binance Futures BTCUSDT Perpetual
  try {
    const [tRes, fRes] = await Promise.all([
      fetch('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT', { headers: { 'User-Agent': 'Mozilla/5.0' } }),
      fetch('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT', { headers: { 'User-Agent': 'Mozilla/5.0' } })
    ]);
    if (tRes.ok) {
      const t = await tRes.json();
      const price = Number(t.lastPrice);
      const pct = Number(t.priceChangePercent);
      let funding = null;
      if (fRes.ok) {
        const f = await fRes.json();
        const r = Number(f.lastFundingRate);
        if (Number.isFinite(r)) funding = Number((r * 100).toFixed(4));
      }
      if (Number.isFinite(price) && price > 0) {
        return { BTC: Math.round(price), BTC_pct: Number(pct.toFixed(2)), BTC_funding: funding, BTC_src: 'Binance' };
      }
    }
  } catch (_) {}

  // 2) OKX BTC-USDT-SWAP Fallback (region-block safe)
  try {
    const [tRes, fRes] = await Promise.all([
      fetch('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP', { headers: { 'User-Agent': 'Mozilla/5.0' } }),
      fetch('https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP', { headers: { 'User-Agent': 'Mozilla/5.0' } })
    ]);
    if (tRes.ok) {
      const tj = await tRes.json();
      const row = tj?.data?.[0];
      const price = Number(row?.last);
      const open24 = Number(row?.open24h);
      const pct = open24 > 0 ? ((price / open24) - 1) * 100 : 0;
      let funding = null;
      if (fRes.ok) {
        const fj = await fRes.json();
        const r = Number(fj?.data?.[0]?.fundingRate);
        if (Number.isFinite(r)) funding = Number((r * 100).toFixed(4));
      }
      if (Number.isFinite(price) && price > 0) {
        return { BTC: Math.round(price), BTC_pct: Number(pct.toFixed(2)), BTC_funding: funding, BTC_src: 'OKX' };
      }
    }
  } catch (_) {}

  // 3) Yahoo Finance BTC-USD Fallback
  const y = await fetchYahooQuote('BTC-USD');
  if (y) return { BTC: Math.round(y.price), BTC_pct: y.pct, BTC_funding: null, BTC_src: 'Yahoo' };
  return null;
}

function cleanXmlText(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function translateEnToKo(text) {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return text;
    const json = await res.json();
    const parts = Array.isArray(json?.[0]) ? json[0].map(seg => seg[0] || '').join('') : '';
    return parts.trim() || text;
  } catch (_) {
    return text;
  }
}

async function fetchLiveNews(kst) {
  const items = [];
  const seen = new Set();

  // 1) 국내 주요 경제지 증권·글로벌 RSS (원문 국문 + 1줄 요약)
  const krFeeds = [
    ['한국경제', 'https://www.hankyung.com/feed/finance'],
    ['매일경제', 'https://www.mk.co.kr/rss/50200011/']
  ];
  for (const [source, url] of krFeeds) {
    if (items.length >= 3) break;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) continue;
      const xml = await res.text();
      const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
      for (const blk of blocks) {
        const tm = blk.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
        const lm = blk.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
        const dm = blk.match(/<description\b[^>]*>([\s\S]*?)<\/description>/i);
        const title = cleanXmlText(tm ? tm[1] : '');
        const link = cleanXmlText(lm ? lm[1] : '');
        let summary = cleanXmlText(dm ? dm[1] : '');
        if (summary.length > 96) summary = summary.slice(0, 95) + '…';
        if (!title || seen.has(title)) continue;
        seen.add(title);
        items.push({ title, summary, url: link, source, translated: false });
        if (items.length >= 3) break;
      }
    } catch (_) {
      continue;
    }
  }

  // 2) 미국 증시 글로벌 속보 (Yahoo Finance JSON -> 자동 국문 번역 + 한글 번역 링크)
  try {
    const yUrl = 'https://query1.finance.yahoo.com/v1/finance/search?q=NASDAQ+Fed+stock+market&newsCount=5&quotesCount=0';
    const res = await fetch(yUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      const json = await res.json();
      const rawUs = [];
      for (const n of (json.news || [])) {
        const title = String(n.title || '').trim();
        const link = String(n.link || '').trim();
        const source = String(n.publisher || 'Yahoo Finance').trim();
        if (!title || seen.has(title)) continue;
        seen.add(title);
        rawUs.push({ title, link, source });
        if (items.length + rawUs.length >= 5) break;
      }
      const translatedList = await Promise.all(
        rawUs.map(async u => {
          const koTitle = await translateEnToKo(u.title);
          const koUrl = u.link
            ? `https://translate.google.com/translate?sl=en&tl=ko&u=${encodeURIComponent(u.link)}`
            : '';
          return {
            title: koTitle,
            summary: koTitle !== u.title ? `원문: ${u.title}` : '',
            url: koUrl,
            source: u.source,
            translated: true
          };
        })
      );
      items.push(...translatedList);
    }
  } catch (_) {}

  let pos = 0;
  let neg = 0;
  for (const it of items) {
    const text = `${it.title} ${it.summary || ''}`.toLowerCase();
    for (const w of POS_WORDS) if (text.includes(w)) pos++;
    for (const w of NEG_WORDS) if (text.includes(w)) neg++;
  }
  const total = pos + neg;
  const sentiment = total ? Math.round(((pos - neg) / total) * 100) : 0;
  return {
    updatedKst: kst.stamp,
    sentiment,
    items: items.slice(0, 5)
  };
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

    const cache = caches.default;
    const respCacheKey = new Request('https://kis-live-cache.internal/v52b/live');
    const cachedResp = await cache.match(respCacheKey);
    if (cachedResp) {
      const body = await cachedResp.text();
      return new Response(body, { status: 200, headers });
    }

    const kst = getKstNow();
    const indices = {};
    const futures = { updatedKst: kst.stamp };
    const warnings = [];

    const kisPromise = (async () => {
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
    })();

    const [_, nq, es, cl, gc, krw, btc, news] = await Promise.all([
      kisPromise,
      fetchYahooQuote('NQ=F'),
      fetchYahooQuote('ES=F'),
      fetchYahooQuote('CL=F'),
      fetchYahooQuote('GC=F'),
      fetchYahooQuote('KRW=X'),
      fetchBtcPerp(),
      fetchLiveNews(kst)
    ]);

    if (nq) { futures.NQ = nq.price; futures.NQ_pct = nq.pct; }
    if (es) { futures.ES = es.price; futures.ES_pct = es.pct; }
    if (cl) { futures.CL = cl.price; futures.CL_pct = cl.pct; }
    if (gc) { futures.GC = gc.price; futures.GC_pct = gc.pct; }
    if (btc) Object.assign(futures, btc);
    if (krw) indices.USDKRW = krw.price;

    const payload = JSON.stringify({
      dateKst: kst.date,
      updatedKst: kst.stamp,
      indices,
      futures,
      news,
      warnings
    });

    await cache.put(
      respCacheKey,
      new Response(payload, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' } })
    );

    return new Response(payload, { status: 200, headers });
  }
};

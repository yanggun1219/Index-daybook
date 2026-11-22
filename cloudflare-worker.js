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
  return { nowMs: now.getTime(), date: `${yyyy}-${mm}-${dd}`, stamp: `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} KST`, year: yyyy, month: Number(mm), day: Number(dd) };
}

function formatAgeKo(pubMs, nowMs) {
  if (!Number.isFinite(pubMs) || pubMs <= 0) return '';
  const diffMin = Math.max(0, Math.floor((nowMs - pubMs) / 60000));
  if (diffMin < 2) return '방금 전';
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}시간 전`;
  return `${Math.floor(diffHr / 24)}일 전`;
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

async function fetchYahooQuoteWithSeries(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const json = await res.json();
    const r0 = json?.chart?.result?.[0];
    const meta = r0?.meta;
    if (!meta || !Number.isFinite(meta.regularMarketPrice)) return null;
    const price = Number(meta.regularMarketPrice);
    const prev = Number(meta.chartPreviousClose || meta.previousClose || price);
    const ts = r0?.timestamp || [];
    const closes = r0?.indicators?.quote?.[0]?.close || [];
    const series = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (!Number.isFinite(c)) continue;
      const d = new Date(ts[i] * 1000).toISOString().slice(5, 10);
      series.push([d, Number(c.toFixed(2))]);
    }
    const lastPrev = series.length >= 2 ? series[series.length - 2][1] : prev;
    const pct = lastPrev > 0 ? ((price / lastPrev) - 1) * 100 : 0;
    return { price: Number(price.toFixed(2)), pct: Number(pct.toFixed(2)), series: series.slice(-20) };
  } catch (_) {
    return null;
  }
}

async function fetchBtcPerp() {
  const ySeries = await fetchYahooQuoteWithSeries('BTC-USD');
  const series = ySeries ? ySeries.series : [];

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
        return { BTC: Math.round(price), BTC_pct: Number(pct.toFixed(2)), BTC_funding: funding, BTC_src: 'Binance', series };
      }
    }
  } catch (_) {}

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
        return { BTC: Math.round(price), BTC_pct: Number(pct.toFixed(2)), BTC_funding: funding, BTC_src: 'OKX', series };
      }
    }
  } catch (_) {}

  if (ySeries) return { BTC: Math.round(ySeries.price), BTC_pct: ySeries.pct, BTC_funding: null, BTC_src: 'Yahoo', series };
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

async function fetchRssPool(source, url, isGoogleNews = false) {
  const out = [];
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return out;
    const xml = await res.text();
    const blocks = (xml.match(/<item\b[\s\S]*?<\/item>/gi) || []).slice(0, 12);
    for (const blk of blocks) {
      const tm = blk.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
      const lm = blk.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
      const dm = blk.match(/<description\b[^>]*>([\s\S]*?)<\/description>/i);
      const pm = blk.match(/<(?:pubDate|dc:date|updated)\b[^>]*>([\s\S]*?)<\/(?:pubDate|dc:date|updated)>/i);
      const sm = isGoogleNews ? blk.match(/<source\b[^>]*>([\s\S]*?)<\/source>/i) : null;

      let title = cleanXmlText(tm ? tm[1] : '');
      const link = cleanXmlText(lm ? lm[1] : '');
      let pubSource = sm ? cleanXmlText(sm[1]) : source;
      if (isGoogleNews && pubSource && title.endsWith(` - ${pubSource}`)) {
        title = title.slice(0, -(` - ${pubSource}`).length).trim();
      }
      let summary = isGoogleNews ? '' : cleanXmlText(dm ? dm[1] : '');
      if (summary.length > 96) summary = summary.slice(0, 95) + '…';
      let rawDate = pm ? cleanXmlText(pm[1]) : '';
      if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(rawDate)) rawDate = rawDate.replace(' ', 'T') + '+09:00';
      const pubMs = rawDate ? Date.parse(rawDate) : 0;
      if (!title) continue;
      out.push({ title, summary, url: link, source: pubSource || source, pubMs: Number.isFinite(pubMs) ? pubMs : 0 });
    }
  } catch (_) {}
  return out;
}

async function fetchLiveNews(kst) {
  const [sed, nws, fnn, yna, hk, mk, ed, cho, her, mt, prm, gnKr, gnUs] = await Promise.all([
    fetchRssPool('서울경제', 'https://www.sedaily.com/rss/newsall'),
    fetchRssPool('뉴시스', 'https://www.newsis.com/RSS/economy.xml'),
    fetchRssPool('파이낸셜뉴스', 'https://www.fnnews.com/rss/r20/fn_realnews_stock.xml'),
    fetchRssPool('연합뉴스', 'https://www.yna.co.kr/rss/economy.xml'),
    fetchRssPool('한국경제', 'https://www.hankyung.com/feed/finance'),
    fetchRssPool('매일경제', 'https://www.mk.co.kr/rss/50200011/'),
    fetchRssPool('이데일리', 'https://rss.edaily.co.kr/economy_news.xml'),
    fetchRssPool('조선일보', 'https://www.chosun.com/arc/outboundfeeds/rss/category/economy/?outputType=xml'),
    fetchRssPool('헤럴드경제', 'https://biz.heraldcorp.com/rss/google/newsAll'),
    fetchRssPool('머니투데이', 'http://rss.mt.co.kr/mt_news.xml'),
    fetchRssPool('프라임경제', 'https://www.newsprime.co.kr/data/rss/news.xml'),
    fetchRssPool('구글뉴스', 'https://news.google.com/rss/search?q=%EC%BD%94%EC%8A%A4%ED%94%BC+OR+%EC%BD%94%EC%8A%A4%EB%8B%A5+OR+%EC%A6%9D%EC%8B%9C+when:1d&hl=ko&gl=KR&ceid=KR:ko', true),
    fetchRssPool('구글뉴스', 'https://news.google.com/rss/search?q=%EB%82%98%EC%8A%A4%EB%8B%A5+OR+%EB%AF%B8%EA%B5%AD%EC%A6%9D%EC%8B%9C+OR+%EC%97%B0%EC%A4%80+OR+%EB%89%B4%EC%9A%95%EC%A6%9D%EC%8B%9C+when:1d&hl=ko&gl=KR&ceid=KR:ko', true)
  ]);

  // 전체 종합 피드는 증시·경제 키워드만 필터링해 잡뉴스 제외
  const ecoRe = /코스피|코스닥|나스닥|증시|주가|선물|환율|금리|연준|반도체|삼성|하이닉스|외국인|공매도|유가|비트코인|경제|금융|채권|ETF|미국|뉴욕|관세|자사주|펀드|월가|다우|S&P|트럼프|증안/;
  const all = [
    ...sed.filter(it => ecoRe.test(it.title)),
    ...nws,
    ...fnn,
    ...yna,
    ...hk,
    ...mk,
    ...ed,
    ...cho,
    ...her.filter(it => ecoRe.test(it.title)),
    ...mt.filter(it => ecoRe.test(it.title)),
    ...prm.filter(it => ecoRe.test(it.title)),
    ...gnKr,
    ...gnUs
  ].sort((a, b) => b.pubMs - a.pubMs);

  const picked = [];
  const seen = new Set();
  // 국내 언론사 통합 순수 최신 속보순 상위 15건 선별 (중복 제목 정규화 제거)
  for (const item of all) {
    const normKey = item.title.replace(/[\s"'‘’“”·….,!?\[\]()]/g, '').slice(0, 22);
    if (!normKey || seen.has(normKey)) continue;
    seen.add(normKey);
    picked.push(item);
    if (picked.length >= 15) break;
  }

  const items = picked.map(it => {
    const age = formatAgeKo(it.pubMs, kst.nowMs);
    const srcLabel = age ? `${it.source} · ${age}` : it.source;
    return {
      title: it.title,
      summary: it.summary,
      url: it.url,
      source: srcLabel,
      translated: false
    };
  });

  // 투심 점수는 가장 최신 8건 기준으로 산출
  let pos = 0;
  let neg = 0;
  for (const it of items.slice(0, 8)) {
    const text = `${it.title} ${it.summary || ''}`.toLowerCase();
    for (const w of POS_WORDS) if (text.includes(w)) pos++;
    for (const w of NEG_WORDS) if (text.includes(w)) neg++;
  }
  const total = pos + neg;
  const sentiment = total ? Math.round(((pos - neg) / total) * 100) : 0;
  return {
    updatedKst: kst.stamp,
    sentiment,
    items
  };
}


async function fetchDetailedChart(key, tf) {
  const tfMap = {
    '15m': { range: '5d', interval: '15m', binInt: '15m', limit: 64 },
    '1h':  { range: '1mo', interval: '60m', binInt: '1h', limit: 72 },
    '1d':  { range: '3mo', interval: '1d', binInt: '1d',  limit: 60 }
  };
  const cfg = tfMap[tf] || tfMap['15m'];

  // BTC: Binance Futures klines -> OKX candles -> Yahoo fallback
  if (key === 'BTC') {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=${cfg.binInt}&limit=${cfg.limit}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length) {
          return rows.map(r => {
            const kst = new Date(Number(r[0]) + 9 * 3600 * 1000);
            const lbl = tf === '1d'
              ? kst.toISOString().slice(5, 10)
              : `${kst.toISOString().slice(5, 10)} ${kst.toISOString().slice(11, 16)}`;
            return [lbl, Math.round(Number(r[4])), Math.round(Number(r[2])), Math.round(Number(r[3]))];
          });
        }
      }
    } catch (_) {}
  }

  const symListMap = { NQ: ['NQ=F'], ES: ['ES=F'], CL: ['CL=F'], GC: ['GC=F'], BTC: ['BTC-USD'], K200: ['^KS200', '^KS11'] };
  const syms = symListMap[key] || [];
  for (const sym of syms) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${cfg.range}&interval=${cfg.interval}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) continue;
      const json = await res.json();
      const r0 = json?.chart?.result?.[0];
      const ts = r0?.timestamp || [];
      const q = r0?.indicators?.quote?.[0] || {};
      const closes = q.close || [];
      const highs = q.high || [];
      const lows = q.low || [];
      const out = [];
      for (let i = 0; i < ts.length; i++) {
        const c = closes[i];
        if (!Number.isFinite(c)) continue;
        const kst = new Date(ts[i] * 1000 + 9 * 3600 * 1000);
        const lbl = tf === '1d'
          ? kst.toISOString().slice(5, 10)
          : `${kst.toISOString().slice(5, 10)} ${kst.toISOString().slice(11, 16)}`;
        const h = Number.isFinite(highs[i]) ? Number(highs[i].toFixed(2)) : Number(c.toFixed(2));
        const l = Number.isFinite(lows[i]) ? Number(lows[i].toFixed(2)) : Number(c.toFixed(2));
        out.push([lbl, Number(c.toFixed(2)), h, l]);
      }
      if (out.length >= 5) return out.slice(-cfg.limit);
    } catch (_) {
      continue;
    }
  }
  return [];
}


const SECTOR_PROFILES = {
  semi: {
    label: '반도체',
    peers: [
      { sym: '^SOX', label: '필라델피아 반도체' },
      { sym: 'NVDA', label: '엔비디아 (NVDA)' },
      { sym: 'MU', label: '마이크론 (MU)' },
      { sym: 'KRW=X', label: '원/달러 환율' }
    ]
  },
  battery: {
    label: '2차전지',
    peers: [
      { sym: 'TSLA', label: '테슬라 (TSLA)' },
      { sym: 'LIT', label: '리튬·배터리 ETF (LIT)' },
      { sym: '^TNX', label: '미 국채 10년 금리', isLevel: true, unit: '%' },
      { sym: 'KRW=X', label: '원/달러 환율' }
    ]
  },
  auto: {
    label: '자동차·수출',
    peers: [
      { sym: 'KRW=X', label: '원/달러 환율' },
      { sym: '^GSPC', label: 'S&P500 지수' },
      { sym: 'CL=F', label: 'WTI 국제유가' },
      { sym: '^IXIC', label: '나스닥 종합' }
    ]
  },
  ship: {
    label: '조선·방산',
    peers: [
      { sym: 'CL=F', label: 'WTI 국제유가' },
      { sym: 'KRW=X', label: '원/달러 환율' },
      { sym: 'XLI', label: '미 산업재 ETF (XLI)' },
      { sym: '^GSPC', label: 'S&P500 지수' }
    ]
  },
  bio: {
    label: '바이오·제약',
    peers: [
      { sym: 'XBI', label: '미 바이오 ETF (XBI)' },
      { sym: '^IXIC', label: '나스닥 종합' },
      { sym: '^TNX', label: '미 국채 10년 금리', isLevel: true, unit: '%' },
      { sym: '^VIX', label: 'VIX 변동성 지수', isLevel: true, unit: 'pt' }
    ]
  },
  fin: {
    label: '금융·은행',
    peers: [
      { sym: '^TNX', label: '미 국채 10년 금리', isLevel: true, unit: '%' },
      { sym: 'XLF', label: '미 금융 ETF (XLF)' },
      { sym: '^VIX', label: 'VIX 변동성 지수', isLevel: true, unit: 'pt' },
      { sym: '^KS11', label: '코스피 지수' }
    ]
  },
  tech: {
    label: '인터넷·AI',
    peers: [
      { sym: 'QQQ', label: '나스닥100 (QQQ)' },
      { sym: '^TNX', label: '미 국채 10년 금리', isLevel: true, unit: '%' },
      { sym: '^VIX', label: 'VIX 변동성 지수', isLevel: true, unit: 'pt' },
      { sym: '^KS11', label: '코스피 지수' }
    ]
  },
  us_semi: {
    label: '미국 반도체·AI',
    peers: [
      { sym: '^SOX', label: '필라델피아 반도체' },
      { sym: '^IXIC', label: '나스닥 종합' },
      { sym: '^TNX', label: '미 국채 10년 금리', isLevel: true, unit: '%' },
      { sym: '^VIX', label: 'VIX 변동성 지수', isLevel: true, unit: 'pt' }
    ]
  },
  us_ev: {
    label: '미국 전기차·성장주',
    peers: [
      { sym: '^IXIC', label: '나스닥 종합' },
      { sym: 'LIT', label: '리튬·배터리 ETF (LIT)' },
      { sym: '^TNX', label: '미 국채 10년 금리', isLevel: true, unit: '%' },
      { sym: '^VIX', label: 'VIX 변동성 지수', isLevel: true, unit: 'pt' }
    ]
  },
  general: {
    label: '일반 대형주',
    peers: [
      { sym: '^IXIC', label: '나스닥 종합' },
      { sym: '^GSPC', label: 'S&P500 지수' },
      { sym: 'KRW=X', label: '원/달러 환율' },
      { sym: '^VIX', label: 'VIX 변동성 지수', isLevel: true, unit: 'pt' }
    ]
  }
};

const KR_STOCK_DICT = {
  'SK하이닉스': { sym: '000660.KS', code: '000660', name: 'SK하이닉스', sector: 'semi' },
  '하이닉스': { sym: '000660.KS', code: '000660', name: 'SK하이닉스', sector: 'semi' },
  '삼성전자': { sym: '005930.KS', code: '005930', name: '삼성전자', sector: 'semi' },
  'LG에너지솔루션': { sym: '373220.KS', code: '373220', name: 'LG에너지솔루션', sector: 'battery' },
  '엔솔': { sym: '373220.KS', code: '373220', name: 'LG에너지솔루션', sector: 'battery' },
  '에코프로': { sym: '086520.KQ', code: '086520', name: '에코프로', sector: 'battery' },
  '에코프로비엠': { sym: '247540.KQ', code: '247540', name: '에코프로비엠', sector: 'battery' },
  '삼성SDI': { sym: '006400.KS', code: '006400', name: '삼성SDI', sector: 'battery' },
  '포스코홀딩스': { sym: '005490.KS', code: '005490', name: 'POSCO홀딩스', sector: 'battery' },
  '현대차': { sym: '005380.KS', code: '005380', name: '현대차', sector: 'auto' },
  '기아': { sym: '000270.KS', code: '000270', name: '기아', sector: 'auto' },
  'HD현대중공업': { sym: '329180.KS', code: '329180', name: 'HD현대중공업', sector: 'ship' },
  '한화에어로스페이스': { sym: '012450.KS', code: '012450', name: '한화에어로스페이스', sector: 'ship' },
  '한화오션': { sym: '042660.KS', code: '042660', name: '한화오션', sector: 'ship' },
  '두산에너빌리티': { sym: '034020.KS', code: '034020', name: '두산에너빌리티', sector: 'ship' },
  '셀트리온': { sym: '068270.KS', code: '068270', name: '셀트리온', sector: 'bio' },
  '삼성바이오로직스': { sym: '207940.KS', code: '207940', name: '삼성바이오로직스', sector: 'bio' },
  '알테오젠': { sym: '196170.KQ', code: '196170', name: '알테오젠', sector: 'bio' },
  'KB금융': { sym: '105560.KS', code: '105560', name: 'KB금융', sector: 'fin' },
  '신한지주': { sym: '055550.KS', code: '055550', name: '신한지주', sector: 'fin' },
  '하나금융지주': { sym: '086790.KS', code: '086790', name: '하나금융지주', sector: 'fin' },
  'NAVER': { sym: '035420.KS', code: '035420', name: 'NAVER', sector: 'tech' },
  '네이버': { sym: '035420.KS', code: '035420', name: 'NAVER', sector: 'tech' },
  '카카오': { sym: '035720.KS', code: '035720', name: '카카오', sector: 'tech' },
  '카카오뱅크': { sym: '323410.KS', code: '323410', name: '카카오뱅크', sector: 'fin' },
  '엔비디아': { sym: 'NVDA', code: '', name: 'NVIDIA (NVDA)', sector: 'us_semi' },
  '테슬라': { sym: 'TSLA', code: '', name: 'Tesla (TSLA)', sector: 'us_ev' },
  '애플': { sym: 'AAPL', code: '', name: 'Apple (AAPL)', sector: 'us_semi' },
  '마이크로소프트': { sym: 'MSFT', code: '', name: 'Microsoft (MSFT)', sector: 'us_semi' },
  '팔란티어': { sym: 'PLTR', code: '', name: 'Palantir (PLTR)', sector: 'us_semi' }
};

async function fetchYahooDaily2Y(symbol) {
  const cache = caches.default;
  const cKey = new Request(`https://kis-y2y-cache.internal/v700/${encodeURIComponent(symbol)}`);
  const hit = await cache.match(cKey);
  if (hit) {
    try { return await hit.json(); } catch (_) {}
  }
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const json = await res.json();
    const r0 = json?.chart?.result?.[0];
    const meta = r0?.meta || {};
    const ts = r0?.timestamp || [];
    const closes = r0?.indicators?.quote?.[0]?.close || [];
    const rows = [];
    let prevClose = null;
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (!Number.isFinite(c) || c <= 0) continue;
      const d = new Date(ts[i] * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10);
      const pct = prevClose ? Number((((c / prevClose) - 1) * 100).toFixed(2)) : 0;
      if (rows.length && rows[rows.length - 1][0] === d) {
        rows[rows.length - 1] = [d, Number(c.toFixed(2)), pct];
      } else {
        rows.push([d, Number(c.toFixed(2)), pct]);
      }
      prevClose = c;
    }
    if (rows.length < 30) return null;
    const out = {
      symbol: meta.symbol || symbol,
      name: meta.shortName || meta.longName || symbol,
      currency: meta.currency || (symbol.endsWith('.KS') || symbol.endsWith('.KQ') ? 'KRW' : 'USD'),
      rows
    };
    await cache.put(cKey, new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=900' } }));
    return out;
  } catch (_) {
    return null;
  }
}

async function fetchKisStockPrice(token, env, code) {
  if (!code || !/^\d{6}$/.test(code)) return null;
  try {
    const url = `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`;
    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        authorization: `Bearer ${token}`,
        appkey: env.KIS_APP_KEY,
        appsecret: env.KIS_APP_SECRET,
        tr_id: 'FHKST01010100',
        custtype: 'P'
      }
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.rt_cd !== '0' || !json.output) return null;
    const price = Number(json.output.stck_prpr);
    const pct = Number(json.output.prdy_ctrt);
    if (!Number.isFinite(price) || price <= 0) return null;
    return { close: price, pct: Number.isFinite(pct) ? Number(pct.toFixed(2)) : 0 };
  } catch (_) {
    return null;
  }
}

async function resolveStockTarget(rawQuery) {
  const q = String(rawQuery || '').trim();
  if (!q) return null;
  const direct = KR_STOCK_DICT[q] || KR_STOCK_DICT[q.toUpperCase()];
  if (direct) return direct;

  // 6자리 국내 종목코드 직접 입력
  if (/^\d{6}$/.test(q)) {
    const byCode = Object.values(KR_STOCK_DICT).find(v => v.code === q);
    if (byCode) return byCode;
    return { sym: `${q}.KS`, altSym: `${q}.KQ`, code: q, name: q, sector: 'general' };
  }
  // 이미 .KS / .KQ 또는 영문 티커
  if (/^[A-Za-z0-9.-]{1,12}$/.test(q)) {
    const up = q.toUpperCase();
    const isKr = up.endsWith('.KS') || up.endsWith('.KQ');
    const code = isKr ? up.split('.')[0] : '';
    const bySym = Object.values(KR_STOCK_DICT).find(v => v.sym === up);
    if (bySym) return bySym;
    return { sym: up, code, name: up, sector: isKr ? 'general' : 'us_semi' };
  }
  // 그 외 종목명은 Yahoo Search로 티커 조회
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=5&newsCount=0`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (res.ok) {
      const j = await res.json();
      const match = (j.quotes || []).find(it => it.symbol && (it.quoteType === 'EQUITY' || it.quoteType === 'ETF'));
      if (match) {
        const isKr = match.symbol.endsWith('.KS') || match.symbol.endsWith('.KQ');
        return {
          sym: match.symbol,
          code: isKr ? match.symbol.split('.')[0] : '',
          name: match.shortname || match.longname || q,
          sector: isKr ? 'general' : 'us_semi'
        };
      }
    }
  } catch (_) {}
  return null;
}

async function handleStockRequest(url, env, headers) {
  const q = (url.searchParams.get('q') || '').trim();
  const reqSector = (url.searchParams.get('sector') || '').trim();
  const target = await resolveStockTarget(q);
  if (!target) {
    return new Response(JSON.stringify({ error: '종목을 찾을 수 없습니다. 종목명, 6자리 코드(예: 000660) 또는 미국 티커(예: NVDA)를 입력해 주세요.' }), { status: 404, headers });
  }

  const sectorKey = SECTOR_PROFILES[reqSector] ? reqSector : (SECTOR_PROFILES[target.sector] ? target.sector : 'general');
  const profile = SECTOR_PROFILES[sectorKey];
  const cache = caches.default;
  const cKey = new Request(`https://kis-stock-cache.internal/v700/${encodeURIComponent(target.sym)}/${sectorKey}`);
  const hit = await cache.match(cKey);
  if (hit) return new Response(await hit.text(), { status: 200, headers });

  let mainData = await fetchYahooDaily2Y(target.sym);
  if (!mainData && target.altSym) {
    mainData = await fetchYahooDaily2Y(target.altSym);
  }
  if (!mainData) {
    return new Response(JSON.stringify({ error: `시세 데이터를 불러오지 못했습니다 (${target.sym}).` }), { status: 502, headers });
  }

  const kst = getKstNow();
  const isKr = mainData.symbol.endsWith('.KS') || mainData.symbol.endsWith('.KQ');
  const krCode = target.code || (isKr ? mainData.symbol.split('.')[0] : '');

  const peerPromises = profile.peers.map(async p => {
    const d = await fetchYahooDaily2Y(p.sym);
    return d ? { sym: p.sym, label: p.label, isLevel: Boolean(p.isLevel), unit: p.unit || '%', rows: d.rows } : null;
  });

  const kisPromise = (async () => {
    if (isKr && krCode && env.KIS_APP_KEY && env.KIS_APP_SECRET) {
      try {
        const token = await getKisToken(env);
        return await fetchKisStockPrice(token, env, krCode);
      } catch (_) {}
    }
    return null;
  })();

  const newsQuery = encodeURIComponent(`${target.name.split(' ')[0]} 주가 OR 실적 when:7d`);
  const newsPromise = fetchRssPool('구글뉴스', `https://news.google.com/rss/search?q=${newsQuery}&hl=ko&gl=KR&ceid=KR:ko`, true);

  const [peerResults, kisLive, rawNews] = await Promise.all([
    Promise.all(peerPromises),
    kisPromise,
    newsPromise
  ]);

  const rows = mainData.rows.slice();
  let isLiveIntraday = false;
  if (kisLive && Number.isFinite(kisLive.close) && rows.length) {
    const last = rows[rows.length - 1];
    if (last[0] === kst.date) {
      rows[rows.length - 1] = [kst.date, kisLive.close, kisLive.pct];
      isLiveIntraday = true;
    } else if (kst.date > last[0] && Math.abs(kisLive.close - last[1]) > 0.005) {
      const calcPct = Number((((kisLive.close / last[1]) - 1) * 100).toFixed(2));
      rows.push([kst.date, kisLive.close, calcPct]);
      isLiveIntraday = true;
    }
  }

  const news = rawNews
    .sort((a, b) => b.pubMs - a.pubMs)
    .slice(0, 5)
    .map(it => {
      const age = formatAgeKo(it.pubMs, kst.nowMs);
      return {
        title: it.title,
        url: it.url,
        source: age ? `${it.source} · ${age}` : it.source
      };
    });

  const body = JSON.stringify({
    symbol: mainData.symbol,
    name: target.name !== target.code ? target.name : mainData.name,
    currency: mainData.currency,
    isKr,
    isLiveIntraday,
    updatedKst: kst.stamp,
    sector: sectorKey,
    sectorLabel: profile.label,
    rows,
    peers: peerResults.filter(Boolean),
    news
  });

  await cache.put(cKey, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=120' } }));
  return new Response(body, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);
    if (url.pathname === '/stock') {
      return handleStockRequest(url, env, headers);
    }
    if (url.pathname === '/chart') {
      const key = (url.searchParams.get('key') || '').toUpperCase();
      const tf = url.searchParams.get('tf') || '15m';
      const cache = caches.default;
      const cKey = new Request(`https://kis-chart-cache.internal/v593/${key}/${tf}`);
      const hit = await cache.match(cKey);
      if (hit) return new Response(await hit.text(), { status: 200, headers });
      const points = await fetchDetailedChart(key, tf);
      const body = JSON.stringify({ key, tf, points });
      await cache.put(cKey, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' } }));
      return new Response(body, { status: 200, headers });
    }
    if (url.pathname !== '/live' && url.pathname !== '/') {
      return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers });
    }

    const cache = caches.default;
    const respCacheKey = new Request('https://kis-live-cache.internal/v593/live');
    const cachedResp = await cache.match(respCacheKey);
    if (cachedResp) {
      const body = await cachedResp.text();
      return new Response(body, { status: 200, headers });
    }

    const kst = getKstNow();
    const indices = {};
    const futures = { updatedKst: kst.stamp, series: {} };
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
      fetchYahooQuoteWithSeries('NQ=F'),
      fetchYahooQuoteWithSeries('ES=F'),
      fetchYahooQuoteWithSeries('CL=F'),
      fetchYahooQuoteWithSeries('GC=F'),
      fetchYahooQuoteWithSeries('KRW=X'),
      fetchBtcPerp(),
      fetchLiveNews(kst)
    ]);

    if (nq) { futures.NQ = nq.price; futures.NQ_pct = nq.pct; futures.series.NQ = nq.series; }
    if (es) { futures.ES = es.price; futures.ES_pct = es.pct; futures.series.ES = es.series; }
    if (cl) { futures.CL = cl.price; futures.CL_pct = cl.pct; futures.series.CL = cl.series; }
    if (gc) { futures.GC = gc.price; futures.GC_pct = gc.pct; futures.series.GC = gc.series; }
    if (btc) {
      futures.BTC = btc.BTC;
      futures.BTC_pct = btc.BTC_pct;
      futures.BTC_funding = btc.BTC_funding;
      futures.BTC_src = btc.BTC_src;
      futures.series.BTC = btc.series;
    }
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

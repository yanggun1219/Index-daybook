// 지수 관측소 v4.3 — 나스닥 한국장 선행 잔차 + 전용 정규화 + VIX3M·DAX 확장 + 1일/5일 듀얼 호라이즌

const MIN_BASE_SAMPLES = 18;
const MIN_EXTRA_SAMPLES = 60;
const MIN_CONVICTION_SAMPLES = 20;
const RECENCY_HALF_LIFE = 380; // 최근 1.5년 장세에 더 높은 가중치 부여 (코스피/5일)

const FEATURE_META = {
  KR: [
    { key: 'ret1', label: '당일 등락률', unit: '%', min: -8, max: 8, step: 0.1 },
    { key: 'retPrev', label: '전일 등락률', unit: '%', min: -8, max: 8, step: 0.1 },
    { key: 'ret5', label: '5거래일 모멘텀', unit: '%', min: -15, max: 15, step: 0.2 },
    { key: 'vol10', label: '10일 실현변동성', unit: '%', min: 0.3, max: 6, step: 0.1 },
    { key: 'fx1', label: '원/달러 환율 변화', unit: '%', min: -3, max: 3, step: 0.05 },
    { key: 'usRet', label: '직전 나스닥 누적 등락', unit: '%', min: -10, max: 10, step: 0.1 }
  ],
  US: [
    { key: 'ret1', label: '당일 등락률', unit: '%', min: -8, max: 8, step: 0.1 },
    { key: 'retPrev', label: '전일 등락률', unit: '%', min: -8, max: 8, step: 0.1 },
    { key: 'ret5', label: '5거래일 모멘텀', unit: '%', min: -15, max: 15, step: 0.2 },
    { key: 'vol10', label: '10일 실현변동성', unit: '%', min: 0.3, max: 6, step: 0.1 }
  ]
};

const EXTRA_META = {
  sox: { key: 'sox', label: 'SOX − 나스닥 상대강도', unit: '%p', min: -12, max: 12, step: 0.1 },
  breadth: { key: 'breadth', label: '코스닥 상승 종목 비율', unit: '%', min: 0, max: 100, step: 0.5 },
  flow: { key: 'flow', label: '외국인 현물 순매수 강도', unit: '%', min: -25, max: 25, step: 0.1 },
  vix: { key: 'vix', label: 'VIX 변동성 지수', unit: 'pt', min: 10, max: 60, step: 0.5 },
  vixRatio: { key: 'vixRatio', label: 'VIX / VIX3M 기간구조', unit: 'x', min: 0.6, max: 1.5, step: 0.02 },
  tnx: { key: 'tnx', label: '미 국채 10년물 일간 변화', unit: '%p', min: -0.4, max: 0.4, step: 0.01 },
  dxy: { key: 'dxy', label: '달러 인덱스(DXY) 변화', unit: '%', min: -3, max: 3, step: 0.05 },
  oil: { key: 'oil', label: 'WTI 국제유가 변화', unit: '%', min: -10, max: 10, step: 0.2 },
  gold: { key: 'gold', label: '국제 금 선물 변화', unit: '%', min: -6, max: 6, step: 0.1 },
  usVix: { key: 'usVix', label: '나스닥×VIX 충격 상호작용', unit: '', min: -15, max: 15, step: 0.2 },
  ret20: { key: 'ret20', label: '20거래일 중기 추세', unit: '%', min: -25, max: 25, step: 0.5 },
  krLead: { key: 'krLead', label: '한국장(코스피) 장전 등락', unit: '%', min: -8, max: 8, step: 0.1 },
  krResid: { key: 'krResid', label: '코스피 장전 독자 변동분', unit: '%p', min: -6, max: 6, step: 0.1 },
  dax: { key: 'dax', label: '유럽장(독일 DAX) 등락', unit: '%', min: -8, max: 8, step: 0.1 },
  news: { key: 'news', label: '글로벌 뉴스 심리', unit: '점', min: -100, max: 100, step: 5 },
  krFut: { key: 'krFut', label: '코스피200 선물 등락', unit: '%', min: -6, max: 6, step: 0.1 },
  krBasis: { key: 'krBasis', label: '코스피200 선물 베이시스', unit: 'pt', min: -5, max: 5, step: 0.1 }
};

function getConvictionThreshold(marketKey) {
  return marketKey === 'NASDAQ' ? 0.60 : 0.65;
}

function quantile(values, p) {
  if (!values || !values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function adjacent(a, b) {
  return Boolean(
    a &&
    b &&
    (Date.parse(b[0]) - Date.parse(a[0])) / 86400000 <= 7 &&
    Math.abs((b[1] / a[1] - 1) * 100 - b[2]) < 0.012
  );
}

function sigmoid(z) {
  if (z > 20) return 1;
  if (z < -20) return 0;
  return 1 / (1 + Math.exp(-z));
}

function findLastIndexOnOrBefore(rows, dateStr) {
  if (!rows || !rows.length) return -1;
  let lo = 0;
  let hi = rows.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= dateStr) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function cumulativeUsReturn(nasdaqRows, prevKrDate, curKrDate) {
  const curIdx = findLastIndexOnOrBefore(nasdaqRows, curKrDate);
  if (curIdx < 0) return { ret: 0, usDate: null, sessions: 0 };
  const prevIdx = prevKrDate ? findLastIndexOnOrBefore(nasdaqRows, prevKrDate) : curIdx - 1;
  if (prevIdx >= 0 && curIdx > prevIdx && curIdx - prevIdx <= 5) {
    const cumRet = (nasdaqRows[curIdx][1] / nasdaqRows[prevIdx][1] - 1) * 100;
    return { ret: cumRet, usDate: nasdaqRows[curIdx][0], sessions: curIdx - prevIdx };
  }
  return { ret: nasdaqRows[curIdx][2], usDate: nasdaqRows[curIdx][0], sessions: 1 };
}

function buildDiffMap(series, isPct) {
  const map = new Map();
  if (!series || series.length < 2) return map;
  for (let i = 1; i < series.length; i++) {
    const [date, val] = series[i];
    const prev = series[i - 1][1];
    if (Number.isFinite(val) && Number.isFinite(prev) && prev !== 0) {
      map.set(date, isPct ? (val / prev - 1) * 100 : val - prev);
    }
  }
  return map;
}

function findPreUsKoreaSession(nasdaqDate, nextNasdaqDate, maps) {
  if (nextNasdaqDate) {
    const ret = maps.kospiByDate.get(nextNasdaqDate);
    if (Number.isFinite(ret)) return { ret, krDate: nextNasdaqDate };
    return { ret: undefined, krDate: null };
  }
  // 최신일 실시간 예측: 미국 전일 종가(nasdaqDate) 이후 먼저 마감한 한국장 세션 탐색 (최대 5일 이내)
  const dates = maps.kospiDates;
  for (let i = dates.length - 1; i >= 0; i--) {
    const d = dates[i];
    if (d <= nasdaqDate) break;
    const gap = (Date.parse(d) - Date.parse(nasdaqDate)) / 86400000;
    if (gap > 0 && gap <= 5) {
      return { ret: maps.kospiByDate.get(d), krDate: d };
    }
  }
  return { ret: undefined, krDate: null };
}

function extractBaseFeatures(rows, i, marketKey, allMarkets) {
  if (i < 5) return null;
  const today = rows[i];
  const prev = rows[i - 1];
  if (!prev || !adjacent(prev, today)) return null;

  const ret5 = rows[i - 5][1] ? (today[1] / rows[i - 5][1] - 1) * 100 : 0;
  const ret20 = i >= 20 && rows[i - 20][1] ? (today[1] / rows[i - 20][1] - 1) * 100 : undefined;
  const winStart = Math.max(0, i - 9);
  const rets = [];
  for (let k = winStart; k <= i; k++) rets.push(rows[k][2]);
  const meanR = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - meanR) ** 2, 0) / Math.max(1, rets.length - 1);
  const vol10 = Math.sqrt(variance) || 1.0;

  const feats = [today[2], prev[2], ret5, vol10];
  let usInfo = { ret: 0, usDate: null, sessions: 0 };
  if (marketKey !== 'NASDAQ') {
    const fxChg = today[3] && prev[3] ? (today[3] / prev[3] - 1) * 100 : 0;
    usInfo = cumulativeUsReturn(allMarkets.NASDAQ || [], prev[0], today[0]);
    feats.push(fxChg, usInfo.ret);
  }
  return {
    feats,
    vol: vol10,
    ret1: today[2],
    ret20,
    usRet: usInfo.ret,
    usDate: usInfo.usDate,
    usSessions: usInfo.sessions
  };
}

function fitLogisticModel(pool, d, warm, useRecency, l2Floor) {
  const n = pool.length;
  const sw = new Array(n);
  let wSum = 0;
  const decay = useRecency ? Math.LN2 / RECENCY_HALF_LIFE : 0;
  for (let i = 0; i < n; i++) {
    const wt = useRecency ? Math.exp(-decay * (n - 1 - i)) : 1;
    sw[i] = wt;
    wSum += wt;
  }
  const normFactor = n / wSum;
  let upSum = 0;
  for (let i = 0; i < n; i++) {
    sw[i] *= normFactor;
    upSum += sw[i] * pool[i].up;
  }
  const baseRate = upSum / n;

  const means = new Array(d);
  const stds = new Array(d);
  for (let j = 0; j < d; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += sw[i] * pool[i].x[j];
    const mean = s / n;
    let v = 0;
    for (let i = 0; i < n; i++) {
      const diff = pool[i].x[j] - mean;
      v += sw[i] * diff * diff;
    }
    means[j] = mean;
    stds[j] = Math.sqrt(v / n) || 1;
  }

  const X = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Array(d);
    const rx = pool[i].x;
    for (let j = 0; j < d; j++) {
      const z = (rx[j] - means[j]) / stds[j];
      row[j] = z > 3 ? 3 : z < -3 ? -3 : z;
    }
    X[i] = row;
  }

  const baseLambda = Math.max(l2Floor || 10, (280 / Math.sqrt(n)) * Math.sqrt(d / 6));
  const clampedBase = Math.max(0.05, Math.min(0.95, baseRate));
  const useWarm = warm && warm.w && warm.w.length === d;
  let b = useWarm ? warm.b : Math.log(clampedBase / (1 - clampedBase));
  const w = useWarm ? [...warm.w] : new Array(d).fill(0);
  const lr = 0.08;
  const iters = useWarm ? 14 : 110;

  for (let iter = 0; iter < iters; iter++) {
    let gb = 0;
    const gw = new Array(d).fill(0);
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const err = sw[i] * (sigmoid(z) - pool[i].up);
      gb += err;
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
    }
    b -= lr * (gb / n);
    for (let j = 0; j < d; j++) {
      w[j] -= lr * (gw[j] / n + (baseLambda / n) * w[j]);
    }
  }

  const stdRets = pool.map(r => r.y / Math.max(0.35, r.vol));
  const qLo = quantile(stdRets, Math.max(0.02, 0.1 - 0.5 / (n + 1)));
  const qHi = quantile(stdRets, Math.min(0.98, 0.9 + 0.5 / (n + 1)));
  const ups = pool.filter(r => r.y > 0).map(r => r.y);
  const downs = pool.filter(r => r.y < 0).map(r => r.y);
  const volMedian = quantile(pool.map(r => r.vol), 0.5) || 1.2;

  return {
    n,
    baseRate,
    means,
    stds,
    b,
    w,
    qLo,
    qHi,
    volMedian,
    gain: quantile(ups, 0.5),
    loss: quantile(downs, 0.5)
  };
}

function classifySignal(p, marketKey) {
  const thr = getConvictionThreshold(marketKey);
  if (p >= thr) return { code: 'HIGH_UP', label: '고확신 상승 신호', tone: 'teal' };
  if (p <= 1 - thr) return { code: 'HIGH_DOWN', label: '고확신 하락 경계', tone: 'rose' };
  return { code: 'NEUTRAL', label: '중립 · 관망 구간', tone: 'slate' };
}

function predictWithModel(model, rawFeats, vol, marketKey, selectedMeta, horizon) {
  const xNow = rawFeats.map((v, j) =>
    Math.max(-3, Math.min(3, (v - model.means[j]) / model.stds[j]))
  );
  let zNow = model.b;
  const rawTerms = [];
  for (let j = 0; j < xNow.length; j++) {
    const term = model.w[j] * xNow[j];
    rawTerms.push(term);
    zNow += term;
  }
  const rawP = sigmoid(zNow);
  const trust = model.n / (model.n + 60);
  const p = trust * rawP + (1 - trust) * model.baseRate;
  const down = Math.max(0, 1 - p);

  const slope = rawP * (1 - rawP) * trust * 100;
  const meta = selectedMeta || (marketKey === 'NASDAQ' ? FEATURE_META.US : FEATURE_META.KR);
  const contributions = meta.map((m, j) => ({
    key: m.key,
    label: m.label,
    unit: m.unit,
    value: rawFeats[j],
    impactPct: rawTerms[j] * slope
  }));

  const curVol = Math.max(0.35, vol);
  const low = model.qLo * curVol;
  const high = model.qHi * curVol;
  const score = Math.round(p * 100);

  const volRatio = curVol / Math.max(0.35, model.volMedian || 1.2);
  let regime = '보통 변동성';
  let regimeTone = 'slate';
  if (volRatio >= 1.35) {
    regime = '고변동 경계';
    regimeTone = 'rose';
  } else if (volRatio <= 0.75) {
    regime = '저변동 안정';
    regimeTone = 'teal';
  }

  return {
    horizon: horizon || 1,
    n: model.n,
    p,
    down,
    base: model.baseRate,
    score,
    signal: classifySignal(p, marketKey),
    low,
    high,
    gain: model.gain,
    loss: model.loss,
    vol: curVol,
    volRatio,
    regime,
    regimeTone,
    rawFeats: [...rawFeats],
    contributions,
    meta,
    modelRef: model
  };
}

function buildMacroMaps(data) {
  const us = data.NASDAQ || [];
  const soxMap = new Map(data.SOX || []);
  const soxSpreads = new Map();
  for (let i = 1; i < us.length; i++) {
    const [date, , ret] = us[i];
    const prev = soxMap.get(us[i - 1][0]);
    const close = soxMap.get(date);
    if (prev > 0 && close > 0) soxSpreads.set(date, (close / prev - 1) * 100 - ret);
  }
  const kospiRows = data.KOSPI || [];
  const kospiByDate = new Map();
  const kospiDates = [];
  for (let i = 0; i < kospiRows.length; i++) {
    kospiByDate.set(kospiRows[i][0], kospiRows[i][2]);
    kospiDates.push(kospiRows[i][0]);
  }
  return {
    soxSpreads,
    vixMap: new Map(data.VIX || []),
    vix3mMap: new Map(data.VIX3M || []),
    tnxDiff: buildDiffMap(data.TNX || [], false),
    dxyPct: buildDiffMap(data.DXY || [], true),
    oilPct: buildDiffMap(data.CL || [], true),
    goldPct: buildDiffMap(data.GC || [], true),
    daxPct: buildDiffMap(data.DAX || [], true),
    newsMap: new Map(data.NEWS_HIST || []),
    krFutMap: new Map((data.KR_FUT_HIST || []).map(r => [r[0], r[1]])),
    krBasisMap: new Map((data.KR_FUT_HIST || []).map(r => [r[0], r[2]])),
    kospiByDate,
    kospiDates
  };
}

function getCandidateKeys(key, horizon) {
  if (key === 'NASDAQ') {
    return horizon === 5
      ? ['vix', 'vixRatio', 'tnx', 'dxy', 'ret20', 'oil', 'gold']
      : ['krLead', 'krResid', 'vixRatio', 'dax', 'vix', 'tnx', 'dxy', 'news'];
  }
  if (key === 'KOSPI') {
    return horizon === 5
      ? ['sox', 'vix', 'ret20', 'oil', 'gold']
      : ['sox', 'vix', 'usVix', 'flow', 'oil', 'gold', 'krFut', 'krBasis', 'news'];
  }
  return horizon === 5
    ? ['vix', 'ret20', 'oil', 'gold']
    : ['breadth', 'flow', 'vix', 'oil', 'gold', 'krFut', 'news'];
}

function makeExtraRecord(refUsDate, breadth, flow, maps, current, key, nextUsDate) {
  const vixVal = refUsDate ? maps.vixMap.get(refUsDate) : undefined;
  const vix3mVal = refUsDate ? maps.vix3mMap.get(refUsDate) : undefined;
  const vixRatio =
    Number.isFinite(vixVal) && Number.isFinite(vix3mVal) && vix3mVal > 0
      ? vixVal / vix3mVal
      : undefined;
  const usVix =
    Number.isFinite(vixVal) && current && Number.isFinite(current.usRet)
      ? current.usRet * (vixVal / 20)
      : undefined;

  let krLead;
  let krResid;
  let krLeadDate = null;
  if (key === 'NASDAQ' && refUsDate) {
    const kr = findPreUsKoreaSession(refUsDate, nextUsDate, maps);
    if (Number.isFinite(kr.ret)) {
      krLead = kr.ret;
      krResid = current && Number.isFinite(current.ret1) ? kr.ret - 0.55 * current.ret1 : kr.ret;
      krLeadDate = kr.krDate;
    }
  }

  return {
    sox: refUsDate ? maps.soxSpreads.get(refUsDate) : undefined,
    breadth: Number.isFinite(breadth) ? breadth : undefined,
    flow: Number.isFinite(flow) ? flow : undefined,
    vix: vixVal,
    vixRatio,
    tnx: refUsDate ? maps.tnxDiff.get(refUsDate) : undefined,
    dxy: refUsDate ? maps.dxyPct.get(refUsDate) : undefined,
    oil: refUsDate ? maps.oilPct.get(refUsDate) : undefined,
    gold: refUsDate ? maps.goldPct.get(refUsDate) : undefined,
    dax: refUsDate ? maps.daxPct.get(refUsDate) : undefined,
    news: refUsDate ? maps.newsMap.get(refUsDate) : undefined,
    krFut: refUsDate ? maps.krFutMap.get(refUsDate) : undefined,
    krBasis: refUsDate ? maps.krBasisMap.get(refUsDate) : undefined,
    usVix,
    ret20: current ? current.ret20 : undefined,
    krLead,
    krResid,
    _krLeadDate: krLeadDate
  };
}

function selectActiveExtras(candidates, extra, pool) {
  const minRequired = Math.max(MIN_EXTRA_SAMPLES, Math.ceil(pool.length * 0.72));
  const available = candidates.filter(k => Number.isFinite(extra[k]));
  const qualifying = available.filter(k => {
    let cnt = 0;
    for (let i = 0; i < pool.length; i++) if (Number.isFinite(pool[i].extra[k])) cnt++;
    return cnt >= minRequired;
  });
  if (qualifying.length) {
    const jointEligible = pool.filter(row => qualifying.every(k => Number.isFinite(row.extra[k])));
    if (jointEligible.length >= minRequired) {
      return { keys: qualifying, eligible: jointEligible };
    }
    const first = [qualifying[0]];
    const singleEligible = pool.filter(row => Number.isFinite(row.extra[first[0]]));
    return { keys: first, eligible: singleEligible };
  }
  return { keys: [], eligible: pool };
}

function forwardReturn(rows, i, horizon) {
  if (i + horizon >= rows.length) return null;
  if (horizon === 1) return adjacent(rows[i], rows[i + 1]) ? rows[i + 1][2] : null;
  const days = (Date.parse(rows[i + horizon][0]) - Date.parse(rows[i][0])) / 86400000;
  if (days > 14 || !rows[i][1]) return null;
  return (rows[i + horizon][1] / rows[i][1] - 1) * 100;
}

function getModelHyperparams(key, horizon) {
  if (key === 'NASDAQ' && horizon === 1) {
    return { useRecency: false, l2Floor: 55 };
  }
  return { useRecency: horizon === 5 || key === 'KOSPI', l2Floor: 10 };
}

function buildHistories(rows, key, data, horizon) {
  const h = horizon || 1;
  const baseMeta = key === 'NASDAQ' ? FEATURE_META.US : FEATURE_META.KR;
  const candidates = getCandidateKeys(key, h);
  const maps = buildMacroMaps(data);
  const hp = getModelHyperparams(key, h);

  const base = [];
  const enhanced = [];
  const pool = [];
  let prevBaseModel = null;
  let prevExtModel = null;
  let prevExtSig = '';

  const pending = [];

  for (let i = 0; i < rows.length; i++) {
    while (pending.length && pending[0].readyIdx <= i) {
      pool.push(pending.shift().item);
    }

    const [date, , , , breadth, flow] = rows[i];
    const nextUsDate = i + 1 < rows.length ? rows[i + 1][0] : null;
    const current = extractBaseFeatures(rows, i, key, data);
    const refUsDate = key === 'NASDAQ' ? date : current ? current.usDate : null;
    const extra = makeExtraRecord(refUsDate, breadth, flow, maps, current, key, nextUsDate);

    let f = null;
    let g = null;
    if (current && pool.length >= MIN_BASE_SAMPLES) {
      const baseModel = fitLogisticModel(pool, baseMeta.length, prevBaseModel, false, 10);
      prevBaseModel = baseModel;
      f = predictWithModel(baseModel, current.feats, current.vol, key, baseMeta, h);
      g = f;

      const sel = selectActiveExtras(candidates, extra, pool);
      if (sel.keys.length) {
        const isNasdaqLeadOnly = key === 'NASDAQ' && h === 1 && sel.keys.includes('krLead');
        const useFeats = isNasdaqLeadOnly ? [] : current.feats;
        const useMeta = isNasdaqLeadOnly ? [] : baseMeta;
        const training = sel.eligible.map(row => ({
          ...row,
          x: (isNasdaqLeadOnly ? [] : row.x).concat(sel.keys.map(k => row.extra[k]))
        }));
        const meta = useMeta.concat(sel.keys.map(k => EXTRA_META[k]));
        const sig = (isNasdaqLeadOnly ? 'lead:' : 'full:') + sel.keys.join('+');
        const extModel = fitLogisticModel(
          training,
          meta.length,
          sig === prevExtSig ? prevExtModel : null,
          hp.useRecency,
          hp.l2Floor
        );
        prevExtModel = extModel;
        prevExtSig = sig;
        g = predictWithModel(
          extModel,
          useFeats.concat(sel.keys.map(k => extra[k])),
          current.vol,
          key,
          meta,
          h
        );
      } else if (hp.useRecency || hp.l2Floor > 10) {
        const recModel = fitLogisticModel(pool, baseMeta.length, null, hp.useRecency, hp.l2Floor);
        g = predictWithModel(recModel, current.feats, current.vol, key, baseMeta, h);
      }

      g = {
        ...g,
        usDate: refUsDate,
        usSessions: current.usSessions,
        krLeadDate: extra._krLeadDate,
        extra,
        active: sel.keys,
        candidates
      };
    }

    base.push(f);
    enhanced.push(g);

    const y = forwardReturn(rows, i, h);
    if (current && y !== null) {
      pending.push({
        readyIdx: i + h,
        item: { x: current.feats, vol: current.vol, y, up: Number(y > 0), extra }
      });
    }
  }
  return { base, enhanced };
}

function forecastSingleDay(rows, targetIdx, key, data, horizon) {
  const h = horizon || 1;
  const baseMeta = key === 'NASDAQ' ? FEATURE_META.US : FEATURE_META.KR;
  const candidates = getCandidateKeys(key, h);
  const maps = buildMacroMaps(data);
  const hp = getModelHyperparams(key, h);

  const current = extractBaseFeatures(rows, targetIdx, key, data);
  if (!current) return null;

  const pool = [];
  for (let i = 5; i <= targetIdx - h; i++) {
    const f = extractBaseFeatures(rows, i, key, data);
    const y = forwardReturn(rows, i, h);
    if (!f || y === null) continue;
    const [date, , , , breadth, flow] = rows[i];
    const nextUsDate = i + 1 < rows.length ? rows[i + 1][0] : null;
    const refUs = key === 'NASDAQ' ? date : f.usDate;
    pool.push({
      x: f.feats,
      vol: f.vol,
      y,
      up: Number(y > 0),
      extra: makeExtraRecord(refUs, breadth, flow, maps, f, key, nextUsDate)
    });
  }
  if (pool.length < MIN_BASE_SAMPLES) return null;

  const [curDate, , , , curBreadth, curFlow] = rows[targetIdx];
  const nextUsDate = targetIdx + 1 < rows.length ? rows[targetIdx + 1][0] : null;
  const refUsDate = key === 'NASDAQ' ? curDate : current.usDate;
  const extra = makeExtraRecord(refUsDate, curBreadth, curFlow, maps, current, key, nextUsDate);

  const baseModel = fitLogisticModel(pool, baseMeta.length, null, hp.useRecency, hp.l2Floor);
  let g = predictWithModel(baseModel, current.feats, current.vol, key, baseMeta, h);

  const sel = selectActiveExtras(candidates, extra, pool);
  if (sel.keys.length) {
    const isNasdaqLeadOnly = key === 'NASDAQ' && h === 1 && sel.keys.includes('krLead');
    const useFeats = isNasdaqLeadOnly ? [] : current.feats;
    const useMeta = isNasdaqLeadOnly ? [] : baseMeta;
    const training = sel.eligible.map(row => ({
      ...row,
      x: (isNasdaqLeadOnly ? [] : row.x).concat(sel.keys.map(k => row.extra[k]))
    }));
    const meta = useMeta.concat(sel.keys.map(k => EXTRA_META[k]));
    const extModel = fitLogisticModel(training, meta.length, null, hp.useRecency, hp.l2Floor);
    g = predictWithModel(
      extModel,
      useFeats.concat(sel.keys.map(k => extra[k])),
      current.vol,
      key,
      meta,
      h
    );
  }

  return {
    ...g,
    usDate: refUsDate,
    usSessions: current.usSessions,
    krLeadDate: extra._krLeadDate,
    extra,
    active: sel.keys,
    candidates
  };
}

function featuresV1(rows, i) {
  const today = rows[i];
  const prev = rows[i - 1];
  if (!prev || !adjacent(prev, today)) return null;
  const signals = [today[2], prev[2]];
  if (today[3] && prev[3]) signals.push(100 * (today[3] / prev[3] - 1));
  return signals;
}

function forecastV1(rows, end) {
  const now = featuresV1(rows, end);
  if (!now) return null;
  const pool = [];
  for (let i = 1; i < end; i++) {
    const x = featuresV1(rows, i);
    if (x && adjacent(rows[i], rows[i + 1])) pool.push({ x, y: rows[i + 1][2] });
  }
  if (pool.length < MIN_BASE_SAMPLES) return null;
  const scales = now.map((_, j) => {
    const col = pool.map(row => row.x[j]);
    return Math.max(0.05, quantile(col, 0.75) - quantile(col, 0.25));
  });
  for (const row of pool) {
    row.distance = now.reduce((s, v, j) => s + ((v - row.x[j]) / scales[j]) ** 2, 0);
  }
  const k = Math.min(pool.length, Math.max(12, Math.round(2 * Math.sqrt(pool.length))));
  const outcomes = pool.sort((a, b) => a.distance - b.distance).slice(0, k).map(r => r.y);
  const up = outcomes.filter(x => x > 0);
  const down = outcomes.filter(x => x < 0);
  return {
    k,
    p: up.length / k,
    down: down.length / k,
    base: pool.filter(r => r.y > 0).length / pool.length,
    low: quantile(outcomes, 0.1),
    high: quantile(outcomes, 0.9),
    gain: quantile(up, 0.5),
    loss: quantile(down, 0.5)
  };
}

// 실시간 글로벌 뉴스 투심 보정 (과거 60일 이력 축적 전 최신일 전망용, 최대 약 ±4.5%p)
function applyNewsOverlay(forecast, sentimentScore, marketKey, enabled) {
  if (!forecast) return forecast;
  const score = Number.isFinite(sentimentScore) ? Math.max(-100, Math.min(100, sentimentScore)) : 0;
  // 이미 학습 모델에 news가 정식 반영된 경우 중복 보정 방지
  const alreadyLearned = Array.isArray(forecast.active) && forecast.active.includes('news');
  if (!enabled || alreadyLearned || score === 0) {
    return {
      ...forecast,
      pureP: forecast.p,
      newsImpactPct: 0,
      newsApplied: false,
      newsScore: score
    };
  }
  const pClamped = Math.max(0.02, Math.min(0.98, forecast.p));
  const baseLogit = Math.log(pClamped / (1 - pClamped));
  const deltaLogit = (score / 100) * 0.18; // ~±4.5%p at p=0.50, scaled smoothly near extremes
  const adjP = sigmoid(baseLogit + deltaLogit);
  const impactPct = (adjP - forecast.p) * 100;
  return {
    ...forecast,
    pureP: forecast.p,
    p: adjP,
    down: Math.max(0, 1 - adjP),
    score: Math.round(adjP * 100),
    signal: classifySignal(adjP, marketKey),
    newsImpactPct: impactPct,
    newsApplied: true,
    newsScore: score,
    contributions: forecast.contributions.concat([
      {
        key: 'newsOverlay',
        label: '글로벌 뉴스 투심 보정',
        unit: '점',
        value: score,
        impactPct
      }
    ])
  };
}

// 실시간 코스피200 국내선물 보정 (60일 누적 학습 전 최신일 코스피·코스닥 전망용, 최대 약 ±7%p)
function applyKrFuturesOverlay(forecast, krFutPct, krBasis, marketKey, enabled) {
  if (!forecast) return forecast;
  if (marketKey === 'NASDAQ') {
    return { ...forecast, krFutApplied: false, krFutImpactPct: 0, krFutPct: 0 };
  }
  const pct = Number.isFinite(krFutPct) ? Math.max(-6, Math.min(6, krFutPct)) : 0;
  const basis = Number.isFinite(krBasis) ? Math.max(-5, Math.min(5, krBasis)) : 0;
  const alreadyLearned = Array.isArray(forecast.active) && forecast.active.includes('krFut');
  if (!enabled || alreadyLearned || (pct === 0 && basis === 0)) {
    return { ...forecast, krFutApplied: false, krFutImpactPct: 0, krFutPct: pct, krBasis: basis };
  }
  const pClamped = Math.max(0.02, Math.min(0.98, forecast.p));
  const baseLogit = Math.log(pClamped / (1 - pClamped));
  const deltaLogit = Math.max(-0.28, Math.min(0.28, pct * 0.10 + basis * 0.02));
  const adjP = sigmoid(baseLogit + deltaLogit);
  const impactPct = (adjP - forecast.p) * 100;
  return {
    ...forecast,
    p: adjP,
    down: Math.max(0, 1 - adjP),
    score: Math.round(adjP * 100),
    signal: classifySignal(adjP, marketKey),
    krFutApplied: true,
    krFutImpactPct: impactPct,
    krFutPct: pct,
    krBasis: basis,
    contributions: forecast.contributions.concat([
      {
        key: 'krFutOverlay',
        label: '코스피200 선물 보정',
        unit: '%',
        value: pct,
        impactPct
      }
    ])
  };
}

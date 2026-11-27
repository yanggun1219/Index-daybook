// 지수 관측소 v5.5 — 나스닥 한국장 선행 잔차 + 전용 정규화 + VIX3M·DAX 확장 + 1일/5일 듀얼 호라이즌

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

function makeExtraRecord(refUsDate, breadth, flow, maps, current, key, nextUsDate, curDate) {
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
    news: (curDate && maps.newsMap.get(curDate)) ?? (refUsDate ? maps.newsMap.get(refUsDate) : undefined),
    krFut: (curDate && maps.krFutMap.get(curDate)) ?? (refUsDate ? maps.krFutMap.get(refUsDate) : undefined),
    krBasis: (curDate && maps.krBasisMap.get(curDate)) ?? (refUsDate ? maps.krBasisMap.get(refUsDate) : undefined),
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
    const extra = makeExtraRecord(refUsDate, breadth, flow, maps, current, key, nextUsDate, date);

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
      extra: makeExtraRecord(refUs, breadth, flow, maps, f, key, nextUsDate, date)
    });
  }
  if (pool.length < MIN_BASE_SAMPLES) return null;

  const [curDate, , , , curBreadth, curFlow] = rows[targetIdx];
  const nextUsDate = targetIdx + 1 < rows.length ? rows[targetIdx + 1][0] : null;
  const refUsDate = key === 'NASDAQ' ? curDate : current.usDate;
  const extra = makeExtraRecord(refUsDate, curBreadth, curFlow, maps, current, key, nextUsDate, curDate);

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

// ============================================================
// v7.0 개별 종목 업종별 선행지표 기반 실시간 예측 + 워크포워드 검증 엔진
// ============================================================
function fitStockLogistic(X, y, weights, lambda) {
  const n = X.length;
  const d = X[0].length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(1);
  let wSum = 0;
  for (let i = 0; i < n; i++) wSum += weights[i];
  for (let j = 0; j < d; j++) {
    let m = 0;
    for (let i = 0; i < n; i++) m += weights[i] * X[i][j];
    mean[j] = m / (wSum || 1);
    let v = 0;
    for (let i = 0; i < n; i++) v += weights[i] * (X[i][j] - mean[j]) ** 2;
    std[j] = Math.sqrt(v / (wSum || 1)) || 1;
  }

  let b = 0;
  const w = new Array(d).fill(0);
  const lr = 0.12;
  for (let iter = 0; iter < 90; iter++) {
    let gb = 0;
    const gw = new Array(d).fill(0);
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * ((X[i][j] - mean[j]) / std[j]);
      const p = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
      const err = (p - y[i]) * weights[i];
      gb += err;
      for (let j = 0; j < d; j++) gw[j] += err * ((X[i][j] - mean[j]) / std[j]);
    }
    b -= (lr * gb) / (wSum || 1);
    for (let j = 0; j < d; j++) {
      w[j] -= (lr * (gw[j] + (lambda * w[j]) / n)) / (wSum || 1);
    }
  }
  return { b, w, mean, std };
}

function predictStockRow(model, feat) {
  let z = model.b;
  const contribZ = [];
  for (let j = 0; j < feat.length; j++) {
    const cz = model.w[j] * ((feat[j] - model.mean[j]) / model.std[j]);
    z += cz;
    contribZ.push(cz);
  }
  const p = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
  const baseP = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, model.b))));
  const sumZ = contribZ.reduce((s, v) => s + v, 0);
  const scale = Math.abs(sumZ) > 1e-6 ? ((p - baseP) * 100) / sumZ : 0;
  return { p, contribPct: contribZ.map(cz => cz * scale) };
}

function lookupPeerVal(peerRows, targetDate, strictBefore, isLevel) {
  if (!Array.isArray(peerRows) || !peerRows.length) return null;
  let lo = 0;
  let hi = peerRows.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = peerRows[mid][0];
    if (strictBefore ? d < targetDate : d <= targetDate) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (ans < 0) return null;
  return isLevel ? peerRows[ans][1] : peerRows[ans][2];
}

function analyzeIndividualStock(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  if (rows.length < 60) {
    return { error: '분석에 필요한 일봉 데이터가 부족합니다 (최소 60거래일 필요).' };
  }
  const isKr = Boolean(payload.isKr);
  const peers = Array.isArray(payload.peers) ? payload.peers : [];

  const meta = [
    { key: 'ret1', label: '종목 당일 등락률', unit: '%' },
    { key: 'ret5', label: '종목 5일 모멘텀', unit: '%' },
    { key: 'vol10', label: '10일 실현 변동성', unit: '%' }
  ];
  for (const pr of peers) {
    meta.push({
      key: pr.sym,
      label: pr.label,
      unit: pr.isLevel ? (pr.unit || '') : '%',
      isLevel: Boolean(pr.isLevel)
    });
  }

  const samples = [];
  for (let i = 10; i < rows.length; i++) {
    const curDate = rows[i][0];
    const ret1 = rows[i][2];
    const ret5 = rows[i - 5][1] > 0 ? ((rows[i][1] / rows[i - 5][1]) - 1) * 100 : 0;
    const wRets = [];
    for (let k = i - 9; k <= i; k++) wRets.push(rows[k][2]);
    const meanR = wRets.reduce((s, v) => s + v, 0) / wRets.length;
    const vol10 = Math.sqrt(wRets.reduce((s, v) => s + (v - meanR) ** 2, 0) / wRets.length) || 1;

    const feat = [ret1, ret5, vol10];
    let ok = true;
    for (const pr of peers) {
      // 뉴욕 거래일 기준 동일 날짜(d <= curDate) 미국장은 한국장(15:30 KST) 마감 후 ~ 다음날 한국장 개장 전에 마감되므로
      // 다음 거래일 한국 종목 예측의 핵심 야간 선행 신호임 (Zero Lookahead).
      const pv = lookupPeerVal(pr.rows, curDate, false, pr.isLevel);
      if (!Number.isFinite(pv)) {
        ok = false;
        break;
      }
      feat.push(pv);
    }
    if (!ok) continue;

    const nextRet = i + 1 < rows.length && rows[i][1] > 0 ? ((rows[i + 1][1] / rows[i][1]) - 1) * 100 : null;
    samples.push({ idx: i, date: curDate, close: rows[i][1], ret1, vol10, feat, nextRet });
  }

  if (samples.length < 55) {
    return { error: '선행지표와 날짜가 매칭되는 표본이 부족합니다.' };
  }

  const trainAll = samples.filter(s => s.nextRet !== null);
  const latest = samples[samples.length - 1];
  const halfLife = 420;
  const lambda = 95;
  const shrink = 0.72; // 개별 종목 노이즈 과신 방지용 확률 보정 계수

  // 1. 확장 윈도우 워크포워드 백테스트 (5년 표본, 15거래일마다 재학습)
  const warmup = Math.min(180, Math.floor(trainAll.length * 0.35));
  let curModel = null;
  let brierSum = 0;
  let baseBrierSum = 0;
  let covSum = 0;
  let evalN = 0;
  let hiN = 0;
  let hiHit = 0;
  let hiBrierSum = 0;

  for (let t = warmup; t < trainAll.length; t++) {
    if (!curModel || (t - warmup) % 15 === 0) {
      const slice = trainAll.slice(0, t);
      const X = slice.map(s => s.feat);
      const y = slice.map(s => (s.nextRet > 0 ? 1 : 0));
      const w = slice.map((_, k) => Math.pow(0.5, (slice.length - 1 - k) / halfLife));
      curModel = fitStockLogistic(X, y, w, lambda);
    }
    const s = trainAll[t];
    const rawPred = predictStockRow(curModel, s.feat);
    const pred = { p: 0.5 + shrink * (rawPred.p - 0.5), contribPct: rawPred.contribPct.map(v => v * shrink) };
    const actualUp = s.nextRet > 0 ? 1 : 0;
    const upRate = trainAll.slice(0, t).reduce((a, v) => a + (v.nextRet > 0 ? 1 : 0), 0) / t;
    brierSum += (pred.p - actualUp) ** 2;
    baseBrierSum += (upRate - actualUp) ** 2;
    const bandLo = -1.2816 * s.vol10;
    const bandHi = 1.2816 * s.vol10;
    if (s.nextRet >= bandLo && s.nextRet <= bandHi) covSum += 1;
    evalN += 1;
    if (pred.p >= 0.62 || pred.p <= 0.38) {
      hiN += 1;
      if ((pred.p >= 0.5) === (s.nextRet > 0)) hiHit += 1;
      hiBrierSum += (pred.p - actualUp) ** 2;
    }
  }

  // 2. 전체 최신 표본으로 최종 내일 예측 모델 학습
  const Xall = trainAll.map(s => s.feat);
  const yall = trainAll.map(s => (s.nextRet > 0 ? 1 : 0));
  const wall = trainAll.map((_, k) => Math.pow(0.5, (trainAll.length - 1 - k) / halfLife));
  const finalModel = fitStockLogistic(Xall, yall, wall, lambda);
  const rawOut = predictStockRow(finalModel, latest.feat);
  const out = { p: 0.5 + shrink * (rawOut.p - 0.5), contribPct: rawOut.contribPct.map(v => v * shrink) };

  const upRets = trainAll.filter(s => s.nextRet > 0).map(s => s.nextRet).sort((a, b) => a - b);
  const dnRets = trainAll.filter(s => s.nextRet <= 0).map(s => s.nextRet).sort((a, b) => a - b);
  const med = arr => (arr.length ? arr[Math.floor(arr.length / 2)] : 0);
  const gainMed = med(upRets);
  const lossMed = med(dnRets);
  const baseUp = yall.reduce((a, v) => a + v, 0) / (yall.length || 1);

  // 80% 시나리오 밴드 (변동성 기반 + 확률 중심 이동)
  const drift = (out.p - 0.5) * latest.vol10 * 0.6;
  const lowPct = Number((drift - 1.2816 * latest.vol10).toFixed(2));
  const highPct = Number((drift + 1.2816 * latest.vol10).toFixed(2));
  const loPrice = latest.close * (1 + lowPct / 100);
  const hiPrice = latest.close * (1 + highPct / 100);

  const brierModel = evalN ? brierSum / evalN : null;
  const brierBase = evalN ? baseBrierSum / evalN : null;
  const edge = brierModel !== null && brierBase !== null ? brierBase - brierModel : 0;

  let reliability = { label: '중립 (보조 참고)', tone: 'amber', desc: '과거 기준 빈도와 유사한 수준입니다. 종목 공시·수급을 함께 확인하세요.' };
  if (edge > 0.004) {
    reliability = { label: '선행지표 설명력 양호', tone: 'teal', desc: '과거 워크포워드 검증에서 단순 기준 모델보다 우수한 확률 오차를 기록했습니다.' };
  } else if (edge <= -0.003) {
    reliability = { label: '고유 변동성 큼 (공시·수급 주의)', tone: 'rose', desc: '거시·업종 지표보다 실적·공시·수급 영향이 큰 종목입니다. 참고용으로만 보세요.' };
  }

  let signal = { label: '중립 · 관망 구간', tone: 'slate' };
  if (out.p >= 0.62) signal = { label: '고확신 상승 우위', tone: 'teal' };
  else if (out.p <= 0.38) signal = { label: '고확신 하락 경계', tone: 'rose' };

  const contributions = meta
    .map((m, idx) => ({
      key: m.key,
      label: m.label,
      value: latest.feat[idx],
      unit: m.unit,
      isLevel: Boolean(m.isLevel),
      impactPct: out.contribPct[idx] || 0
    }))
    .sort((a, b) => Math.abs(b.impactPct) - Math.abs(a.impactPct));

  return {
    symbol: payload.symbol,
    name: payload.name,
    sector: payload.sector,
    sectorLabel: payload.sectorLabel,
    currency: payload.currency || (isKr ? 'KRW' : 'USD'),
    isKr,
    isLiveIntraday: Boolean(payload.isLiveIntraday),
    updatedKst: payload.updatedKst || '',
    date: latest.date,
    close: latest.close,
    ret1: latest.ret1,
    vol10: latest.vol10,
    p: out.p,
    down: 1 - out.p,
    score: Math.round(out.p * 100),
    base: baseUp,
    lowPct,
    highPct,
    loPrice,
    hiPrice,
    gainMed,
    lossMed,
    signal,
    reliability,
    contributions,
    recentRows: rows.slice(-30),
    perp: payload.perp || null,
    news: Array.isArray(payload.news) ? payload.news : [],
    vol10: Number((latest.vol10 || 2.2).toFixed(2)),
    low: Number((-1.28 * Math.max(0.8, latest.vol10 || 2.2)).toFixed(2)),
    high: Number((1.28 * Math.max(0.8, latest.vol10 || 2.2)).toFixed(2)),
    backtest: {
      n: evalN,
      trainN: trainAll.length,
      brierModel,
      brierBase,
      cov80: evalN ? covSum / evalN : null,
      hiN,
      hiAcc: hiN >= 15 ? hiHit / hiN : null,
      hiBrier: hiN >= 15 ? hiBrierSum / hiN : null
    }
  };
}

function applyStockPerpOverlay(analysis, usePerp) {
  if (!analysis || analysis.error) return analysis;
  const baseP = analysis.p;
  const perp = analysis.perp;
  if (!usePerp || !perp || !Number.isFinite(perp.pct)) {
    return { ...analysis, perpApplied: false, perpImpactPct: 0 };
  }
  const weight = perp.isSectorProxy ? 0.45 : 0.75;
  const cap = perp.isSectorProxy ? 4.0 : 6.0;
  let impact = Math.max(-cap, Math.min(cap, perp.pct * weight));
  // 과열 펀딩비 역방향 완충 (|펀딩비| > 0.05%)
  if (Number.isFinite(perp.funding) && Math.abs(perp.funding) > 0.05) {
    impact += perp.funding > 0 ? -0.45 : 0.45;
  }
  const adjP = Math.max(0.05, Math.min(0.95, baseP + impact / 100));
  let signal = { label: '중립 · 관망 구간', tone: 'slate' };
  if (adjP >= 0.62) signal = { label: '고확신 상승 우위', tone: 'teal' };
  else if (adjP <= 0.38) signal = { label: '고확신 하락 경계', tone: 'rose' };
  return {
    ...analysis,
    p: adjP,
    down: 1 - adjP,
    score: Math.round(adjP * 100),
    signal,
    perpApplied: true,
    perpImpactPct: Number(((adjP - baseP) * 100).toFixed(2))
  };
}

function applyWeekendOilOverlay(forecast, clPct, isWeekend, enabled) {
  if (!forecast || !enabled || !isWeekend || !Number.isFinite(clPct) || Math.abs(clPct) < 1.0) {
    return forecast ? { ...forecast, weekendOilApplied: false, weekendOilImpactPct: 0 } : forecast;
  }
  // 주말 유가 급등은 증시 부담(-), 급락은 안도(+)로 완만하게 반영 (최대 ±3.5%p)
  const impact = Math.max(-3.5, Math.min(3.5, -clPct * 0.45));
  const adjP = Math.max(0.05, Math.min(0.95, forecast.p + impact / 100));
  return {
    ...forecast,
    p: adjP,
    down: 1 - adjP,
    score: Math.round(adjP * 100),
    weekendOilApplied: true,
    weekendOilImpactPct: Number(((adjP - forecast.p) * 100).toFixed(2))
  };
}


// ============================================================
// v8.2 시간대별 시초가(장전 적응형 야간 갭 엔진) / 시초가 대비 종가(장중) 예측
// ============================================================
function isK200DaySessionKst(nowMs) {
  const ms = Number.isFinite(nowMs) ? nowMs : Date.now();
  const kst = new Date(ms + 9 * 3600 * 1000);
  const dow = kst.getUTCDay(); // 0=일, 6=토
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  // 한국 주간 코스피200 선물 유효 시간: 평일 08:45 ~ 15:45 KST
  return dow >= 1 && dow <= 5 && mins >= 8 * 60 + 45 && mins <= 15 * 60 + 45;
}

function isUsCashFreshForKrPreopen(nowMs) {
  const ms = Number.isFinite(nowMs) ? nowMs : Date.now();
  const kst = new Date(ms + 9 * 3600 * 1000);
  const dow = kst.getUTCDay(); // 0=일, 6=토
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const m = kst.getUTCMonth() + 1;
  const usOpenKstMins = (m >= 4 && m <= 10) ? (22 * 60 + 30) : (23 * 60 + 30);
  // 평일 15:30 ~ 미국 개장(22:30/23:30 KST) 사이에는 EWY·^IXIC가 '어젯밤 미국장(이미 오늘 한국장에 반영됨)'이므로 제외!
  if (dow >= 1 && dow <= 5 && mins >= 15 * 60 + 30 && mins < usOpenKstMins) {
    return false;
  }
  return true;
}

function detectSessionPhase(marketKey, nowMs) {
  const ms = Number.isFinite(nowMs) ? nowMs : Date.now();
  const isUs = marketKey === 'NASDAQ' || (typeof marketKey === 'string' && !marketKey.endsWith('.KS') && !marketKey.endsWith('.KQ') && marketKey !== 'KOSPI' && marketKey !== 'KOSDAQ');
  if (!isUs) {
    const kst = new Date(ms + 9 * 3600 * 1000);
    const dow = kst.getUTCDay();
    const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    if (dow >= 1 && dow <= 5 && mins >= 9 * 60 && mins < 15 * 60 + 30) {
      const progress = Math.max(0.05, Math.min(0.95, (mins - 9 * 60) / 390));
      return { phase: 'intraday', progress, label: '장중 · 오늘 종가 예측' };
    }
    return { phase: 'preopen', progress: 0, label: '장전 · 다음 시초가 예측' };
  } else {
    const utc = new Date(ms);
    const m = utc.getUTCMonth() + 1;
    const etOffset = (m >= 4 && m <= 10) ? -4 : -5;
    const et = new Date(ms + etOffset * 3600 * 1000);
    const dow = et.getUTCDay();
    const mins = et.getUTCHours() * 60 + et.getUTCMinutes();
    if (dow >= 1 && dow <= 5 && mins >= 9 * 60 + 30 && mins < 16 * 60) {
      const progress = Math.max(0.05, Math.min(0.95, (mins - 570) / 390));
      return { phase: 'intraday', progress, label: '장중 · 오늘 종가 예측' };
    }
    return { phase: 'preopen', progress: 0, label: '장전 · 다음 시초가 예측' };
  }
}

function computePhaseForecast(baseP, opts) {
  const o = opts || {};
  const phase = o.phase || 'preopen';
  const isUs = Boolean(o.isUs);
  const marketKey = o.marketKey || (isUs ? 'NASDAQ' : 'KOSPI');
  const nowMs = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
  let p = Number.isFinite(baseP) ? baseP : 0.5;
  let expectedShiftPct = 0;
  const factors = [];

  if (phase === 'preopen') {
    // 장전 시초가(갭) 전용 적응형 엔진:
    // 야간 미국장(EWY, NQ=F, ^IXIC, ES=F, 환율)이 크게 움직일수록 어제 종가 관성보다 야간 갭 신호가 압도적으로 주도
    let wSum = 0;
    let sigSum = 0;
    const addSig = (val, weight, label) => {
      if (!Number.isFinite(val)) return;
      sigSum += val * weight;
      wSum += weight;
      factors.push({ label, val: Number(val.toFixed(2)), unit: '%' });
    };

    if (!isUs) {
      const usCashFresh = isUsCashFreshForKrPreopen(nowMs);
      // 1) 미국 개장 전(15:30~23:30 KST)에는 어젯밤 EWY·^IXIC 중복 반영 차단 -> 실시간 NQ=F 선물만 사용
      let usTech = NaN;
      if (usCashFresh && Number.isFinite(o.ixicPct) && Number.isFinite(o.nqPct)) {
        usTech = Math.abs(o.ixicPct) >= Math.abs(o.nqPct) ? o.ixicPct : o.nqPct;
      } else if (usCashFresh && Number.isFinite(o.ixicPct)) {
        usTech = o.ixicPct;
      } else if (Number.isFinite(o.nqPct)) {
        usTech = o.nqPct;
      }

      if (usCashFresh) addSig(o.ewyPct, 0.45, '야간 MSCI 한국(EWY)');
      addSig(usTech, usCashFresh ? 0.35 : 0.45, usCashFresh ? '미국 나스닥 실시간/선물' : '나스닥100 실시간 선물');
      addSig(o.esPct, 0.10, 'S&P500 선물(ES)');
      if (Number.isFinite(o.fxPct)) {
        // 원/달러 환율 하락(-)은 원화 강세(호재 +), 상승(+)은 원화 약세(악재 -)
        addSig(-o.fxPct * 1.2, 0.10, '원/달러 환율(역방향)');
      }
      // 주간 K200 선물은 오직 08:45~15:45 KST 장전 동시호가/장중일 때만 유효 (야간엔 낡은 전일 종가 차단!)
      if (isK200DaySessionKst(nowMs) && Number.isFinite(o.k200Pct)) {
        addSig(o.k200Pct, 0.55, '장전 코스피200 선물');
      }
      if (usCashFresh && Number.isFinite(o.peerAvgPct)) {
        addSig(o.peerAvgPct, 0.65, '업종 핵심 피어(SOX·NVDA 등)');
      }
      if (Number.isFinite(o.nxtPrePct)) {
        addSig(o.nxtPrePct, 1.50, 'NXT 프리장 실시간');
      }
      if (Number.isFinite(o.perpPct)) {
        addSig(o.perpPct, 0.55, '24H 무기한 선물');
      }
    } else {
      addSig(o.nqPct, 0.70, '나스닥100 선물(NQ)');
      addSig(o.esPct, 0.25, 'S&P500 선물(ES)');
      if (Number.isFinite(o.perpPct)) {
        addSig(o.perpPct, 0.55, '24H 무기한 선물');
      }
    }

    if (wSum > 0) {
      const overnightSignal = sigSum / wSum; // 가중 평균 야간 등락률(%)
      if (o.isStock) {
        // 개별 종목: 업종별 야간 민감도(베타)와 최대 비중을 차등 적용해 종목 고유 모델(5년 학습) 개성 보존
        const sec = o.sector || 'general';
        const secCfg = {
          semi:      { maxW: 0.82, beta: 0.95 },
          us_semi:   { maxW: 0.84, beta: 0.98 },
          us_tech:   { maxW: 0.78, beta: 0.90 },
          us_crypto: { maxW: 0.84, beta: 0.98 },
          tech:      { maxW: 0.72, beta: 0.82 },
          battery:   { maxW: 0.72, beta: 0.82 },
          us_ev:     { maxW: 0.80, beta: 0.92 },
          auto:      { maxW: 0.62, beta: 0.68 },
          ship:      { maxW: 0.58, beta: 0.62 },
          bio:       { maxW: 0.54, beta: 0.55 },
          us_bio:    { maxW: 0.68, beta: 0.78 },
          fin:       { maxW: 0.52, beta: 0.52 },
          us_fin:    { maxW: 0.68, beta: 0.78 },
          us_energy: { maxW: 0.74, beta: 0.85 },
          us_ind:    { maxW: 0.66, beta: 0.75 },
          general:   { maxW: 0.58, beta: 0.62 }
        }[sec] || { maxW: 0.58, beta: 0.62 };
        const hasNxtPre = !isUs && Number.isFinite(o.nxtPrePct);
        if (hasNxtPre) {
          const pOvernight = sigmoid(overnightSignal * 0.95);
          const wOvernight = Math.min(0.92, 0.55 + 0.25 * Math.abs(overnightSignal));
          p = wOvernight * pOvernight + (1 - wOvernight) * p;
          expectedShiftPct = Math.max(-15, Math.min(15, o.nxtPrePct * 0.72 + overnightSignal * secCfg.beta * 0.25));
        } else {
          const pOvernight = sigmoid(overnightSignal * 0.90 * secCfg.beta);
          const wOvernight = Math.min(secCfg.maxW, 0.24 + 0.22 * Math.abs(overnightSignal));
          p = wOvernight * pOvernight + (1 - wOvernight) * p;
          expectedShiftPct = Math.max(-9, Math.min(9, overnightSignal * secCfg.beta * 0.75));
        }
      } else {
        const pOvernight = sigmoid(overnightSignal * 0.95);
        // 지수: 조용한 밤(|sig|<0.3%)엔 기존 모델 60~65% 유지, 급등락 밤엔 야간 갭 신호 최대 88% 주도
        const wOvernight = Math.min(0.88, 0.35 + 0.28 * Math.abs(overnightSignal));
        p = wOvernight * pOvernight + (1 - wOvernight) * p;
        expectedShiftPct = Math.max(-6, Math.min(6, overnightSignal * 0.65));
      }
    }
  } else {
    // 장중 시초가 대비 종가(양봉/음봉) 예측
    const curPrice = o.curPrice;
    const todayOpen = o.todayOpen;
    const progress = Number.isFinite(o.progress) ? Math.max(0.05, Math.min(0.95, o.progress)) : 0.45;
    const dailyVol = Number.isFinite(o.vol) && o.vol > 0.2 ? o.vol : 1.3;
    if (Number.isFinite(curPrice) && Number.isFinite(todayOpen) && todayOpen > 0) {
      const openDiffPct = ((curPrice / todayOpen) - 1) * 100;
      const remVol = Math.max(0.25, dailyVol * Math.sqrt(Math.max(0.08, 1 - progress)));
      const pFromOpen = sigmoid((openDiffPct / remVol) * 1.35);
      const wOpen = 0.35 + 0.55 * progress;
      p = wOpen * pFromOpen + (1 - wOpen) * p;
      factors.push({ label: '현재 시가 대비 위치', val: Number(openDiffPct.toFixed(2)), unit: '%' });
      expectedShiftPct = openDiffPct;
    }
    // 장중 실시간 외국인 + 기관 수급 반영
    const inv = o.investor;
    if (inv && typeof inv === 'object') {
      let flowLogit = 0;
      if (Number.isFinite(inv.frgn) || Number.isFinite(inv.orgn)) {
        const net = (Number(inv.frgn) || 0) + (Number(inv.orgn) || 0);
        const scaleEok = marketKey === 'KOSDAQ' ? 1000 : 3000;
        flowLogit = Math.max(-0.55, Math.min(0.55, (net / scaleEok) * 0.40));
        if (Math.abs(net) >= 50) factors.push({ label: '장중 외인+기관 수급', val: net, unit: '억' });
      } else if (Number.isFinite(inv.frgnQty) || Number.isFinite(inv.orgnQty)) {
        const netQ = (Number(inv.frgnQty) || 0) + (Number(inv.orgnQty) || 0);
        if (netQ !== 0) {
          flowLogit = Math.max(-0.35, Math.min(0.35, Math.sign(netQ) * Math.min(0.35, Math.log10(Math.abs(netQ) + 10) * 0.07)));
          factors.push({ label: '장중 외인+기관 추정', val: netQ, unit: '주' });
        }
      }
      if (flowLogit !== 0) {
        const pc = Math.max(0.03, Math.min(0.97, p));
        p = sigmoid(Math.log(pc / (1 - pc)) + flowLogit);
      }
    }
    // 코스피200 외국인 선물 수급 (지수 및 국내 대형주 선행 반영)
    if (!isUs && Number.isFinite(o.futFrgnEok) && Math.abs(o.futFrgnEok) >= 300) {
      const futWeight = o.isStock ? 0.24 : 0.38;
      const futLogit = Math.max(-0.42, Math.min(0.42, (o.futFrgnEok / 3000) * futWeight));
      const pc = Math.max(0.03, Math.min(0.97, p));
      p = sigmoid(Math.log(pc / (1 - pc)) + futLogit);
      factors.push({ label: '외국인 코스피200 선물', val: Math.round(o.futFrgnEok), unit: '억' });
    }
    // 삼성전자·SK하이닉스 단일종목 2X 레버리지 괴리/장막판 리밸런싱 압력 보조 점수
    if (o.isStock && o.levEtf && Number.isFinite(o.levEtf.scoreDelta) && o.levEtf.scoreDelta !== 0) {
      const levLogit = Math.max(-0.20, Math.min(0.20, o.levEtf.scoreDelta));
      const pc = Math.max(0.03, Math.min(0.97, p));
      p = sigmoid(Math.log(pc / (1 - pc)) + levLogit);
      factors.push({ label: o.levEtf.name || '단일종목 2X ETF', val: o.levEtf.disparityPct, unit: '%괴리' });
    }
  }

  p = Math.max(0.04, Math.min(0.96, p));
  const thr = marketKey === 'NASDAQ' ? 0.58 : 0.60;
  let dir = 'flat';
  if (p >= thr) dir = 'up';
  else if (p <= 1 - thr) dir = 'down';

  const dirScore = Math.max(-100, Math.min(100, Math.round((p - 0.5) * 200)));
  const headlinePrefix = phase === 'preopen' ? '시초가는' : '시초가 대비';
  const subLabel = phase === 'preopen' ? '다음 거래일 시초가 방향' : '오늘 종가(시가 대비) 방향';
  const shortBadge = dir === 'up' ? '상승 예정' : dir === 'down' ? '하락 예정' : '관망 구간';

  return {
    phase,
    p,
    dir,
    dirScore,
    expectedShiftPct: Number(expectedShiftPct.toFixed(2)),
    subLabel,
    headlinePrefix,
    shortBadge,
    factors
  };
}

// 지수 관측소 v3.1 — 워크포워드 정규화 로지스틱 + 변동성 보정 밴드 + 소표본 과적합 방지 게이트
// v3 대비 개선: (1) 추가 변수 최소 60거래일·표본 손실 25% 제한 게이트, (2) 한국 휴장 기간 미국장 누적 등락 반영,
// (3) 나스닥 매크로 변수(VIX·미 국채 10년물·DXY) 지원, (4) 변동성 레짐 진단 추가.

const MIN_BASE_SAMPLES = 18;
const MIN_EXTRA_SAMPLES = 60;

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
  tnx: { key: 'tnx', label: '미 국채 10년물 일간 변화', unit: '%p', min: -0.4, max: 0.4, step: 0.01 },
  dxy: { key: 'dxy', label: '달러 인덱스(DXY) 변화', unit: '%', min: -3, max: 3, step: 0.05 }
};

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

// 한국 휴장 기간 중 미국장이 여러 날 열렸을 때 누적 수익률을 계산 (단일일이면 해당 일 등락률)
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

function extractBaseFeatures(rows, i, marketKey, allMarkets) {
  if (i < 5) return null;
  const today = rows[i];
  const prev = rows[i - 1];
  if (!prev || !adjacent(prev, today)) return null;

  const ret5 = rows[i - 5][1] ? (today[1] / rows[i - 5][1] - 1) * 100 : 0;
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
  return { feats, vol: vol10, usDate: usInfo.usDate, usSessions: usInfo.sessions };
}

function fitLogisticModel(pool, d, warm) {
  const n = pool.length;
  let upSum = 0;
  for (let i = 0; i < n; i++) upSum += pool[i].up;
  const baseRate = upSum / n;
  const means = new Array(d);
  const stds = new Array(d);
  for (let j = 0; j < d; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += pool[i].x[j];
    const mean = s / n;
    let v = 0;
    for (let i = 0; i < n; i++) {
      const diff = pool[i].x[j] - mean;
      v += diff * diff;
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

  const lambda = Math.max(8, (250 / Math.sqrt(n)) * Math.sqrt(d / 6));
  const clampedBase = Math.max(0.05, Math.min(0.95, baseRate));
  const useWarm = warm && warm.w && warm.w.length === d;
  let b = useWarm ? warm.b : Math.log(clampedBase / (1 - clampedBase));
  const w = useWarm ? [...warm.w] : new Array(d).fill(0);
  const lr = 0.08;
  const iters = useWarm ? 14 : 120;

  for (let iter = 0; iter < iters; iter++) {
    let gb = 0;
    const gw = new Array(d).fill(0);
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const err = sigmoid(z) - pool[i].up;
      gb += err;
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
    }
    b -= lr * (gb / n);
    for (let j = 0; j < d; j++) {
      w[j] -= lr * (gw[j] / n + (lambda / n) * w[j]);
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

function predictWithModel(model, rawFeats, vol, marketKey, selectedMeta) {
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
    n: model.n,
    p,
    down,
    base: model.baseRate,
    score,
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

function buildHistories(rows, key, data) {
  const baseMeta = key === 'NASDAQ' ? FEATURE_META.US : FEATURE_META.KR;
  const candidates =
    key === 'NASDAQ'
      ? ['vix', 'tnx', 'dxy']
      : [key === 'KOSPI' ? 'sox' : 'breadth', 'flow', 'vix'];

  const us = data.NASDAQ || [];
  const soxMap = new Map(data.SOX || []);
  const vixMap = new Map(data.VIX || []);
  const tnxDiff = buildDiffMap(data.TNX || [], false);
  const dxyPct = buildDiffMap(data.DXY || [], true);

  const soxSpreads = new Map();
  for (let i = 1; i < us.length; i++) {
    const [date, , ret] = us[i];
    const prev = soxMap.get(us[i - 1][0]);
    const close = soxMap.get(date);
    if (prev > 0 && close > 0) soxSpreads.set(date, (close / prev - 1) * 100 - ret);
  }

  const base = [];
  const enhanced = [];
  const pool = [];
  let prevBaseModel = null;
  let prevExtModel = null;
  let prevExtSig = '';

  for (let i = 0; i < rows.length; i++) {
    const [date, , , , breadth, flow] = rows[i];
    const current = extractBaseFeatures(rows, i, key, data);
    const refUsDate = key === 'NASDAQ' ? date : current ? current.usDate : null;
    const extra = {
      sox: refUsDate ? soxSpreads.get(refUsDate) : undefined,
      breadth: Number.isFinite(breadth) ? breadth : undefined,
      flow: Number.isFinite(flow) ? flow : undefined,
      vix: refUsDate ? vixMap.get(refUsDate) : undefined,
      tnx: refUsDate ? tnxDiff.get(refUsDate) : undefined,
      dxy: refUsDate ? dxyPct.get(refUsDate) : undefined
    };

    let f = null;
    let g = null;
    if (current && pool.length >= MIN_BASE_SAMPLES) {
      const baseModel = fitLogisticModel(pool, baseMeta.length, prevBaseModel);
      prevBaseModel = baseModel;
      f = predictWithModel(baseModel, current.feats, current.vol, key, baseMeta);
      g = f;

      // 소표본 과적합 방지 게이트: 추가 변수는 최소 60거래일 이상 + 전체 표본의 75% 이상 유지될 때만 활성화
      const minRequired = Math.max(MIN_EXTRA_SAMPLES, Math.ceil(pool.length * 0.75));
      const available = candidates.filter(k => Number.isFinite(extra[k]));
      const subsets = [];
      if (available.length >= 2) subsets.push(available);
      for (const k of available) subsets.push([k]);

      let activeKeys = [];
      let blockedReason = '';
      for (const keys of subsets) {
        const eligible = pool.filter(row => keys.every(k => Number.isFinite(row.extra[k])));
        if (eligible.length < minRequired) {
          if (!blockedReason) {
            blockedReason =
              '추가 변수 표본(' +
              eligible.length +
              '일)이 최소 기준(' +
              minRequired +
              '일) 미만이어서 과적합 방지를 위해 기본 v2 보정 모델을 유지했습니다.';
          }
          continue;
        }
        const training = eligible.map(row => ({
          ...row,
          x: row.x.concat(keys.map(k => row.extra[k]))
        }));
        const meta = baseMeta.concat(keys.map(k => EXTRA_META[k]));
        const sig = keys.join('+');
        const extModel = fitLogisticModel(training, meta.length, sig === prevExtSig ? prevExtModel : null);
        prevExtModel = extModel;
        prevExtSig = sig;
        g = predictWithModel(
          extModel,
          current.feats.concat(keys.map(k => extra[k])),
          current.vol,
          key,
          meta
        );
        activeKeys = keys;
        blockedReason = '';
        break;
      }

      g = {
        ...g,
        usDate: refUsDate,
        usSessions: current.usSessions,
        extra,
        active: activeKeys,
        candidates,
        blockedReason
      };
    }

    base.push(f);
    enhanced.push(g);

    if (current && adjacent(rows[i], rows[i + 1])) {
      const y = rows[i + 1][2];
      pool.push({ x: current.feats, vol: current.vol, y, up: Number(y > 0), extra });
    }
  }
  return { base, enhanced };
}

// 비교 검증용: 기존 ChatGPT v1 k-NN 모델 (동일 데이터 공정 비교)
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


// 단일 기준일 즉시 추론 (<10ms, 모바일 초기 로딩 및 날짜 전환 최적화)
function forecastSingleDay(rows, targetIdx, key, data) {
  const baseMeta = key === 'NASDAQ' ? FEATURE_META.US : FEATURE_META.KR;
  const candidates =
    key === 'NASDAQ'
      ? ['vix', 'tnx', 'dxy']
      : [key === 'KOSPI' ? 'sox' : 'breadth', 'flow', 'vix'];

  const us = data.NASDAQ || [];
  const soxMap = new Map(data.SOX || []);
  const vixMap = new Map(data.VIX || []);
  const tnxDiff = buildDiffMap(data.TNX || [], false);
  const dxyPct = buildDiffMap(data.DXY || [], true);

  const soxSpreads = new Map();
  for (let i = 1; i < us.length; i++) {
    const [date, , ret] = us[i];
    const prev = soxMap.get(us[i - 1][0]);
    const close = soxMap.get(date);
    if (prev > 0 && close > 0) soxSpreads.set(date, (close / prev - 1) * 100 - ret);
  }

  const current = extractBaseFeatures(rows, targetIdx, key, data);
  if (!current) return null;

  const pool = [];
  for (let i = 5; i < targetIdx; i++) {
    const f = extractBaseFeatures(rows, i, key, data);
    if (!f || !adjacent(rows[i], rows[i + 1])) continue;
    const [date, , , , breadth, flow] = rows[i];
    const refUs = key === 'NASDAQ' ? date : f.usDate;
    const y = rows[i + 1][2];
    pool.push({
      x: f.feats,
      vol: f.vol,
      y,
      up: Number(y > 0),
      extra: {
        sox: refUs ? soxSpreads.get(refUs) : undefined,
        breadth: Number.isFinite(breadth) ? breadth : undefined,
        flow: Number.isFinite(flow) ? flow : undefined,
        vix: refUs ? vixMap.get(refUs) : undefined,
        tnx: refUs ? tnxDiff.get(refUs) : undefined,
        dxy: refUs ? dxyPct.get(refUs) : undefined
      }
    });
  }
  if (pool.length < MIN_BASE_SAMPLES) return null;

  const [curDate, , , , curBreadth, curFlow] = rows[targetIdx];
  const refUsDate = key === 'NASDAQ' ? curDate : current.usDate;
  const extra = {
    sox: refUsDate ? soxSpreads.get(refUsDate) : undefined,
    breadth: Number.isFinite(curBreadth) ? curBreadth : undefined,
    flow: Number.isFinite(curFlow) ? curFlow : undefined,
    vix: refUsDate ? vixMap.get(refUsDate) : undefined,
    tnx: refUsDate ? tnxDiff.get(refUsDate) : undefined,
    dxy: refUsDate ? dxyPct.get(refUsDate) : undefined
  };

  const baseModel = fitLogisticModel(pool, baseMeta.length);
  let g = predictWithModel(baseModel, current.feats, current.vol, key, baseMeta);

  const minRequired = Math.max(MIN_EXTRA_SAMPLES, Math.ceil(pool.length * 0.75));
  const available = candidates.filter(k => Number.isFinite(extra[k]));
  const subsets = [];
  if (available.length >= 2) subsets.push(available);
  for (const k of available) subsets.push([k]);

  let activeKeys = [];
  let blockedReason = '';
  for (const keys of subsets) {
    const eligible = pool.filter(row => keys.every(k => Number.isFinite(row.extra[k])));
    if (eligible.length < minRequired) {
      if (!blockedReason) {
        blockedReason =
          '추가 변수 표본(' +
          eligible.length +
          '일)이 최소 기준(' +
          minRequired +
          '일) 미만이어서 과적합 방지를 위해 기본 v2 보정 모델을 유지했습니다.';
      }
      continue;
    }
    const training = eligible.map(row => ({
      ...row,
      x: row.x.concat(keys.map(k => row.extra[k]))
    }));
    const meta = baseMeta.concat(keys.map(k => EXTRA_META[k]));
    const extModel = fitLogisticModel(training, meta.length);
    g = predictWithModel(
      extModel,
      current.feats.concat(keys.map(k => extra[k])),
      current.vol,
      key,
      meta
    );
    activeKeys = keys;
    blockedReason = '';
    break;
  }

  return {
    ...g,
    usDate: refUsDate,
    usSessions: current.usSessions,
    extra,
    active: activeKeys,
    candidates,
    blockedReason
  };
}

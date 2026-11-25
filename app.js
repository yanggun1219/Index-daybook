// 지수 관측소 v8.0 — 소프트 파스텔 미니멀 UI + 시간대별 시초가/종가 전용 예측 + 봉 차트 + 상세 서랍

const DEFAULT_WORKER_URL = 'https://index-daybook-live.yanggun1219.workers.dev';
const MARKET_LABELS = { KOSPI: '코스피', KOSDAQ: '코스닥', NASDAQ: '나스닥 종합' };
const STOCK_PRESETS = [
  'SK하이닉스', '삼성전자', 'LG에너지솔루션', '현대차',
  'HD현대중공업', '셀트리온', 'KB금융', 'NAVER', '엔비디아', '테슬라'
];

function safeRead(key, fallback) {
  try {
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem(key);
      if (v !== null && v !== '') return v;
    }
  } catch (_) {}
  return fallback;
}

function safeWrite(key, val) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, val);
  } catch (_) {}
}

const state = {
  marketsData: typeof markets !== 'undefined' ? JSON.parse(JSON.stringify(markets)) : { KOSPI: [], KOSDAQ: [], NASDAQ: [] },
  tab: 'KOSPI', // KOSPI | KOSDAQ | NASDAQ | STOCK
  dark: safeRead('daybook_v8_theme', 'light') === 'dark',
  chartType: safeRead('daybook_v8_chart', 'candle'), // candle | line
  phaseOverride: null, // null (auto) | 'preopen' | 'intraday'
  drawerOpen: false,
  drawerTab: 'metrics', // metrics | news | sim | verify
  workerUrl: safeRead('daybook_worker_url', DEFAULT_WORKER_URL),
  liveUpdatedKst: '',
  liveIndices: {},
  liveInvestors: {},
  liveCandles: {},
  intradayTrail: {},
  currentForecast: null,
  currentPhaseResult: null,
  simValues: [],
  historyCache: {},
  // Stock observatory state
  stockQuery: safeRead('daybook_v8_stock', 'SK하이닉스'),
  stockLoading: false,
  stockReqSeq: 0,
  stockAbortCtrl: null,
  stockError: '',
  stockPayload: null,
  stockAnalysis: null,
  stockPhaseResult: null,
  scoreDeltas: {},
  lastTrendHist: {},
  autoLive: safeRead('daybook_v9_autolive', '1') === '1',
  lastTickPrice: null
};

function getScoreHistory(scoreKey) {
  try {
    const raw = safeRead('daybook_v8_score_hist', '{}');
    const store = JSON.parse(raw) || {};
    return Array.isArray(store[scoreKey]) ? store[scoreKey] : [];
  } catch (_) { return []; }
}

function recordScoreDelta(scoreKey, newScore) {
  if (!Number.isFinite(newScore)) return null;
  let store = {};
  try {
    const raw = safeRead('daybook_v8_prev_scores', '{}');
    store = JSON.parse(raw) || {};
  } catch (_) { store = {}; }
  const prev = Number.isFinite(Number(store[scoreKey])) ? Number(store[scoreKey]) : null;
  const delta = prev !== null ? newScore - prev : null;
  if (delta !== null && delta !== 0) {
    state.scoreDeltas[scoreKey] = delta;
  } else if (state.scoreDeltas[scoreKey] === undefined) {
    state.scoreDeltas[scoreKey] = delta;
  }
  store[scoreKey] = newScore;
  try { safeWrite('daybook_v8_prev_scores', JSON.stringify(store)); } catch (_) {}

  // Append to recent 10-point score history (dedup if unchanged within 10 min)
  try {
    const rawH = safeRead('daybook_v8_score_hist', '{}');
    const hStore = JSON.parse(rawH) || {};
    const list = Array.isArray(hStore[scoreKey]) ? hStore[scoreKey] : [];
    const now = Date.now();
    const last = list.length ? list[list.length - 1] : null;
    if (!last || last.s !== newScore || (now - (last.t || 0)) >= 10 * 60 * 1000) {
      list.push({ t: now, s: newScore });
      hStore[scoreKey] = list.slice(-10);
      safeWrite('daybook_v8_score_hist', JSON.stringify(hStore));
    }
  } catch (_) {}
  return state.scoreDeltas[scoreKey];
}

function renderScoreTrend(scoreKey, currentScore, c) {
  const row = document.getElementById('score-trend-row');
  const lbl = document.getElementById('score-trend-label');
  const svg = document.getElementById('score-trend-svg');
  if (!row || !lbl || !svg) return;
  row.style.borderColor = state.dark ? 'rgba(255,255,255,0.07)' : 'rgba(15,23,42,0.07)';

  // 1순위: 서버 30분봉(최근 5시간) 실제 시세 궤적으로 방향 점수 흐름 재현
  let hist = [];
  const trail = state.intradayTrail || {};
  const isStock = state.tab === 'STOCK';
  const baseP = isStock
    ? (state.stockAnalysis ? state.stockAnalysis.p : 0.5)
    : (state.currentForecast ? state.currentForecast.p : 0.5);
  const pr = isStock ? state.stockPhaseResult : state.currentPhaseResult;
  const phase = pr ? pr.phase : 'preopen';
  const isUs = isStock ? (state.stockPayload && !state.stockPayload.isKr) : (state.tab === 'NASDAQ');

  if (phase === 'preopen') {
    const nqArr = Array.isArray(trail.NQ) ? trail.NQ : [];
    const ewyArr = Array.isArray(trail.EWY) ? trail.EWY : [];
    const len = isUs ? nqArr.length : Math.max(nqArr.length, ewyArr.length);
    if (len >= 2 && typeof computePhaseForecast === 'function') {
      for (let k = 0; k < len; k++) {
        const nqV = nqArr.length ? nqArr[Math.min(nqArr.length - 1, Math.floor((k / len) * nqArr.length))] : NaN;
        const ewyV = ewyArr.length ? ewyArr[Math.min(ewyArr.length - 1, Math.floor((k / len) * ewyArr.length))] : NaN;
        const sim = computePhaseForecast(baseP, {
          phase: 'preopen',
          isUs,
          isStock,
          sector: isStock && state.stockPayload ? state.stockPayload.sector : undefined,
          marketKey: isUs ? 'NASDAQ' : 'KOSPI',
          nqPct: nqV,
          ewyPct: ewyV
        });
        hist.push(sim.dirScore);
      }
      if (Number.isFinite(currentScore)) hist[hist.length - 1] = currentScore;
    }
  } else {
    const ksArr = Array.isArray(trail.KOSPI) ? trail.KOSPI : [];
    if (!isUs && !isStock && ksArr.length >= 2) {
      const firstV = ksArr[0];
      for (let k = 0; k < ksArr.length; k++) {
        const rel = ksArr[k] - firstV;
        const prog = 0.1 + 0.8 * (k / Math.max(1, ksArr.length - 1));
        const pOpen = sigmoid((rel / 1.2) * 1.35);
        const pMix = (0.35 + 0.55 * prog) * pOpen + (1 - (0.35 + 0.55 * prog)) * baseP;
        hist.push(Math.max(-100, Math.min(100, Math.round((pMix - 0.5) * 200))));
      }
      if (Number.isFinite(currentScore)) hist[hist.length - 1] = currentScore;
    }
  }

  // 2순위 폴백: 로컬 스냅샷 누적 기록
  if (hist.length < 2) {
    hist = getScoreHistory(scoreKey).map(x => Number(x.s)).filter(Number.isFinite);
    if (!hist.length && Number.isFinite(currentScore)) hist.push(currentScore);
  }
  hist = hist.slice(-10);
  if (hist.length) state.lastTrendHist[scoreKey] = hist.slice();
  if (!hist.length) {
    lbl.textContent = '기록 대기';
    lbl.style.color = c.muted;
    svg.innerHTML = '';
    return;
  }

  // Compute trend label from recent movement
  let trendText = '첫 기록 저장됨';
  let trendCol = c.muted;
  if (hist.length >= 2) {
    const first = hist[Math.max(0, hist.length - 4)];
    const last = hist[hist.length - 1];
    const diff = last - first;
    if (diff >= 6) { trendText = '상승 힘 강화 ↗'; trendCol = c.up; }
    else if (diff > 0) { trendText = '완만히 상승 ↗'; trendCol = c.up; }
    else if (diff <= -6) { trendText = '하락 압력 확대 ↘'; trendCol = c.down; }
    else if (diff < 0) { trendText = '완만히 하락 ↘'; trendCol = c.down; }
    else { trendText = '흐름 유지 →'; trendCol = c.flat; }
  }
  lbl.textContent = trendText;
  lbl.style.color = trendCol;

  // Draw 0-centered mini bars (up to 10 slots, right-aligned so latest is always rightmost)
  const W = 210, H = 36, midY = 18;
  const slots = 10;
  const step = W / slots;
  const barW = 12;
  const baseCol = state.dark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.16)';
  let html = `<line x1="0" y1="${midY}" x2="${W}" y2="${midY}" stroke="${baseCol}" stroke-width="1" stroke-dasharray="3 3" />`;

  const offset = slots - hist.length;
  hist.forEach((sc, idx) => {
    const slotIdx = offset + idx;
    const x = slotIdx * step + (step - barW) / 2;
    const mag = Math.max(3, (Math.abs(sc) / 100) * (midY - 3));
    const y = sc >= 0 ? midY - mag : midY;
    const isLatest = idx === hist.length - 1;
    const col = sc > 0 ? c.up : sc < 0 ? c.down : c.flat;
    const op = isLatest ? '1' : (0.38 + 0.45 * (idx / Math.max(1, hist.length - 1))).toFixed(2);
    html += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${mag.toFixed(1)}" rx="3" fill="${col}" opacity="${op}" />`;
    if (isLatest) {
      const dotY = sc >= 0 ? y - 1 : y + mag + 1;
      html += `<circle cx="${(x + barW / 2).toFixed(1)}" cy="${Math.max(3, Math.min(H - 3, dotY)).toFixed(1)}" r="2.8" fill="${col}" />`;
    }
  });
  svg.innerHTML = html;
}

let toastTimer = null;
function showToast(msg, isErr) {
  const el = document.getElementById('toast-box');
  if (!el) return;
  el.textContent = msg;
  el.style.backgroundColor = isErr ? '#E11D48' : (state.dark ? '#F8FAFC' : '#111827');
  el.style.color = isErr ? '#FFFFFF' : (state.dark ? '#0F172A' : '#FFFFFF');
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function getColors() {
  const d = state.dark;
  return {
    up: d ? '#FF5A6E' : '#E11D48',
    down: d ? '#4DA3FF' : '#2563EB',
    flat: d ? '#94A3B8' : '#64748B',
    bg: d ? '#11141B' : '#F4F6F8',
    card: d ? '#191D26' : '#FFFFFF',
    tile: d ? '#222734' : '#F8FAFC',
    border: d ? '#262C3A' : '#E5E7EB',
    text: d ? '#F8FAFC' : '#111827',
    muted: d ? '#94A3B8' : '#64748B'
  };
}

function getBrandSvg() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <rect x="4" y="10" width="4" height="10" rx="1.5" fill="#FFFFFF" opacity="0.55"/>
    <rect x="10" y="6" width="4" height="14" rx="1.5" fill="#FFFFFF" opacity="0.8"/>
    <rect x="16" y="3" width="4" height="17" rx="1.5" fill="#FFFFFF"/>
  </svg>`;
}

function getSignalSvg(dir, color) {
  if (dir === 'up') {
    return `<svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <path d="M5 16L10.5 10.5L14 14L19.5 7.5" stroke="${color}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M14.5 7.5H19.5V12.5" stroke="${color}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }
  if (dir === 'down') {
    return `<svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <path d="M5 8L10.5 13.5L14 10L19.5 16.5" stroke="${color}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M14.5 16.5H19.5V11.5" stroke="${color}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }
  return `<svg width="26" height="26" viewBox="0 0 24 24" fill="none">
    <path d="M4.5 12H19.5" stroke="${color}" stroke-width="2.8" stroke-linecap="round"/>
    <circle cx="12" cy="12" r="3.5" fill="${color}"/>
  </svg>`;
}

function fmtNum(v, decimals) {
  if (!Number.isFinite(v)) return '-';
  return v.toLocaleString('ko-KR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtSigned(v, suffix) {
  if (!Number.isFinite(v)) return '-';
  return (v > 0 ? '+' : '') + v.toFixed(2) + (suffix || '%');
}

function computeActiveIndex() {
  const key = state.tab;
  const rows = state.marketsData[key] || [];
  let lv = -1;
  for (let i = 24; i < rows.length; i++) {
    if (adjacent(rows[i - 1], rows[i])) lv = i;
  }
  if (lv < 0) {
    state.currentForecast = null;
    state.currentPhaseResult = null;
    return;
  }

  let f = forecastSingleDay(rows, lv, key, state.marketsData, 1);
  const newsObj = state.marketsData.NEWS || {};
  const futObj = state.marketsData.FUTURES || {};
  const newsScore = Number.isFinite(newsObj.sentiment) ? newsObj.sentiment : 0;
  const krFut = Number.isFinite(futObj.K200_pct) ? futObj.K200_pct : 0;
  const krBasis = Number.isFinite(futObj.K200_basis) ? futObj.K200_basis : 0;
  f = applyNewsOverlay(f, newsScore, key, true);
  const k200Fresh = typeof isK200DaySessionKst === 'function' ? isK200DaySessionKst(Date.now()) : true;
  f = applyKrFuturesOverlay(f, krFut, krBasis, key, k200Fresh);
  if (typeof applyWeekendOilOverlay === 'function') {
    f = applyWeekendOilOverlay(f, futObj.CL_pct, Boolean(futObj.CL_weekend), true);
  }
  state.currentForecast = f;
  state.simValues = f && f.rawFeats ? f.rawFeats.slice() : [];

  const autoInfo = detectSessionPhase(key, Date.now());
  const activePhase = state.phaseOverride || autoInfo.phase;
  const curRow = rows[lv];
  const liveIdx = state.liveIndices[key] || {};
  const curPrice = Number.isFinite(liveIdx.close) ? liveIdx.close : curRow[1];
  const todayOpen = Number.isFinite(liveIdx.open)
    ? liveIdx.open
    : (state.liveCandles[key] && state.liveCandles[key].length ? state.liveCandles[key][state.liveCandles[key].length - 1][1] : null);

  const liveNasdaqPct = state.liveIndices.NASDAQ && Number.isFinite(state.liveIndices.NASDAQ.pct) ? state.liveIndices.NASDAQ.pct : NaN;
  const fxNow = state.liveIndices && Number.isFinite(state.liveIndices.USDKRW) ? state.liveIndices.USDKRW : NaN;
  const prevFx = curRow && Number.isFinite(curRow[3]) && curRow[3] > 0 ? curRow[3] : NaN;
  const fxPct = Number.isFinite(fxNow) && Number.isFinite(prevFx) ? ((fxNow / prevFx) - 1) * 100 : NaN;
  state.currentPhaseResult = computePhaseForecast(f ? f.p : 0.5, {
    phase: activePhase,
    isUs: key === 'NASDAQ',
    marketKey: key,
    progress: autoInfo.progress,
    vol: f ? f.vol : 1.3,
    curPrice,
    todayOpen,
    ewyPct: futObj.EWY_pct,
    nqPct: futObj.NQ_pct,
    ixicPct: liveNasdaqPct,
    esPct: futObj.ES_pct,
    fxPct,
    k200Pct: futObj.K200_pct,
    investor: state.liveInvestors[key] || null
  });
}

function getCandlesForView() {
  if (state.tab === 'STOCK') {
    const p = state.stockPayload;
    if (!p || !Array.isArray(p.rows) || !p.rows.length) return [];
    return p.rows.slice(-18).map((r, idx, arr) => {
      const prevC = idx > 0 ? arr[idx - 1][1] : r[1];
      const o = Number.isFinite(r[3]) ? r[3] : prevC;
      const cl = r[1];
      const h = Number.isFinite(r[4]) ? r[4] : Math.max(o, cl) * 1.004;
      const l = Number.isFinite(r[5]) ? r[5] : Math.min(o, cl) * 0.996;
      return [r[0].slice(5), o, h, l, cl];
    });
  }
  const key = state.tab;
  if (Array.isArray(state.liveCandles[key]) && state.liveCandles[key].length >= 5) {
    return state.liveCandles[key].slice(-18);
  }
  const rows = state.marketsData[key] || [];
  return rows.slice(-18).map((r, idx, arr) => {
    const prevC = idx > 0 ? arr[idx - 1][1] : r[1];
    const o = prevC;
    const cl = r[1];
    const spread = Math.max(Math.abs(cl - o) * 0.35, cl * 0.003);
    return [r[0].slice(5), o, Math.max(o, cl) + spread, Math.min(o, cl) - spread, cl];
  });
}

function getNxtPrePct(data) {
  if (!data || !data.isKr || data.sessionTag !== 'NXT 프리장') return NaN;
  const last = data.rows && data.rows.length ? data.rows[data.rows.length - 1] : null;
  return last && Number.isFinite(last[2]) ? last[2] : NaN;
}

function buildForecastCandle(candles, todayOpen, isIntraday, displayPrice) {
  if (!candles.length) return null;
  const isStock = state.tab === 'STOCK';
  const pr = isStock ? state.stockPhaseResult : state.currentPhaseResult;
  if (!pr) return null;
  const lastClose = candles[candles.length - 1][4];
  const liveIdxClose = (!isStock && state.liveIndices[state.tab] && Number.isFinite(state.liveIndices[state.tab].close) && state.liveIndices[state.tab].close > 0)
    ? state.liveIndices[state.tab].close
    : NaN;
  const effectiveClose = (Number.isFinite(displayPrice) && displayPrice > 0)
    ? displayPrice
    : (Number.isFinite(liveIdxClose) ? liveIdxClose : lastClose);
  const isNxtPreStock = isStock && !isIntraday && state.stockPayload && state.stockPayload.isKr && state.stockPayload.sessionTag === 'NXT 프리장';
  let basePrice = (isIntraday && Number.isFinite(todayOpen) && todayOpen > 0) ? todayOpen : effectiveClose;
  if (isNxtPreStock) {
    // NXT 프리장(08:00~08:59)에는 마지막 봉이 이미 NXT 실시간가이므로, 09:00 KRX 시초가 갭 이중 반영 방지를 위해 전일 종가 기준 사용
    if (candles.length >= 2 && Number.isFinite(candles[candles.length - 2][4]) && candles[candles.length - 2][4] > 0) {
      basePrice = candles[candles.length - 2][4];
    } else {
      const nxtPct = getNxtPrePct(state.stockPayload);
      if (Number.isFinite(nxtPct) && nxtPct > -99) basePrice = lastClose / (1 + nxtPct / 100);
    }
  }
  if (!Number.isFinite(basePrice) || basePrice <= 0) return null;

  let lowPct = -1.8;
  let highPct = 1.8;
  if (!isStock && state.currentForecast) {
    if (Number.isFinite(state.currentForecast.low)) lowPct = state.currentForecast.low;
    if (Number.isFinite(state.currentForecast.high)) highPct = state.currentForecast.high;
  } else if (isStock && state.stockAnalysis) {
    if (Number.isFinite(state.stockAnalysis.low)) lowPct = state.stockAnalysis.low;
    if (Number.isFinite(state.stockAnalysis.high)) highPct = state.stockAnalysis.high;
    else if (Number.isFinite(state.stockAnalysis.vol10)) {
      lowPct = -1.28 * state.stockAnalysis.vol10;
      highPct = 1.28 * state.stockAnalysis.vol10;
    }
  }
  const sc = Number.isFinite(pr.dirScore) ? pr.dirScore : Math.round((pr.p - 0.5) * 200);
  const shiftPct = Number.isFinite(pr.expectedShiftPct) ? pr.expectedShiftPct : 0;
  const span = Math.max(Math.abs(lowPct), Math.abs(highPct), isStock ? 2.5 : 1.2);
  // 장전 야간 갭/NXT 이동폭(shiftPct)을 중심에 반영해 실제 예상 범위가 현실적으로 따라오도록 보정
  const adjLowPct = Math.min(lowPct + shiftPct * 0.75, shiftPct - span * 0.35);
  const adjHighPct = Math.max(highPct + shiftPct * 0.75, shiftPct + span * 0.35);
  let expPct = shiftPct + (sc / 100) * span * (isNxtPreStock ? 0.14 : 0.35);
  // 방향(상승/하락)과 예상 가격 부호 일치 보장 (하락 예정인데 기준가보다 높게 나오는 모순 방지)
  if (pr.dir === 'down' && expPct >= -0.05) expPct = -Math.max(0.15, Math.abs(sc) / 100 * span * 0.25);
  if (pr.dir === 'up' && expPct <= 0.05) expPct = Math.max(0.15, Math.abs(sc) / 100 * span * 0.25);
  const predLow = basePrice * (1 + Math.min(adjLowPct, expPct) / 100);
  const predHigh = basePrice * (1 + Math.max(adjHighPct, expPct) / 100);
  const predClose = basePrice * (1 + expPct / 100);
  return {
    open: basePrice,
    high: predHigh,
    low: predLow,
    close: predClose,
    lowPct: Number(adjLowPct.toFixed(2)),
    highPct: Number(adjHighPct.toFixed(2)),
    dir: pr.dir
  };
}

function renderCandlestickChart(todayOpen, isIntraday, curPrice) {
  const svg = document.getElementById('main-chart-svg');
  const candles = getCandlesForView().slice(-15);
  const c = getColors();
  const gridCol = state.dark ? '#252B38' : '#E5E7EB';
  const openCol = state.dark ? '#64748B' : '#94A3B8';

  if (!candles.length) {
    svg.innerHTML = `<text x="180" y="95" text-anchor="middle" fill="${c.muted}" font-size="12" font-weight="700">차트 데이터를 불러오는 중입니다</text>`;
    return;
  }

  const fCandle = buildForecastCandle(candles, todayOpen, isIntraday, curPrice);

  let minV = Infinity;
  let maxV = -Infinity;
  for (const row of candles) {
    if (row[3] < minV) minV = row[3];
    if (row[2] > maxV) maxV = row[2];
  }
  if (fCandle) {
    if (fCandle.low < minV) minV = fCandle.low;
    if (fCandle.high > maxV) maxV = fCandle.high;
  }
  if (isIntraday && Number.isFinite(todayOpen)) {
    if (todayOpen < minV) minV = todayOpen;
    if (todayOpen > maxV) maxV = todayOpen;
  }
  const pad = (maxV - minV) * 0.12 || 1;
  minV -= pad;
  maxV += pad;

  const W = 360, H = 190, topP = 14, botP = 22, leftP = 8, rightP = 8;
  const plotW = W - leftP - rightP;
  const plotH = H - topP - botP;
  const yOf = v => topP + (1 - (v - minV) / (maxV - minV)) * plotH;

  let html = '';
  for (let g = 0; g < 3; g++) {
    const gy = topP + (plotH * g) / 2;
    html += `<line x1="${leftP}" y1="${gy.toFixed(1)}" x2="${W - rightP}" y2="${gy.toFixed(1)}" stroke="${gridCol}" stroke-width="1" />`;
  }

  if (isIntraday && Number.isFinite(todayOpen)) {
    const oy = yOf(todayOpen);
    html += `<line x1="${leftP}" y1="${oy.toFixed(1)}" x2="${W - rightP}" y2="${oy.toFixed(1)}" stroke="${openCol}" stroke-width="1.2" stroke-dasharray="4 3" />`;
  }

  const totalSlots = candles.length + (fCandle ? 1.4 : 0);
  const step = plotW / totalSlots;
  const bodyW = Math.max(6, step * 0.56);

  if (state.chartType === 'candle') {
    candles.forEach((row, idx) => {
      const [, o, h, l, cl] = row;
      const cx = leftP + idx * step + step / 2;
      const isUp = cl >= o;
      const col = isUp ? c.up : c.down;
      const yH = yOf(h);
      const yL = yOf(l);
      const yTop = yOf(Math.max(o, cl));
      const yBot = yOf(Math.min(o, cl));
      const bh = Math.max(2.5, yBot - yTop);
      html += `<g class="candle-hit" data-idx="${idx}">
        <line x1="${cx.toFixed(1)}" y1="${yH.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yL.toFixed(1)}" stroke="${col}" stroke-width="1.8" stroke-linecap="round"/>
        <rect x="${(cx - bodyW / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${col}"/>
      </g>`;
    });
  } else {
    const pts = candles.map((row, idx) => {
      const cx = leftP + idx * step + step / 2;
      return `${cx.toFixed(1)},${yOf(row[4]).toFixed(1)}`;
    }).join(' ');
    const last = candles[candles.length - 1];
    const first = candles[0];
    const lineCol = last[4] >= first[4] ? c.up : c.down;
    html += `<polyline fill="none" stroke="${lineCol}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" points="${pts}" />`;
    const lx = leftP + (candles.length - 1) * step + step / 2;
    html += `<circle cx="${lx.toFixed(1)}" cy="${yOf(last[4]).toFixed(1)}" r="4" fill="${lineCol}" />`;
  }

  // Rightmost Forecast Candle (80% min~max whiskers + translucent dashed body)
  if (fCandle) {
    const divX = leftP + candles.length * step + step * 0.12;
    const fCx = leftP + (candles.length + 0.72) * step;
    const fCol = fCandle.dir === 'up' ? c.up : fCandle.dir === 'down' ? c.down : c.flat;
    const yH = yOf(fCandle.high);
    const yL = yOf(fCandle.low);
    const yTop = yOf(Math.max(fCandle.open, fCandle.close));
    const yBot = yOf(Math.min(fCandle.open, fCandle.close));
    const bh = Math.max(5, yBot - yTop);

    html += `<line x1="${divX.toFixed(1)}" y1="${topP}" x2="${divX.toFixed(1)}" y2="${H - botP + 2}" stroke="${gridCol}" stroke-width="1.2" stroke-dasharray="3 3" />`;
    html += `<g class="candle-hit" id="forecast-candle-hit">
      <line x1="${fCx.toFixed(1)}" y1="${yH.toFixed(1)}" x2="${fCx.toFixed(1)}" y2="${yL.toFixed(1)}" stroke="${fCol}" stroke-width="1.8" stroke-dasharray="2.5 2.5" stroke-linecap="round" />
      <line x1="${(fCx - 4.5).toFixed(1)}" y1="${yH.toFixed(1)}" x2="${(fCx + 4.5).toFixed(1)}" y2="${yH.toFixed(1)}" stroke="${fCol}" stroke-width="1.8" stroke-linecap="round" />
      <line x1="${(fCx - 4.5).toFixed(1)}" y1="${yL.toFixed(1)}" x2="${(fCx + 4.5).toFixed(1)}" y2="${yL.toFixed(1)}" stroke="${fCol}" stroke-width="1.8" stroke-linecap="round" />
      <rect x="${(fCx - bodyW / 2 - 1).toFixed(1)}" y="${yTop.toFixed(1)}" width="${(bodyW + 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${fCol}" fill-opacity="0.22" stroke="${fCol}" stroke-width="1.8" stroke-dasharray="3 2" />
      <text x="${fCx.toFixed(1)}" y="${H - 5}" text-anchor="middle" fill="${fCol}" font-size="10" font-weight="800">예측</text>
    </g>`;
  }

  svg.innerHTML = html;
  const dec = state.tab === 'STOCK' && state.stockPayload && state.stockPayload.currency === 'KRW' ? 0 : 2;
  svg.querySelectorAll('.candle-hit').forEach(el => {
    if (el.id === 'forecast-candle-hit' && fCandle) {
      el.addEventListener('click', () => {
        document.getElementById('chart-readout').textContent =
          `예상 ${fmtNum(fCandle.low, dec)} ~ ${fmtNum(fCandle.high, dec)} (${fmtSigned(fCandle.lowPct, '%')} ~ ${fmtSigned(fCandle.highPct, '%')})`;
      });
      return;
    }
    el.addEventListener('click', () => {
      const row = candles[Number(el.dataset.idx)];
      if (!row) return;
      document.getElementById('chart-readout').textContent =
        `${row[0]} · 시가 ${fmtNum(row[1], dec)} · 종가 ${fmtNum(row[4], dec)}`;
    });
  });
}

function renderContextPanel() {
  const box = document.getElementById('context-panel');
  if (!box) return;
  const c = getColors();
  box.style.backgroundColor = c.card;
  box.style.border = `1px solid ${c.border}`;
  const tileStyle = `background-color:${c.tile};`;

  const fmtEok = (v) => {
    if (!Number.isFinite(v)) return '-';
    return (v > 0 ? '+' : '') + v.toLocaleString('ko-KR') + '억';
  };
  const fmtQty = (v) => {
    if (!Number.isFinite(v)) return '-';
    return (v > 0 ? '+' : '') + v.toLocaleString('ko-KR') + '주';
  };

  if (state.tab === 'NASDAQ') {
    const fut = state.marketsData.FUTURES || {};
    const fx = state.liveIndices && Number.isFinite(state.liveIndices.USDKRW) ? state.liveIndices.USDKRW : null;
    const cards = [
      { label: '야간 한국(EWY)', val: fmtSigned(fut.EWY_pct, '%'), sub: fut.EWY ? '$' + fmtNum(fut.EWY, 2) : '야간 대리지표', col: Number.isFinite(fut.EWY_pct) ? (fut.EWY_pct >= 0 ? c.up : c.down) : c.muted },
      { label: '코스피200 선물', val: fmtSigned(fut.K200_pct, '%'), sub: fut.K200 ? fmtNum(fut.K200, 2) : '주간 기준', col: Number.isFinite(fut.K200_pct) ? (fut.K200_pct >= 0 ? c.up : c.down) : c.muted },
      { label: '원/달러 환율', val: fx ? fmtNum(fx, 1) + '원' : '-', sub: '야간 외환', col: c.text }
    ];
    box.innerHTML = `<div class="flex items-center justify-between mb-2.5">
        <span class="text-xs font-extrabold">한국장 야간 동향 (EWY · 선물 · 환율)</span>
        <span class="text-[10px] font-bold opacity-55">야간선물 대리</span>
      </div>
      <div class="grid grid-cols-3 gap-2 text-center">${cards.map(it =>
        `<div class="p-2.5 rounded-2xl" style="${tileStyle}">
          <div class="text-[10px] font-bold opacity-65 truncate">${it.label}</div>
          <div class="text-sm font-black tabular mt-0.5" style="color:${it.col}">${it.val}</div>
          <div class="text-[10px] font-semibold opacity-55 tabular mt-0.5">${it.sub}</div>
        </div>`
      ).join('')}</div>`;
    return;
  }

  if (state.tab === 'STOCK') {
    const sp = state.stockPayload;
    if (!sp || !sp.isKr) {
      const perp = sp && sp.perp;
      box.innerHTML = `<div class="flex items-center justify-between mb-2">
          <span class="text-xs font-extrabold">미국 종목 실시간 보조 지표</span>
          <span class="text-[10px] font-bold opacity-55">24H 무기한</span>
        </div>
        <div class="p-3 rounded-2xl flex items-center justify-between text-xs" style="${tileStyle}">
          <span class="font-bold opacity-75">${perp ? perp.symbol : '24H 무기한 선물'}</span>
          <span class="font-black tabular" style="color:${perp ? (perp.pct >= 0 ? c.up : c.down) : c.muted}">${perp ? '$' + fmtNum(perp.price, 2) + ' (' + fmtSigned(perp.pct, '%') + ')' : '조회 대기'}</span>
        </div>`;
      return;
    }
    const inv = sp.investor;
    const fCol = inv && Number.isFinite(inv.frgnQty) ? (inv.frgnQty >= 0 ? c.up : c.down) : c.muted;
    const oCol = inv && Number.isFinite(inv.orgnQty) ? (inv.orgnQty >= 0 ? c.up : c.down) : c.muted;
    box.innerHTML = `<div class="flex items-center justify-between mb-2.5">
        <span class="text-xs font-extrabold">실시간 종목 수급 추정</span>
        <span class="text-[10px] font-bold opacity-55">${sp.sessionTag || 'KRX·NXT 통합'}</span>
      </div>
      <div class="grid grid-cols-2 gap-2 text-center">
        <div class="p-2.5 rounded-2xl" style="${tileStyle}">
          <div class="text-[10px] font-bold opacity-65">외국인 (가집계)</div>
          <div class="text-sm font-black tabular mt-0.5" style="color:${fCol}">${inv ? fmtQty(inv.frgnQty) : '집계 대기'}</div>
        </div>
        <div class="p-2.5 rounded-2xl" style="${tileStyle}">
          <div class="text-[10px] font-bold opacity-65">기관 (가집계)</div>
          <div class="text-sm font-black tabular mt-0.5" style="color:${oCol}">${inv ? fmtQty(inv.orgnQty) : '집계 대기'}</div>
        </div>
      </div>`;
    return;
  }

  // KOSPI / KOSDAQ Investor Breakdown (외국인·기관·개인 + 연기금·금융투자·투신)
  const inv = state.liveInvestors[state.tab];
  const topRow = [
    { label: '외국인', val: inv ? inv.frgn : NaN },
    { label: '기관 합계', val: inv ? inv.orgn : NaN },
    { label: '개인', val: inv ? inv.prsn : NaN }
  ];
  const subRow = [
    { label: '연기금', val: inv ? inv.fund : NaN },
    { label: '금융투자', val: inv ? inv.scrt : NaN },
    { label: '투신', val: inv ? inv.ivtr : NaN }
  ];
  const mkTile = (it) => {
    const col = Number.isFinite(it.val) ? (it.val > 0 ? c.up : it.val < 0 ? c.down : c.flat) : c.muted;
    return `<div class="p-2.5 rounded-2xl text-center" style="${tileStyle}">
      <div class="text-[10px] font-bold opacity-65">${it.label}</div>
      <div class="text-xs sm:text-sm font-black tabular mt-0.5" style="color:${col}">${fmtEok(it.val)}</div>
    </div>`;
  };
  box.innerHTML = `<div class="flex items-center justify-between mb-2.5">
      <span class="text-xs font-extrabold">${MARKET_LABELS[state.tab]} 수급 주체별 동향</span>
      <span class="text-[10px] font-bold opacity-55">${inv ? '실시간 (억원)' : '장중 집계 대기'}</span>
    </div>
    <div class="grid grid-cols-3 gap-2">${topRow.map(mkTile).join('')}</div>
    <div class="grid grid-cols-3 gap-2 mt-2">${subRow.map(mkTile).join('')}</div>`;
}


// =========================================================================
// 단타 진입 체크 (장중 / 정규장 종베 / 개별종목 NXT 20시 종베) + 매매 기록장
// =========================================================================
const JOURNAL_KEY = 'daybook_v9_journal';

function loadJournal() {
  try {
    const raw = safeRead(JOURNAL_KEY, '[]');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function saveJournal(arr) {
  safeWrite(JOURNAL_KEY, JSON.stringify((arr || []).slice(0, 80)));
}

function getCurrentAssetSnapshot() {
  const isStock = state.tab === 'STOCK';
  if (isStock && state.stockPayload && state.stockPayload.rows && state.stockPayload.rows.length) {
    const sp = state.stockPayload;
    const last = sp.rows[sp.rows.length - 1];
    return {
      key: sp.symbol,
      name: sp.name || sp.symbol,
      price: last[1],
      isKr: Boolean(sp.isKr),
      isStock: true,
      dec: sp.currency === 'KRW' ? 0 : 2,
      pfx: sp.currency === 'KRW' ? '' : '$',
      ufx: sp.currency === 'KRW' ? '원' : ''
    };
  }
  const rows = state.marketsData[state.tab] || [];
  const last = rows.length ? rows[rows.length - 1] : null;
  const lv = state.liveIndices[state.tab];
  const price = (lv && Number.isFinite(lv.close)) ? lv.close : (last ? last[1] : NaN);
  return {
    key: state.tab,
    name: MARKET_LABELS[state.tab] || state.tab,
    price,
    isKr: state.tab !== 'NASDAQ',
    isStock: false,
    dec: 2,
    pfx: '',
    ufx: ''
  };
}


function classifyMarketRegime(rows) {
  if (!Array.isArray(rows) || rows.length < 15) return null;
  const closes = rows.map(r => Number(r[1])).filter(v => Number.isFinite(v) && v > 0);
  if (closes.length < 15) return null;
  const n = closes.length;
  const cur = closes[n - 1];
  const avg = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
  const ma20 = avg(closes.slice(-Math.min(20, n)));
  const ma60 = avg(closes.slice(-Math.min(60, n)));
  const ref20 = closes[Math.max(0, n - 21)];
  const ret20 = ref20 > 0 ? ((cur / ref20) - 1) * 100 : 0;
  const hi60 = Math.max(...closes.slice(-Math.min(60, n)));
  const dd60 = hi60 > 0 ? ((cur / hi60) - 1) * 100 : 0;
  const maGap = ma60 > 0 ? ((ma20 / ma60) - 1) * 100 : 0;
  const dist60 = ma60 > 0 ? ((cur / ma60) - 1) * 100 : 0;

  let label = '횡보장';
  let tone = 'flat';
  let guide = '박스권 짧은 단타 위주';

  if (cur > ma20 && ma20 > ma60 && ret20 >= 3) {
    label = '강세장';
    tone = 'up';
    guide = '비중 확대 · 추세 보유 유리';
  } else if ((cur < ma20 && ma20 < ma60 && ret20 <= -5) || (cur < ma60 && dd60 <= -10)) {
    label = '하락장';
    tone = 'down';
    guide = '현금 방어 · 짧은 단타/인버스 · 종베 주의';
  } else if (Math.abs(maGap) <= 2.5 && Math.abs(ret20) < 3.5 && Math.abs(dist60) <= 3.0) {
    label = '횡보장';
    tone = 'flat';
    guide = '박스권 짧은 단타 위주';
  } else if (cur >= ma60 && (ma20 >= ma60 || ret20 > 0)) {
    label = '완만 상승';
    tone = 'up_soft';
    guide = '눌림목 분할 접근 · 보유';
  } else {
    label = '약세장';
    tone = 'down_soft';
    guide = '비중 축소 · 짧은 단타 대응';
  }

  return {
    label,
    tone,
    guide,
    ret20: Number(ret20.toFixed(1)),
    dd60: Number(dd60.toFixed(1))
  };
}

function getActiveRegime() {
  const isStock = state.tab === 'STOCK';
  const rows = isStock
    ? (state.stockPayload && Array.isArray(state.stockPayload.rows) ? state.stockPayload.rows : [])
    : (state.marketsData[state.tab] || []);
  return classifyMarketRegime(rows);
}

function evaluateScalpCheck(nowMs) {
  const ms = Number.isFinite(nowMs) ? nowMs : Date.now();
  const kst = new Date(ms + 9 * 3600 * 1000);
  const dow = kst.getUTCDay();
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const isWeekday = dow >= 1 && dow <= 5;

  const isStock = state.tab === 'STOCK';
  const sp = isStock ? state.stockPayload : null;
  const isKr = isStock ? (sp ? Boolean(sp.isKr) : true) : (state.tab !== 'NASDAQ');
  const pr = isStock ? state.stockPhaseResult : state.currentPhaseResult;
  if (!pr) return null;

  const sc = Number.isFinite(pr.dirScore) ? pr.dirScore : Math.round((pr.p - 0.5) * 200);
  const absSc = Math.abs(sc);
  const dir = sc >= 10 ? 'up' : sc <= -10 ? 'down' : 'flat';

  // 창구 판별 (한국 개별종목은 15:30~20:00 NXT 애프터장 종가베팅 포함)
  let windowCode = 'overnight_wait';
  let windowLabel = '다음 거래일 시초가 준비';
  let strategyTag = '종가베팅';
  let minScore = 30;

  if (isKr && isWeekday) {
    if (mins >= 480 && mins < 540) {
      windowCode = 'nxt_pre';
      windowLabel = isStock ? 'NXT 프리장 점검 (08:00~09:00)' : '개장 전 시초가 점검';
      strategyTag = '프리장 대응';
      minScore = 30;
    } else if (mins >= 540 && mins < 555) {
      windowCode = 'open_noise';
      windowLabel = '개장 초반 변동 구간 (09:15 이후 권장)';
      strategyTag = '장중 단타';
      minScore = 40;
    } else if (mins >= 555 && mins < 915) {
      windowCode = 'intraday';
      windowLabel = '장중 단타 창구 (오늘 종가 예측)';
      strategyTag = '장중 단타';
      minScore = 35;
    } else if (mins >= 915 && mins < 930) {
      windowCode = 'krx_close_bet';
      windowLabel = '정규장 종가베팅 창구 (15:15~15:30)';
      strategyTag = '정규장 종베';
      minScore = 30;
    } else if (mins >= 930 && mins < 1200 && isStock) {
      windowCode = 'nxt_after_bet';
      windowLabel = mins >= 1170
        ? 'NXT 20시 종가베팅 마감 직전 (19:30~20:00)'
        : 'NXT 애프터장 종가베팅 가능 (~20:00)';
      strategyTag = 'NXT 20시 종베';
      minScore = 30;
    } else if (mins >= 930 && mins < 1200 && !isStock) {
      windowCode = 'overnight_wait';
      windowLabel = '장 마감 · 야간 시초가 관찰 (개별종목은 NXT ~20:00)';
      strategyTag = '종가베팅';
      minScore = 30;
    }
  } else if (!isKr) {
    if (pr.phase === 'intraday') {
      windowCode = 'intraday';
      windowLabel = '미국 장중 단타 창구 (오늘 종가 예측)';
      strategyTag = '미국 장중';
      minScore = 35;
    } else {
      windowCode = 'overnight_wait';
      windowLabel = '미국 프리/애프터장 · 시초가 준비';
      strategyTag = '미국 장전';
      minScore = 30;
    }
  }

  // 1) 점수 강도 체크
  const c1Pass = absSc >= minScore;
  const c1Val = `${sc > 0 ? '+' : ''}${sc}점 (기준 ±${minScore})`;

  // 2) 30분 흐름 / 선행지표 일치 체크
  const sKey = (isStock && sp ? sp.symbol : state.tab) + ':' + pr.phase;
  const hist = (state.lastTrendHist && Array.isArray(state.lastTrendHist[sKey])) ? state.lastTrendHist[sKey] : [];
  let c2Pass = false;
  let c2Title = '30분 흐름·선행지표';
  let c2Val = '데이터 누적 중';

  if (pr.phase === 'intraday') {
    c2Title = '30분 점수 흐름';
    if (hist.length >= 2) {
      const diff = hist[hist.length - 1] - hist[0];
      c2Pass = (dir === 'up' && diff >= 0) || (dir === 'down' && diff <= 0);
      c2Val = diff > 3 ? '상승 힘 강화' : diff < -3 ? '하락 힘 강화' : '방향 유지';
    } else {
      c2Pass = absSc >= minScore;
      c2Val = '초기 구간';
    }
  } else {
    c2Title = (windowCode === 'nxt_after_bet' && mins >= 1080) ? '미 선물·프리장 일치' : '야간 선행지표 일치';
    const fut = state.marketsData.FUTURES || {};
    const leadVals = [];
    if (Number.isFinite(fut.NQ_pct)) leadVals.push(fut.NQ_pct);
    if (isStock && sp && sp.sessionTag === 'NXT 프리장') {
      const np = getNxtPrePct(sp);
      if (Number.isFinite(np)) leadVals.push(np);
    }
    if (isStock && sp && sp.perp && Number.isFinite(sp.perp.pct)) leadVals.push(sp.perp.pct);
    if (leadVals.length) {
      const avgLead = leadVals.reduce((x, y) => x + y, 0) / leadVals.length;
      c2Pass = (dir === 'up' && avgLead > 0.15) || (dir === 'down' && avgLead < -0.15);
      c2Val = `선행 평균 ${fmtSigned(avgLead, '%')}`;
    } else {
      c2Val = '선물 대기';
    }
  }

  // 3) 수급 일치 (장중) 또는 예상 밴드 참고 손절선 (장전/종가베팅)
  let c3Pass = false;
  let c3Title = '외국인·기관 수급';
  let c3Val = '집계 대기';

  if (pr.phase === 'intraday' && isKr) {
    if (isStock && sp && sp.investor) {
      const net = (Number(sp.investor.frgnQty) || 0) + (Number(sp.investor.orgnQty) || 0);
      c3Pass = (dir === 'up' && net > 0) || (dir === 'down' && net < 0);
      c3Val = net > 0 ? '외인·기관 순매수' : net < 0 ? '외인·기관 순매도' : '보합';
    } else if (!isStock && state.liveInvestors[state.tab]) {
      const inv = state.liveInvestors[state.tab];
      const net = (Number(inv.frgn) || 0) + (Number(inv.orgn) || 0);
      c3Pass = (dir === 'up' && net > 0) || (dir === 'down' && net < 0);
      c3Val = `합산 ${fmtEok(net)}`;
    }
  } else {
    c3Title = '예상 밴드 손절 기준';
    const snap = getCurrentAssetSnapshot();
    const candles = getCandlesForView().slice(-15);
    const fc = buildForecastCandle(candles, NaN, pr.phase === 'intraday', snap.price);
    if (fc && Number.isFinite(fc.low) && Number.isFinite(fc.high)) {
      const stopPrice = dir === 'down' ? fc.high : fc.low;
      c3Pass = c1Pass && dir !== 'flat';
      c3Val = `${dir === 'down' ? '상단' : '하단'} ${snap.pfx}${fmtNum(stopPrice, snap.dec)}${snap.ufx}`;
    } else {
      c3Val = '밴드 계산 중';
    }
  }

  const passCount = (c1Pass ? 1 : 0) + (c2Pass ? 1 : 0) + (c3Pass ? 1 : 0);
  let verdict = '관망 (조건 미달)';
  let verdictTone = 'flat';
  if (windowCode === 'open_noise' && passCount < 3) {
    verdict = '09:15 이후 진입 권장';
    verdictTone = 'flat';
  } else if (c1Pass && passCount >= 2 && dir === 'up') {
    verdict = windowCode === 'nxt_pre' ? '상승 유지 · 홀딩 우세' : '매수 진입 우세';
    verdictTone = 'up';
  } else if (c1Pass && passCount >= 2 && dir === 'down') {
    verdict = windowCode === 'nxt_pre' ? '하락 반전 · 프리장 정리 검토' : '매도·인버스 우세';
    verdictTone = 'down';
  }

  return {
    windowCode,
    windowLabel,
    strategyTag,
    verdict,
    verdictTone,
    passCount,
    checks: [
      { title: '방향 점수 강도', val: c1Val, pass: c1Pass },
      { title: c2Title, val: c2Val, pass: c2Pass },
      { title: c3Title, val: c3Val, pass: c3Pass }
    ],
    score: sc
  };
}

function addJournalEntry(side) {
  const snap = getCurrentAssetSnapshot();
  if (!Number.isFinite(snap.price) || snap.price <= 0) {
    showToast('현재가를 불러온 뒤 기록해 주세요');
    return;
  }
  const chk = evaluateScalpCheck(Date.now());
  const list = loadJournal();
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const stamp = `${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(now.getUTCDate()).padStart(2, '0')} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  list.unshift({
    id: String(Date.now()),
    key: snap.key,
    name: snap.name,
    side, // 'buy' | 'sell'
    entryPrice: snap.price,
    exitPrice: null,
    retPct: null,
    score: chk ? chk.score : 0,
    strategy: chk ? chk.strategyTag : '단타',
    dec: snap.dec,
    pfx: snap.pfx,
    ufx: snap.ufx,
    entryTime: stamp,
    exitTime: ''
  });
  saveJournal(list);
  showToast(`${snap.name} ${side === 'buy' ? '매수' : '매도'} 기록 저장`);
  try { renderScalpCard(); } catch (e) { console.error('scalp render err:', e); }
  if (state.drawerOpen && state.drawerTab === 'journal') renderDrawer();
}

function closeJournalEntry(id, customPrice) {
  const list = loadJournal();
  const it = list.find(x => x.id === id);
  if (!it) return;
  let exitP = Number(customPrice);
  if (!Number.isFinite(exitP) || exitP <= 0) {
    const snap = getCurrentAssetSnapshot();
    if (snap.key === it.key && Number.isFinite(snap.price) && snap.price > 0) {
      exitP = snap.price;
    } else {
      const typed = typeof prompt === 'function' ? prompt(`${it.name} 청산 가격을 입력하세요`, String(it.entryPrice)) : null;
      exitP = Number(String(typed || '').replace(/,/g, ''));
    }
  }
  if (!Number.isFinite(exitP) || exitP <= 0) return;
  const rawPct = ((exitP / it.entryPrice) - 1) * 100;
  it.exitPrice = exitP;
  it.retPct = Number((it.side === 'buy' ? rawPct : -rawPct).toFixed(2));
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  it.exitTime = `${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(now.getUTCDate()).padStart(2, '0')} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  saveJournal(list);
  showToast(`${it.name} 청산 완료 (${fmtSigned(it.retPct, '%')})`);
  renderScalpCard();
  if (state.drawerOpen && state.drawerTab === 'journal') renderDrawer();
}

function deleteJournalEntry(id) {
  const list = loadJournal().filter(x => x.id !== id);
  saveJournal(list);
  renderScalpCard();
  if (state.drawerOpen && state.drawerTab === 'journal') renderDrawer();
}

function renderScalpCard() {
  const box = document.getElementById('scalp-card');
  if (!box) return;
  const c = getColors();
  box.style.backgroundColor = c.card;
  box.style.border = `1px solid ${c.border}`;
  const chk = evaluateScalpCheck(Date.now());
  if (!chk) {
    box.style.display = 'block';
    box.innerHTML = `<div class="flex items-center justify-between gap-2">
      <div class="text-xs font-extrabold">단타 진입 체크</div>
      <span class="text-[11px] font-bold opacity-60">${state.stockLoading ? '종목 데이터 불러오는 중...' : '예측 계산 대기'}</span>
    </div>`;
    return;
  }
  box.style.display = 'block';
  const tileStyle = `background-color:${c.tile}; border:1px solid ${c.border};`;
  const vCol = chk.verdictTone === 'up' ? c.up : chk.verdictTone === 'down' ? c.down : c.muted;

  const list = loadJournal();
  const closed = list.filter(x => Number.isFinite(x.retPct));
  const wins = closed.filter(x => x.retPct > 0).length;
  const winStr = closed.length ? `승률 ${Math.round((wins / closed.length) * 100)}%` : '기록 보기';

  box.innerHTML = `
    <div class="flex items-center justify-between gap-2 mb-2.5">
      <div class="min-w-0">
        <div class="text-xs font-extrabold">단타 진입 체크</div>
        <div class="text-[10px] font-bold opacity-60 truncate mt-0.5">${chk.windowLabel}</div>
      </div>
      <span class="shrink-0 px-2.5 py-1 rounded-xl text-[11px] font-black" style="background-color:${vCol}1A; color:${vCol};">${chk.verdict} (${chk.passCount}/3)</span>
    </div>
    ${(() => {
      const rg = getActiveRegime();
      if (!rg) return '';
      const rgCol = (rg.tone === 'up' || rg.tone === 'up_soft') ? c.up : (rg.tone === 'down' || rg.tone === 'down_soft') ? c.down : c.muted;
      return `<div class="mb-2 px-2.5 py-1.5 rounded-xl flex items-center justify-between gap-2 text-[10px] font-bold" style="background-color:${rgCol}12; color:${rgCol};">
        <span class="font-black shrink-0">${rg.label}</span>
        <span class="truncate">${rg.guide} (20일 ${fmtSigned(rg.ret20, '%')})</span>
      </div>`;
    })()}
    <div class="grid grid-cols-3 gap-1.5">
      ${chk.checks.map(it => {
        const dotCol = it.pass ? (chk.verdictTone === 'down' ? c.down : c.up) : c.muted;
        return `<div class="p-2 rounded-2xl text-center" style="${tileStyle}">
          <div class="text-[10px] font-bold opacity-65 truncate">${it.title}</div>
          <div class="text-[11px] font-black tabular mt-0.5 truncate" style="color:${dotCol}">${it.pass ? '● ' : '○ '}${it.val}</div>
        </div>`;
      }).join('')}
    </div>
    <div class="mt-2.5 flex items-center justify-between gap-1.5">
      <div class="flex items-center gap-1.5">
        <button id="btn-scalp-buy" class="px-2.5 py-1.5 rounded-xl text-[11px] font-extrabold transition-colors" style="background-color:${c.up}1A; color:${c.up};">매수 기록</button>
        <button id="btn-scalp-sell" class="px-2.5 py-1.5 rounded-xl text-[11px] font-extrabold transition-colors" style="background-color:${c.down}1A; color:${c.down};">매도 기록</button>
      </div>
      <button id="btn-open-journal" class="px-2.5 py-1.5 rounded-xl text-[11px] font-bold transition-colors" style="${tileStyle} color:${c.text};">기록 ${list.length}건 · ${winStr} ▸</button>
    </div>
  `;

  const bBuy = document.getElementById('btn-scalp-buy');
  const bSell = document.getElementById('btn-scalp-sell');
  const bOpen = document.getElementById('btn-open-journal');
  if (bBuy) bBuy.onclick = () => addJournalEntry('buy');
  if (bSell) bSell.onclick = () => addJournalEntry('sell');
  if (bOpen) bOpen.onclick = () => {
    state.drawerOpen = true;
    state.drawerTab = 'journal';
    renderAll();
    const dp = document.getElementById('drawer-panel');
    if (dp) dp.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
}

function renderDrawer() {
  const area = document.getElementById('drawer-content-area');
  const c = getColors();
  const tileStyle = `background-color:${c.tile}; border:1px solid ${c.border};`;

  if (state.drawerTab === 'metrics') {
    const fut = state.marketsData.FUTURES || {};
    const futItems = [
      { label: '코스피200 선물', val: fut.K200_pct, sub: fut.K200 ? fmtNum(fut.K200, 2) : '-' },
      { label: '야간 한국(EWY)', val: fut.EWY_pct, sub: fut.EWY ? '$' + fmtNum(fut.EWY, 2) : '대기' },
      { label: '나스닥100 선물', val: fut.NQ_pct, sub: fut.NQ ? fmtNum(fut.NQ, 1) : '-' },
      { label: 'S&P500 선물', val: fut.ES_pct, sub: fut.ES ? fmtNum(fut.ES, 1) : '-' },
      { label: fut.CL_weekend ? 'WTI 유가 (24H)' : 'WTI 유가', val: fut.CL_pct, sub: fut.CL ? '$' + fmtNum(fut.CL, 2) : '-' },
      { label: '비트코인 24H', val: fut.BTC_pct, sub: fut.BTC ? '$' + fmtNum(fut.BTC, 0) : '-' }
    ];
    let html = `<div class="grid grid-cols-3 gap-2">`;
    for (const fi of futItems) {
      const col = !Number.isFinite(fi.val) ? c.muted : fi.val >= 0 ? c.up : c.down;
      html += `<div class="p-2.5 rounded-2xl text-center" style="${tileStyle}">
        <div class="text-[10px] font-bold opacity-65 truncate">${fi.label}</div>
        <div class="font-black text-sm tabular mt-0.5" style="color:${col}">${fmtSigned(fi.val, '%')}</div>
        <div class="text-[10px] font-semibold opacity-55 tabular mt-0.5">${fi.sub}</div>
      </div>`;
    }
    html += `</div>`;

    if (state.tab === 'STOCK' && state.stockPayload) {
      const sp = state.stockPayload;
      if (sp.perp) {
        const pc = sp.perp.pct >= 0 ? c.up : c.down;
        html += `<div class="p-3 rounded-2xl flex items-center justify-between" style="${tileStyle}">
          <div>
            <div class="text-[10px] font-bold opacity-65">24시간 무기한 선물 (${sp.perp.symbol})</div>
            <div class="font-extrabold mt-0.5 tabular">$${fmtNum(sp.perp.price, 2)}</div>
          </div>
          <div class="font-black text-sm tabular" style="color:${pc}">${fmtSigned(sp.perp.pct, '%')}</div>
        </div>`;
      }
      if (state.stockAnalysis && state.stockAnalysis.contributions) {
        html += `<div class="p-3 rounded-2xl space-y-2" style="${tileStyle}">
          <div class="text-[11px] font-extrabold opacity-70">종목 예측 기여 요인</div>`;
        for (const ct of state.stockAnalysis.contributions.slice(0, 5)) {
          const col = ct.impactPct >= 0 ? c.up : c.down;
          html += `<div class="flex items-center justify-between tabular">
            <span class="font-semibold opacity-80">${ct.label}</span>
            <span class="font-extrabold" style="color:${col}">${fmtSigned(ct.impactPct, '%p')}</span>
          </div>`;
        }
        html += `</div>`;
      }
    } else if (state.currentForecast) {
      const f = state.currentForecast;
      const pr = state.currentPhaseResult;
      html += `<div class="p-3 rounded-2xl flex items-center justify-between tabular" style="${tileStyle}">
        <div>
          <div class="text-[10px] font-bold opacity-65">참고 상승 확률 · 변동성 국면</div>
          <div class="font-extrabold mt-0.5">${pr ? (pr.p * 100).toFixed(1) + '%' : '-'} · ${f.regime}</div>
        </div>
        <div class="text-right">
          <div class="text-[10px] font-bold opacity-65">예상 80% 등락폭</div>
          <div class="font-extrabold mt-0.5">${fmtSigned(f.low, '%')} ~ ${fmtSigned(f.high, '%')}</div>
        </div>
      </div>`;
      if (Array.isArray(f.contributions) && f.contributions.length) {
        html += `<div class="p-3 rounded-2xl space-y-1.5" style="${tileStyle}">
          <div class="text-[11px] font-extrabold opacity-70">주요 판단 근거 (상위 5개)</div>`;
        const sorted = f.contributions.slice().sort((a, b) => Math.abs(b.impactPct) - Math.abs(a.impactPct)).slice(0, 5);
        for (const ct of sorted) {
          const col = ct.impactPct >= 0 ? c.up : c.down;
          html += `<div class="flex items-center justify-between tabular">
            <span class="font-semibold opacity-80">${ct.label}</span>
            <span class="font-extrabold" style="color:${col}">${fmtSigned(ct.impactPct, '%p')}</span>
          </div>`;
        }
        html += `</div>`;
      }
    }
    area.innerHTML = html;
  } else if (state.drawerTab === 'news') {
    const items = (state.tab === 'STOCK' && state.stockPayload && Array.isArray(state.stockPayload.news) && state.stockPayload.news.length)
      ? state.stockPayload.news
      : ((state.marketsData.NEWS && Array.isArray(state.marketsData.NEWS.items)) ? state.marketsData.NEWS.items : []);
    const sent = state.marketsData.NEWS && Number.isFinite(state.marketsData.NEWS.sentiment) ? state.marketsData.NEWS.sentiment : 0;
    const sCol = sent > 5 ? c.up : sent < -5 ? c.down : c.muted;
    let html = `<div class="p-3 rounded-2xl flex items-center justify-between" style="${tileStyle}">
      <span class="font-bold opacity-75">실시간 증시 뉴스 투심</span>
      <span class="font-black tabular" style="color:${sCol}">${sent > 0 ? '+' : ''}${sent}점</span>
    </div>`;
    if (!items.length) {
      html += `<div class="p-4 rounded-2xl text-center opacity-65" style="${tileStyle}">상단 ↻ 새로고침을 누르면 국내 증시 최신 속보를 불러옵니다.</div>`;
    } else {
      html += `<div class="rounded-2xl divide-y overflow-hidden" style="${tileStyle}; border-color:${c.border};">`;
      for (const it of items.slice(0, 8)) {
        html += `<a href="${it.url || '#'}" target="_blank" rel="noopener noreferrer" class="block p-3 hover:opacity-80 transition-opacity" style="border-color:${c.border};">
          <div class="font-bold leading-snug">${it.title}</div>
          <div class="text-[10px] font-semibold opacity-55 mt-1">${it.source || ''}</div>
        </a>`;
      }
      html += `</div>`;
    }
    area.innerHTML = html;
  } else if (state.drawerTab === 'journal') {
    const list = loadJournal();
    const closed = list.filter(x => Number.isFinite(x.retPct));
    const wins = closed.filter(x => x.retPct > 0).length;
    const avgRet = closed.length ? (closed.reduce((s, x) => s + x.retPct, 0) / closed.length) : NaN;
    const avgCol = Number.isFinite(avgRet) ? (avgRet >= 0 ? c.up : c.down) : c.muted;
    const snap = getCurrentAssetSnapshot();

    let html = `<div class="grid grid-cols-3 gap-2 text-center">
      <div class="p-2.5 rounded-2xl" style="${tileStyle}">
        <div class="text-[10px] font-bold opacity-65">승률</div>
        <div class="text-sm font-black tabular mt-0.5">${closed.length ? Math.round((wins / closed.length) * 100) + '%' : '-'}</div>
      </div>
      <div class="p-2.5 rounded-2xl" style="${tileStyle}">
        <div class="text-[10px] font-bold opacity-65">평균 수익률</div>
        <div class="text-sm font-black tabular mt-0.5" style="color:${avgCol}">${Number.isFinite(avgRet) ? fmtSigned(avgRet, '%') : '-'}</div>
      </div>
      <div class="p-2.5 rounded-2xl" style="${tileStyle}">
        <div class="text-[10px] font-bold opacity-65">완료 / 전체</div>
        <div class="text-sm font-black tabular mt-0.5">${closed.length} / ${list.length}</div>
      </div>
    </div>`;

    if (!list.length) {
      html += `<div class="p-4 rounded-2xl text-center opacity-65" style="${tileStyle}">위 <b>단타 진입 체크</b>에서 매수·매도 기록을 누르면 이곳에 승률과 수익률이 쌓입니다.</div>`;
    } else {
      html += `<div class="space-y-2">`;
      for (const it of list.slice(0, 25)) {
        const isClosed = Number.isFinite(it.retPct);
        const sideCol = it.side === 'buy' ? c.up : c.down;
        const retCol = isClosed ? (it.retPct >= 0 ? c.up : c.down) : c.muted;
        const sameAsset = snap.key === it.key && Number.isFinite(snap.price) && snap.price > 0;
        const livePct = (!isClosed && sameAsset)
          ? Number((((snap.price / it.entryPrice) - 1) * 100 * (it.side === 'buy' ? 1 : -1)).toFixed(2))
          : NaN;
        html += `<div class="p-3 rounded-2xl" style="${tileStyle}">
          <div class="flex items-center justify-between gap-2">
            <div class="min-w-0 flex items-center gap-1.5">
              <span class="px-1.5 py-0.5 rounded-md text-[10px] font-black" style="background-color:${sideCol}1A; color:${sideCol};">${it.side === 'buy' ? '매수' : '매도'}</span>
              <span class="font-extrabold truncate">${it.name}</span>
              <span class="text-[10px] font-bold opacity-55">${it.strategy || '단타'} · ${it.score > 0 ? '+' : ''}${it.score}점</span>
            </div>
            <button data-jdel="${it.id}" class="text-[10px] font-bold opacity-50 px-1.5">삭제</button>
          </div>
          <div class="mt-1.5 flex items-center justify-between gap-2 text-[11px] tabular">
            <span class="opacity-75">${it.entryTime} · ${it.pfx}${fmtNum(it.entryPrice, it.dec)}${it.ufx}${isClosed ? ` → ${it.pfx}${fmtNum(it.exitPrice, it.dec)}${it.ufx}` : ''}</span>
            ${isClosed
              ? `<span class="font-black" style="color:${retCol}">${fmtSigned(it.retPct, '%')}</span>`
              : `<div class="flex items-center gap-1.5">
                  ${Number.isFinite(livePct) ? `<span class="font-extrabold" style="color:${livePct >= 0 ? c.up : c.down}">평가 ${fmtSigned(livePct, '%')}</span>` : ''}
                  <button data-jclose="${it.id}" class="px-2 py-0.5 rounded-lg text-[10px] font-extrabold" style="background-color:${c.text}; color:${c.card};">${sameAsset ? '현재가 청산' : '청산 입력'}</button>
                </div>`
            }
          </div>
        </div>`;
      }
      html += `</div>`;
      html += `<button id="btn-journal-clear" class="w-full py-2 rounded-xl text-[11px] font-bold opacity-65" style="${tileStyle}">기록 전체 초기화</button>`;
    }
    area.innerHTML = html;
    area.querySelectorAll('[data-jclose]').forEach(btn => {
      btn.addEventListener('click', () => closeJournalEntry(btn.dataset.jclose));
    });
    area.querySelectorAll('[data-jdel]').forEach(btn => {
      btn.addEventListener('click', () => deleteJournalEntry(btn.dataset.jdel));
    });
    const clr = document.getElementById('btn-journal-clear');
    if (clr) clr.addEventListener('click', () => {
      saveJournal([]);
      showToast('매매 기록을 초기화했어요');
      renderScalpCard();
      renderDrawer();
    });
  } else if (state.drawerTab === 'sim') {
    if (state.tab === 'STOCK' || !state.currentForecast || !state.currentForecast.modelRef) {
      area.innerHTML = `<div class="p-4 rounded-2xl text-center opacity-70" style="${tileStyle}">코스피 · 코스닥 · 나스닥 탭에서 가정 시뮬레이터를 사용할 수 있습니다.</div>`;
      return;
    }
    const f = state.currentForecast;
    const meta = f.meta || [];
    const simPred = predictWithModel(f.modelRef, state.simValues, f.vol, state.tab, meta, 1);
    const sCol = simPred.p >= 0.6 ? c.up : simPred.p <= 0.4 ? c.down : c.flat;
    const sWord = simPred.p >= 0.6 ? '상승 우위' : simPred.p <= 0.4 ? '하락 경계' : '관망 구간';
    let html = `<div class="p-3.5 rounded-2xl flex items-center justify-between" style="${tileStyle}">
      <div>
        <div class="text-[10px] font-bold opacity-65">가정 시뮬레이션 결과</div>
        <div id="sim-result-word" class="text-base font-black mt-0.5" style="color:${sCol}">${sWord} (${(simPred.p * 100).toFixed(1)}%)</div>
      </div>
      <button id="btn-sim-reset" class="px-3 py-1.5 rounded-xl text-[11px] font-extrabold" style="background-color:${c.border};">초기화</button>
    </div><div class="p-3 rounded-2xl space-y-3" style="${tileStyle}">`;
    meta.slice(0, 6).forEach((m, idx) => {
      const val = Number.isFinite(state.simValues[idx]) ? state.simValues[idx] : 0;
      html += `<div>
        <div class="flex items-center justify-between mb-1">
          <span class="font-bold opacity-80">${m.label}</span>
          <span id="sim-lbl-${idx}" class="font-extrabold tabular">${val.toFixed(2)}${m.unit}</span>
        </div>
        <input data-sidx="${idx}" type="range" min="${m.min}" max="${m.max}" step="${m.step}" value="${val.toFixed(2)}" class="sim-slider w-full accent-rose-500 cursor-pointer" />
      </div>`;
    });
    html += `</div>`;
    area.innerHTML = html;

    area.querySelectorAll('.sim-slider').forEach(inp => {
      inp.addEventListener('input', e => {
        const idx = Number(e.target.dataset.sidx);
        state.simValues[idx] = Number(e.target.value);
        const m = meta[idx];
        const lbl = document.getElementById('sim-lbl-' + idx);
        if (lbl) lbl.textContent = state.simValues[idx].toFixed(2) + m.unit;
        const nextP = predictWithModel(f.modelRef, state.simValues, f.vol, state.tab, meta, 1);
        const outEl = document.getElementById('sim-result-word');
        if (outEl) {
          const nc = nextP.p >= 0.6 ? c.up : nextP.p <= 0.4 ? c.down : c.flat;
          const nw = nextP.p >= 0.6 ? '상승 우위' : nextP.p <= 0.4 ? '하락 경계' : '관망 구간';
          outEl.style.color = nc;
          outEl.textContent = `${nw} (${(nextP.p * 100).toFixed(1)}%)`;
        }
      });
    });
    const resetBtn = document.getElementById('btn-sim-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        state.simValues = f.rawFeats.slice();
        renderDrawer();
      });
    }
  } else {
    // verify & settings
    let verifyHtml = '';
    if (state.tab === 'STOCK' && state.stockAnalysis && state.stockAnalysis.backtest) {
      const bt = state.stockAnalysis.backtest;
      verifyHtml = `<div class="p-3 rounded-2xl space-y-1.5 tabular" style="${tileStyle}">
        <div class="text-[11px] font-extrabold opacity-70">개별 종목 5년 워크포워드 검증 (${bt.n}거래일)</div>
        <div class="flex justify-between"><span>모델 Brier (낮을수록 우수)</span><span class="font-extrabold">${bt.brierModel.toFixed(4)} (기준 ${bt.brierBase.toFixed(4)})</span></div>
        <div class="flex justify-between"><span>고확신 구간 적중률</span><span class="font-extrabold">${bt.hiAcc !== null ? bt.hiAcc.toFixed(1) + '%' : '-'}</span></div>
      </div>`;
    } else if (state.tab !== 'STOCK') {
      const key = state.tab;
      if (!state.historyCache[key]) {
        const rows = state.marketsData[key] || [];
        const hist = buildHistories(rows, key, state.marketsData, 1);
        state.historyCache[key] = summarizeBacktest(hist.enhanced, key);
      }
      const st = state.historyCache[key];
      verifyHtml = `<div class="p-3 rounded-2xl space-y-1.5 tabular" style="${tileStyle}">
        <div class="text-[11px] font-extrabold opacity-70">${MARKET_LABELS[key]} 과거 워크포워드 검증 (${st ? st.n : 0}일)</div>
        <div class="flex justify-between"><span>모델 Brier 점수</span><span class="font-extrabold">${st ? st.brier.toFixed(4) : '-'} (기준 ${st ? st.baseBrier.toFixed(4) : '-'})</span></div>
        <div class="flex justify-between"><span>고확신 구간 적중률</span><span class="font-extrabold">${st && st.hiAcc !== null ? (st.hiAcc * 100).toFixed(1) + '%' : '-'} (${st ? st.hiCount : 0}회)</span></div>
      </div>`;
    }

    area.innerHTML = `${verifyHtml}
      <div class="p-3 rounded-2xl space-y-2" style="${tileStyle}">
        <div class="text-[11px] font-extrabold opacity-70">실시간 중계 서버 (Cloudflare Workers)</div>
        <div class="flex gap-1.5">
          <input id="worker-url-input" type="url" value="${state.workerUrl}" placeholder="https://index-daybook-live.xxx.workers.dev" class="flex-1 px-3 py-2 rounded-xl text-[11px] font-bold outline-none" style="background-color:${c.card}; border:1px solid ${c.border}; color:${c.text};" />
          <button id="btn-save-worker" class="px-3 py-2 rounded-xl text-[11px] font-extrabold text-white shrink-0" style="background-color:${c.up};">저장</button>
        </div>
      </div>`;

    const saveBtn = document.getElementById('btn-save-worker');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const val = (document.getElementById('worker-url-input').value || '').trim().replace(/\/+$/, '');
        state.workerUrl = val;
        safeWrite('daybook_worker_url', val);
        showToast('서버 주소를 저장했습니다.');
        fetchLiveMarketData(false);
      });
    }
  }
}

function renderAll() {
  const c = getColors();
  const d = state.dark;

  // Theme shell
  document.body.style.backgroundColor = c.bg;
  document.body.style.color = c.text;
  const metaTheme = document.getElementById('meta-theme-color');
  if (metaTheme) metaTheme.setAttribute('content', d ? '#11141B' : '#FFFFFF');

  const topBar = document.getElementById('top-bar');
  topBar.style.backgroundColor = d ? 'rgba(17,20,27,0.92)' : 'rgba(255,255,255,0.92)';
  topBar.style.borderColor = c.border;

  const themeBtn = document.getElementById('btn-theme-toggle');
  themeBtn.textContent = d ? '라이트' : '다크';
  themeBtn.style.backgroundColor = c.tile;
  themeBtn.style.color = c.text;
  themeBtn.style.border = `1px solid ${c.border}`;

  const autoBtn = document.getElementById('btn-auto-live');
  if (autoBtn) {
    autoBtn.textContent = state.autoLive ? '● LIVE' : '○ 정지';
    autoBtn.style.backgroundColor = state.autoLive ? (d ? '#281820' : '#FFF1F2') : c.tile;
    autoBtn.style.color = state.autoLive ? c.up : c.muted;
    autoBtn.style.border = `1px solid ${state.autoLive ? c.up + '55' : c.border}`;
  }
  const refBtn = document.getElementById('btn-live-refresh');
  refBtn.style.backgroundColor = c.tile;
  refBtn.style.color = c.text;
  refBtn.style.border = `1px solid ${c.border}`;

  // Main tabs
  document.querySelectorAll('.main-tab').forEach(btn => {
    const on = btn.dataset.tab === state.tab;
    btn.style.backgroundColor = on ? (d ? '#F8FAFC' : '#111827') : c.tile;
    btn.style.color = on ? (d ? '#111827' : '#FFFFFF') : c.muted;
  });

  // Stock bar visibility & styling
  const stockBar = document.getElementById('stock-bar');
  const isStock = state.tab === 'STOCK';
  stockBar.classList.toggle('hidden', !isStock);
  if (isStock) {
    const inp = document.getElementById('stock-search-input');
    const sBtn = document.getElementById('stock-search-btn');
    inp.style.backgroundColor = c.card;
    inp.style.border = `1px solid ${c.border}`;
    inp.style.color = c.text;
    sBtn.style.backgroundColor = d ? '#F8FAFC' : '#111827';
    sBtn.style.color = d ? '#111827' : '#FFFFFF';
    const presetsEl = document.getElementById('stock-presets');
    presetsEl.innerHTML = STOCK_PRESETS.map(name => {
      const on = state.stockQuery === name;
      return `<button data-preset="${name}" class="preset-btn px-3 py-1.5 rounded-full text-[11px] font-extrabold shrink-0 transition-colors" style="background-color:${on ? (d ? '#F8FAFC' : '#111827') : c.card}; color:${on ? (d ? '#111827' : '#FFFFFF') : c.muted}; border:1px solid ${c.border};">${name}</button>`;
    }).join('');

  }

  // Resolve hero data (Index vs Stock)
  let nameStr = '';
  let extraTag = '';
  let priceStr = '-';
  let retVal = NaN;
  let todayOpen = NaN;
  let curPrice = NaN;
  let unit = '';
  let pr = null;

  if (!isStock) {
    const key = state.tab;
    const rows = state.marketsData[key] || [];
    const curRow = rows.length ? rows[rows.length - 1] : null;
    const liveIdx = state.liveIndices[key] || {};
    nameStr = MARKET_LABELS[key] || key;
    curPrice = Number.isFinite(liveIdx.close) ? liveIdx.close : (curRow ? curRow[1] : NaN);
    retVal = Number.isFinite(liveIdx.pct) ? liveIdx.pct : (curRow ? curRow[2] : NaN);
    todayOpen = Number.isFinite(liveIdx.open)
      ? liveIdx.open
      : (state.liveCandles[key] && state.liveCandles[key].length ? state.liveCandles[key][state.liveCandles[key].length - 1][1] : NaN);
    priceStr = fmtNum(curPrice, 2);
    pr = state.currentPhaseResult;
    extraTag = curRow ? curRow[0] : '';
  } else {
    const sp = state.stockPayload;
    nameStr = state.stockLoading ? state.stockQuery : (sp ? sp.name : state.stockQuery);
    if (state.stockLoading) {
      extraTag = '조회 중...';
    } else if (state.stockError) {
      extraTag = state.stockError;
    } else if (sp && sp.rows && sp.rows.length) {
      const last = sp.rows[sp.rows.length - 1];
      const isKrw = sp.currency === 'KRW';
      unit = isKrw ? '원' : '';
      curPrice = last[1];
      retVal = last[2];
      todayOpen = Number.isFinite(last[3]) ? last[3] : NaN;
      priceStr = (isKrw ? '' : '$') + fmtNum(curPrice, isKrw ? 0 : 2) + unit;
      extraTag = (sp.sessionTag ? sp.sessionTag + ' · ' : '') + (sp.sectorLabel || sp.symbol);
      pr = state.stockPhaseResult;
    }
  }

  const dir = pr ? pr.dir : 'flat';
  const phase = pr ? pr.phase : 'preopen';
  const sigColor = dir === 'up' ? c.up : dir === 'down' ? c.down : c.flat;

  // Soft Pastel Tint Hero Card
  const heroCard = document.getElementById('hero-card');
  const tintBg = dir === 'up'
    ? (d ? '#281820' : '#FFF1F2')
    : dir === 'down'
      ? (d ? '#152033' : '#EFF6FF')
      : (d ? '#1C222D' : '#F1F5F9');
  heroCard.style.backgroundColor = tintBg;
  heroCard.style.border = d ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(15,23,42,0.05)';

  // Brand icon tinted by signal
  const brandIcon = document.getElementById('brand-icon');
  brandIcon.style.backgroundColor = sigColor;
  brandIcon.innerHTML = getBrandSvg();

  document.getElementById('header-stamp').textContent = state.liveUpdatedKst
    ? state.liveUpdatedKst.slice(5, 16) + ' KST'
    : '수록 종가 기준';

  // Phase pill + switch button
  const phasePill = document.getElementById('phase-pill');
  const phaseSwitch = document.getElementById('btn-phase-switch');
  if (phase === 'preopen') {
    phasePill.textContent = '● 장전 · 다음 시초가 예측';
    phasePill.style.backgroundColor = d ? 'rgba(255,255,255,0.09)' : 'rgba(15,23,42,0.07)';
    phasePill.style.color = d ? '#E2E8F0' : '#334155';
    phaseSwitch.textContent = '장중 종가 보기';
  } else {
    phasePill.textContent = '● 장중 · 오늘 종가 예측';
    phasePill.style.backgroundColor = sigColor + '22';
    phasePill.style.color = sigColor;
    phaseSwitch.textContent = '내일 시초가 미리보기';
  }

  document.getElementById('hero-name').textContent = nameStr;
  const rgBadge = document.getElementById('hero-regime-badge');
  if (rgBadge) {
    const rg = (isStock && state.stockLoading) ? null : getActiveRegime();
    if (rg) {
      const rgCol = (rg.tone === 'up' || rg.tone === 'up_soft') ? c.up : (rg.tone === 'down' || rg.tone === 'down_soft') ? c.down : c.muted;
      rgBadge.textContent = rg.label;
      rgBadge.style.backgroundColor = rgCol + (rg.tone === 'up' || rg.tone === 'down' ? '24' : '16');
      rgBadge.style.color = rgCol;
      rgBadge.classList.remove('hidden');
    } else {
      rgBadge.classList.add('hidden');
    }
  }
  document.getElementById('hero-extra-tag').textContent = extraTag;
  document.getElementById('hero-price').textContent = priceStr;

  const retEl = document.getElementById('hero-ret');
  const retCol = !Number.isFinite(retVal) ? c.muted : retVal >= 0 ? c.up : c.down;
  retEl.textContent = fmtSigned(retVal, '%');
  retEl.style.color = retCol;
  retEl.style.backgroundColor = retCol + '1A';

  // Open reference line (small, under big current price)
  const openLine = document.getElementById('hero-open-line');
  if (Number.isFinite(todayOpen) && Number.isFinite(curPrice) && todayOpen > 0) {
    const diffPct = ((curPrice / todayOpen) - 1) * 100;
    const dec = isStock && state.stockPayload && state.stockPayload.currency === 'KRW' ? 0 : 2;
    const prefix = isStock && state.stockPayload && state.stockPayload.currency !== 'KRW' ? '$' : '';
    const isNxtPreNow = isStock && state.stockPayload && state.stockPayload.isKr && state.stockPayload.sessionTag === 'NXT 프리장';
    openLine.textContent = phase === 'intraday'
      ? `오늘 시초가 ${prefix}${fmtNum(todayOpen, dec)}${unit} (현재 시가 대비 ${fmtSigned(diffPct, '%')})`
      : (isNxtPreNow
          ? `NXT 프리장 실시간 · 야간 선행지표 반영 (09:00 KRX 시초가 예측)`
          : `직전 시초가 ${prefix}${fmtNum(todayOpen, dec)}${unit} · 야간 선행지표 반영`);
  } else {
    openLine.textContent = phase === 'intraday'
      ? '장중 실시간 시세 기준'
      : '직전 확정 종가 기준 · 야간 선행지표 반영';
  }

  // Forecast Headline
  const forecastRow = document.getElementById('forecast-row');
  forecastRow.style.borderColor = d ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.08)';
  const iconBox = document.getElementById('signal-icon-box');
  iconBox.style.backgroundColor = d ? 'rgba(255,255,255,0.09)' : '#FFFFFF';
  iconBox.innerHTML = getSignalSvg(dir, sigColor);

  const subEl = document.getElementById('forecast-sub');
  const headEl = document.getElementById('forecast-headline');
  const scoreBox = document.getElementById('score-box');
  const scoreEl = document.getElementById('forecast-score');
  const deltaEl = document.getElementById('forecast-delta');
  scoreBox.style.backgroundColor = d ? 'rgba(255,255,255,0.08)' : '#FFFFFF';

  if (isStock && state.stockLoading) {
    subEl.textContent = '종목 데이터 분석 중';
    headEl.textContent = '잠시만 기다려 주세요...';
    scoreEl.textContent = '-';
    scoreEl.style.color = c.muted;
    deltaEl.textContent = '계산 중';
    deltaEl.style.color = c.muted;
  } else if (isStock && state.stockError) {
    subEl.textContent = '실시간 서버 연결 필요';
    headEl.textContent = '종목을 불러오지 못했습니다';
    scoreEl.textContent = '-';
    scoreEl.style.color = c.muted;
    deltaEl.textContent = '-';
    deltaEl.style.color = c.muted;
  } else if (pr) {
    subEl.textContent = pr.subLabel;
    if (dir === 'flat') {
      headEl.innerHTML = `${pr.headlinePrefix} <span style="color:${sigColor}">관망 구간</span>입니다`;
    } else {
      const word = dir === 'up' ? '상승' : '하락';
      headEl.innerHTML = `${pr.headlinePrefix} <span style="color:${sigColor}">${word}할 예정</span>입니다`;
    }
    const sc = Number.isFinite(pr.dirScore) ? pr.dirScore : (Number.isFinite(pr.p) ? Math.max(-100, Math.min(100, Math.round((pr.p - 0.5) * 200))) : 0);
    const candlesNow = getCandlesForView().slice(-15);
    const fcNow = buildForecastCandle(candlesNow, todayOpen, phase === 'intraday', curPrice);
    const targetLblEl = document.getElementById('forecast-target-lbl');
    const decP = isStock && state.stockPayload && state.stockPayload.currency === 'KRW' ? 0 : 2;
    const pfx = isStock && state.stockPayload && state.stockPayload.currency !== 'KRW' ? '$' : '';
    const ufx = isStock && state.stockPayload && state.stockPayload.currency === 'KRW' ? '원' : '';

    if (fcNow) {
      if (targetLblEl) targetLblEl.textContent = phase === 'intraday' ? '예상 종가' : '예상 시초가';
      scoreEl.textContent = pfx + fmtNum(fcNow.close, decP) + ufx;
      scoreEl.style.color = dir === 'up' ? c.up : dir === 'down' ? c.down : c.flat;
    } else {
      if (targetLblEl) targetLblEl.textContent = '방향 점수';
      scoreEl.textContent = (sc > 0 ? '+' : '') + sc;
      scoreEl.style.color = sc > 0 ? c.up : sc < 0 ? c.down : c.flat;
    }

    const sKey = (isStock && state.stockPayload ? state.stockPayload.symbol : state.tab) + ':' + pr.phase;
    const dlt = state.scoreDeltas[sKey];
    const scTxt = (sc > 0 ? '+' : '') + sc + '점';
    if (Number.isFinite(dlt) && dlt !== 0) {
      deltaEl.textContent = `${scTxt} (${dlt > 0 ? '▲+' : '▼'}${dlt})`;
      deltaEl.style.color = dlt > 0 ? c.up : c.down;
    } else {
      deltaEl.textContent = `방향 ${scTxt}`;
      deltaEl.style.color = sc > 0 ? c.up : sc < 0 ? c.down : c.muted;
    }
    renderScoreTrend(sKey, sc, c);
  } else {
    subEl.textContent = '예측 준비';
    headEl.textContent = '데이터를 불러오는 중입니다';
    scoreEl.textContent = '-';
    scoreEl.style.color = c.muted;
    deltaEl.textContent = '방향 점수';
    deltaEl.style.color = c.muted;
  }

  // Chart card
  const chartCard = document.getElementById('chart-card');
  chartCard.style.backgroundColor = c.card;
  chartCard.style.border = `1px solid ${c.border}`;
  const cmWrap = document.getElementById('chart-mode-wrap');
  cmWrap.style.backgroundColor = c.tile;
  ['candle', 'line'].forEach(t => {
    const b = document.getElementById('btn-chart-' + t);
    const on = state.chartType === t;
    b.style.backgroundColor = on ? (d ? '#2E3546' : '#FFFFFF') : 'transparent';
    b.style.color = on ? c.text : c.muted;
  });
  renderCandlestickChart(todayOpen, phase === 'intraday', curPrice);
  renderContextPanel();
  renderScalpCard();

  // Drawer
  const dBtn = document.getElementById('btn-drawer-toggle');
  dBtn.style.backgroundColor = c.card;
  dBtn.style.border = `1px solid ${c.border}`;
  dBtn.style.color = c.text;
  document.getElementById('drawer-body').classList.toggle('open', state.drawerOpen);
  document.getElementById('drawer-arrow').style.transform = state.drawerOpen ? 'rotate(180deg)' : 'rotate(0deg)';
  const dPanel = document.getElementById('drawer-panel');
  dPanel.style.backgroundColor = c.card;
  dPanel.style.border = `1px solid ${c.border}`;

  document.querySelectorAll('.dtab-btn').forEach(btn => {
    const on = btn.dataset.dtab === state.drawerTab;
    btn.style.backgroundColor = on ? (d ? '#F8FAFC' : '#111827') : c.tile;
    btn.style.color = on ? (d ? '#111827' : '#FFFFFF') : c.muted;
  });
  if (state.drawerOpen) renderDrawer();
}

async function fetchLiveMarketData(silent) {
  if (!state.workerUrl) return;
  const btn = document.getElementById('btn-live-refresh');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const res = await fetch(state.workerUrl.replace(/\/+$/, '') + '/live');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.futures) state.marketsData.FUTURES = data.futures;
    if (data.news) state.marketsData.NEWS = data.news;
    if (data.indices) state.liveIndices = data.indices;
    if (data.investors) state.liveInvestors = data.investors;
    if (data.candles) state.liveCandles = data.candles;
    if (data.intradayTrail) state.intradayTrail = data.intradayTrail;
    state.liveUpdatedKst = data.updatedKst || '';

    const dateKst = data.dateKst || '';
    const fxNow = data.indices && Number.isFinite(data.indices.USDKRW) ? data.indices.USDKRW : null;
    for (const mKey of ['KOSPI', 'KOSDAQ']) {
      const liveIdx = data.indices && data.indices[mKey];
      const rows = state.marketsData[mKey];
      if (liveIdx && Number.isFinite(liveIdx.close) && Array.isArray(rows) && rows.length) {
        const last = rows[rows.length - 1];
        const useFx = fxNow || last[3];
        if (last[0] === dateKst) {
          rows[rows.length - 1] = [dateKst, liveIdx.close, liveIdx.pct, useFx, last[4] ?? null, last[5] ?? null];
        } else if (dateKst && dateKst > last[0] && Math.abs(liveIdx.close - last[1]) > 0.005) {
          const calcPct = Number((((liveIdx.close / last[1]) - 1) * 100).toFixed(2));
          rows.push([dateKst, liveIdx.close, calcPct, useFx, null, null]);
        }
      }
    }
    state.historyCache = {};
    if (state.tab !== 'STOCK') {
      computeActiveIndex();
      if (state.currentPhaseResult) recordScoreDelta(state.tab + ':' + state.currentPhaseResult.phase, (Number.isFinite(state.currentPhaseResult.dirScore) ? state.currentPhaseResult.dirScore : Math.round((state.currentPhaseResult.p - 0.5) * 200)));
    }
    renderAll();
    if (!silent) showToast('최신 시세와 야간 선행지표를 반영했습니다.');
  } catch (err) {
    if (!silent) showToast('실시간 연결 지연: 기본 수록 데이터로 표시합니다.', true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻'; }
  }
}

function computeLatestPeerAvgPct(peers) {
  if (!Array.isArray(peers) || !peers.length) return NaN;
  const vals = [];
  for (const pr of peers) {
    if (!pr || pr.isLevel || pr.sym === 'KRW=X' || pr.sym === 'DX-Y.NYB' || pr.sym === '^KS11') continue;
    const rows = pr.rows || [];
    if (!rows.length) continue;
    const lastPct = Number(rows[rows.length - 1][2]);
    if (Number.isFinite(lastPct)) vals.push(lastPct);
  }
  if (!vals.length) return NaN;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

async function fetchStockData(query, silent = false) {
  const q = String(query || '').trim();
  if (!q) return;
  if (!state.workerUrl) {
    state.stockError = '하단 설정에서 서버 주소를 입력해 주세요';
    renderAll();
    return;
  }
  const mySeq = ++state.stockReqSeq;
  if (state.stockAbortCtrl) {
    try { state.stockAbortCtrl.abort(); } catch (_) {}
  }
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  state.stockAbortCtrl = ctrl;
  const timerId = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, 10000) : null;

  const hasExisting = Boolean(state.stockPayload && state.stockPayload.rows && state.stockPayload.rows.length);
  if (!silent || !hasExisting) {
    state.stockLoading = true;
    state.stockError = '';
    renderAll();
  }
  try {
    const baseU = state.workerUrl.replace(/\/+$/, '');
    const fetchOpts = ctrl ? { signal: ctrl.signal } : {};
    const liveCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const liveTimer = liveCtrl ? setTimeout(() => { try { liveCtrl.abort(); } catch (_) {} }, 4500) : null;
    const [res, liveRes] = await Promise.all([
      fetch(`${baseU}/stock?q=${encodeURIComponent(q)}`, fetchOpts),
      fetch(`${baseU}/live`, liveCtrl ? { signal: liveCtrl.signal } : {}).catch(() => null)
    ]);
    if (liveTimer) clearTimeout(liveTimer);
    if (mySeq !== state.stockReqSeq) return;
    if (liveRes && liveRes.ok) {
      try {
        const ld = await liveRes.json();
        if (ld.futures) state.marketsData.FUTURES = ld.futures;
        if (ld.indices) state.liveIndices = ld.indices;
        if (ld.intradayTrail) state.intradayTrail = ld.intradayTrail;
        if (ld.updatedKst) state.liveUpdatedKst = ld.updatedKst;
      } catch (_) {}
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '조회 실패');
    state.stockPayload = data;
    let analysis = typeof analyzeStockSeries === 'function' ? analyzeStockSeries(data) : null;
    if (analysis && data.perp && typeof applyStockPerpOverlay === 'function') {
      analysis.perp = data.perp;
      analysis = applyStockPerpOverlay(analysis, true);
    }
    state.stockAnalysis = analysis;

    const autoInfo = detectSessionPhase(data.symbol, Date.now());
    const activePhase = state.phaseOverride || autoInfo.phase;
    const last = data.rows && data.rows.length ? data.rows[data.rows.length - 1] : null;
    const fut = state.marketsData.FUTURES || {};
    state.stockPhaseResult = computePhaseForecast(analysis ? analysis.p : 0.5, {
      phase: activePhase,
      isUs: !data.isKr,
      marketKey: data.isKr ? 'KOSPI' : 'NASDAQ',
      isStock: true,
      sector: data.sector || 'general',
      progress: autoInfo.progress,
      vol: analysis ? analysis.vol10 : 2.1,
      curPrice: last ? last[1] : NaN,
      todayOpen: last && Number.isFinite(last[3]) ? last[3] : NaN,
      ewyPct: fut.EWY_pct,
      nqPct: fut.NQ_pct,
      ixicPct: state.liveIndices.NASDAQ ? state.liveIndices.NASDAQ.pct : NaN,
      esPct: fut.ES_pct,
      k200Pct: fut.K200_pct,
      peerAvgPct: computeLatestPeerAvgPct(data.peers),
      nxtPrePct: getNxtPrePct(data),
      perpPct: data.perp ? data.perp.pct : NaN,
      investor: data.investor || null
    });
    if (state.stockPhaseResult) recordScoreDelta(data.symbol + ':' + state.stockPhaseResult.phase, (Number.isFinite(state.stockPhaseResult.dirScore) ? state.stockPhaseResult.dirScore : Math.round((state.stockPhaseResult.p - 0.5) * 200)));
  } catch (err) {
    if (mySeq !== state.stockReqSeq) return;
    const isAbort = err && (err.name === 'AbortError' || String(err.message || '').includes('abort'));
    state.stockError = isAbort ? '응답 시간 초과 — 다시 눌러 재시도해 주세요' : (err.message || '종목 조회 실패');
  } finally {
    if (timerId) clearTimeout(timerId);
    if (mySeq === state.stockReqSeq) {
      state.stockLoading = false;
      renderAll();
    }
  }
}

function bindEvents() {
  document.querySelectorAll('.main-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      state.phaseOverride = null;
      state.lastTickPrice = null;
      scheduleLiveLoops();
      document.getElementById('chart-readout').textContent = '봉을 눌러 시·종가 확인';
      if (state.tab === 'STOCK') {
        document.getElementById('stock-search-input').value = state.stockQuery;
        if (!state.stockPayload) fetchStockData(state.stockQuery);
        else renderAll();
      } else {
        computeActiveIndex();
        renderAll();
      }
    });
  });

  document.getElementById('btn-theme-toggle').addEventListener('click', () => {
    state.dark = !state.dark;
    safeWrite('daybook_v8_theme', state.dark ? 'dark' : 'light');
    renderAll();
  });

  document.getElementById('btn-live-refresh').addEventListener('click', () => {
    if (state.tab === 'STOCK') fetchStockData(state.stockQuery);
    else fetchLiveMarketData(false);
  });

  document.getElementById('btn-phase-switch').addEventListener('click', () => {
    const cur = state.tab === 'STOCK'
      ? (state.stockPhaseResult ? state.stockPhaseResult.phase : 'preopen')
      : (state.currentPhaseResult ? state.currentPhaseResult.phase : 'preopen');
    state.phaseOverride = cur === 'preopen' ? 'intraday' : 'preopen';
    if (state.tab === 'STOCK' && state.stockPayload) {
      const data = state.stockPayload;
      const autoInfo = detectSessionPhase(data.symbol, Date.now());
      const last = data.rows[data.rows.length - 1];
      const fut = state.marketsData.FUTURES || {};
      state.stockPhaseResult = computePhaseForecast(state.stockAnalysis ? state.stockAnalysis.p : 0.5, {
        phase: state.phaseOverride,
        isUs: !data.isKr,
        marketKey: data.isKr ? 'KOSPI' : 'NASDAQ',
        isStock: true,
        sector: data.sector || 'general',
        progress: autoInfo.progress || 0.45,
        vol: state.stockAnalysis ? state.stockAnalysis.vol10 : 2.1,
        curPrice: last ? last[1] : NaN,
        todayOpen: last && Number.isFinite(last[3]) ? last[3] : NaN,
        ewyPct: fut.EWY_pct,
        nqPct: fut.NQ_pct,
        esPct: fut.ES_pct,
        k200Pct: fut.K200_pct,
        peerAvgPct: computeLatestPeerAvgPct(data.peers),
        nxtPrePct: getNxtPrePct(data),
        perpPct: data.perp ? data.perp.pct : NaN,
        investor: data.investor || null
      });
    } else {
      computeActiveIndex();
    }
    renderAll();
  });

  document.getElementById('btn-chart-candle').addEventListener('click', () => {
    state.chartType = 'candle';
    safeWrite('daybook_v8_chart', 'candle');
    renderAll();
  });

  document.getElementById('btn-chart-line').addEventListener('click', () => {
    state.chartType = 'line';
    safeWrite('daybook_v8_chart', 'line');
    renderAll();
  });

  document.getElementById('btn-drawer-toggle').addEventListener('click', () => {
    state.drawerOpen = !state.drawerOpen;
    renderAll();
  });

  document.querySelectorAll('.dtab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.drawerTab = btn.dataset.dtab;
      renderAll();
    });
  });

  const autoBtn = document.getElementById('btn-auto-live');
  if (autoBtn) {
    autoBtn.addEventListener('click', () => {
      state.autoLive = !state.autoLive;
      safeWrite('daybook_v9_autolive', state.autoLive ? '1' : '0');
      renderAll();
      scheduleLiveLoops();
      showToast(state.autoLive ? '실시간 자동 갱신 ON (시세 1.5초 · 전체 15초)' : '실시간 자동 갱신을 일시정지했습니다.');
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      if (fullRefreshTimer) { clearInterval(fullRefreshTimer); fullRefreshTimer = null; }
    } else if (state.autoLive) {
      runSingleTick();
      scheduleLiveLoops();
    }
  });

  document.getElementById('stock-search-form').addEventListener('submit', e => {
    e.preventDefault();
    const val = (document.getElementById('stock-search-input').value || '').trim();
    if (!val) return;
    state.stockQuery = val;
    safeWrite('daybook_v8_stock', val);
    fetchStockData(val);
  });

  const presetsEl = document.getElementById('stock-presets');
  if (presetsEl) {
    presetsEl.addEventListener('click', e => {
      const btn = e.target && e.target.closest ? e.target.closest('.preset-btn') : null;
      if (!btn || !btn.dataset || !btn.dataset.preset) return;
      const val = btn.dataset.preset;
      state.stockQuery = val;
      safeWrite('daybook_v8_stock', val);
      const inp = document.getElementById('stock-search-input');
      if (inp) inp.value = val;
      fetchStockData(val, false);
    });
  }
}


let tickTimer = null;
let fullRefreshTimer = null;
let tickInFlight = false;

function getTickTarget() {
  if (state.tab === 'KOSPI' || state.tab === 'KOSDAQ' || state.tab === 'NASDAQ') {
    return { target: state.tab, intervalMs: state.tab === 'NASDAQ' ? 5000 : 1500 };
  }
  const sp = state.stockPayload;
  if (sp && sp.symbol) {
    if (sp.isKr) {
      const code = sp.symbol.split('.')[0];
      return { target: code, intervalMs: 1500 };
    }
    return { target: sp.symbol, intervalMs: 5000 };
  }
  return null;
}

async function runSingleTick() {
  if (!state.autoLive || document.hidden || !state.workerUrl || tickInFlight || (state.tab === 'STOCK' && state.stockLoading)) return;
  const info = getTickTarget();
  if (!info) return;
  tickInFlight = true;
  try {
    const res = await fetch(`${state.workerUrl.replace(/\/+$/, '')}/tick?target=${encodeURIComponent(info.target)}`);
    if (!res.ok) return;
    const d = await res.json();
    if (!Number.isFinite(d.close)) return;

    const priceEl = document.getElementById('hero-price');
    const retEl = document.getElementById('hero-ret');
    const openLine = document.getElementById('hero-open-line');
    const stampEl = document.getElementById('header-stamp');
    const isStock = state.tab === 'STOCK';
    const isKrwStock = isStock && state.stockPayload && state.stockPayload.currency === 'KRW';
    const isUsStock = isStock && state.stockPayload && !state.stockPayload.isKr;
    const dec = isKrwStock ? 0 : 2;
    const pfx = isUsStock ? '$' : '';
    const ufx = isKrwStock ? '원' : '';

    // Update underlying state so next full render stays consistent
    if (!isStock) {
      if (!state.liveIndices[state.tab]) state.liveIndices[state.tab] = {};
      state.liveIndices[state.tab].close = d.close;
      if (Number.isFinite(d.pct)) state.liveIndices[state.tab].pct = d.pct;
      if (Number.isFinite(d.open)) state.liveIndices[state.tab].open = d.open;
    } else if (state.stockPayload && state.stockPayload.rows && state.stockPayload.rows.length) {
      const last = state.stockPayload.rows[state.stockPayload.rows.length - 1];
      last[1] = d.close;
      if (Number.isFinite(d.pct)) last[2] = d.pct;
      if (Number.isFinite(d.open)) last[3] = d.open;
    }

    if (priceEl) {
      const prevP = state.lastTickPrice;
      priceEl.textContent = pfx + fmtNum(d.close, dec) + ufx;
      if (Number.isFinite(prevP) && prevP !== d.close) {
        const cls = d.close > prevP ? 'flash-up' : 'flash-down';
        priceEl.classList.remove('flash-up', 'flash-down');
        void priceEl.offsetWidth;
        priceEl.classList.add(cls);
        setTimeout(() => priceEl.classList.remove(cls), 420);
      }
      state.lastTickPrice = d.close;
    }
    if (retEl && Number.isFinite(d.pct)) {
      const c = getColors();
      const rc = d.pct >= 0 ? c.up : c.down;
      retEl.textContent = fmtSigned(d.pct, '%');
      retEl.style.color = rc;
      retEl.style.backgroundColor = rc + '1A';
    }
    if (openLine && Number.isFinite(d.open) && d.open > 0) {
      const pr = isStock ? state.stockPhaseResult : state.currentPhaseResult;
      if (pr && pr.phase === 'intraday') {
        const diffPct = ((d.close / d.open) - 1) * 100;
        openLine.textContent = `오늘 시초가 ${pfx}${fmtNum(d.open, dec)}${ufx} (현재 시가 대비 ${fmtSigned(diffPct, '%')})`;
      }
    }
    if (stampEl && d.updatedKst) {
      stampEl.textContent = d.updatedKst.slice(5, 19) + ' LIVE';
    }
  } catch (_) {
  } finally {
    tickInFlight = false;
  }
}

function scheduleLiveLoops() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (fullRefreshTimer) { clearInterval(fullRefreshTimer); fullRefreshTimer = null; }
  if (!state.autoLive || document.hidden) return;
  const info = getTickTarget();
  const tickMs = info ? info.intervalMs : 2000;
  tickTimer = setInterval(runSingleTick, tickMs);
  fullRefreshTimer = setInterval(() => {
    if (!state.autoLive || document.hidden) return;
    if (state.tab === 'STOCK') {
      if (state.stockQuery && !state.stockLoading) fetchStockData(state.stockQuery, true);
    } else {
      fetchLiveMarketData(true);
    }
  }, 15000);
}

function initV8() {
  bindEvents();
  computeActiveIndex();
  renderAll();
  fetchLiveMarketData(true);
  scheduleLiveLoops();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initV8);
} else {
  initV8();
}

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
  liveCandles: {},
  currentForecast: null,
  currentPhaseResult: null,
  simValues: [],
  historyCache: {},
  // Stock observatory state
  stockQuery: safeRead('daybook_v8_stock', 'SK하이닉스'),
  stockLoading: false,
  stockError: '',
  stockPayload: null,
  stockAnalysis: null,
  stockPhaseResult: null,
  scoreDeltas: {}
};

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
  return state.scoreDeltas[scoreKey];
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
  f = applyKrFuturesOverlay(f, krFut, krBasis, key, true);
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
    esPct: futObj.ES_pct,
    k200Pct: futObj.K200_pct
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

function renderCandlestickChart(todayOpen, isIntraday) {
  const svg = document.getElementById('main-chart-svg');
  const candles = getCandlesForView();
  const c = getColors();
  const gridCol = state.dark ? '#252B38' : '#E5E7EB';
  const openCol = state.dark ? '#64748B' : '#94A3B8';

  if (!candles.length) {
    svg.innerHTML = `<text x="180" y="95" text-anchor="middle" fill="${c.muted}" font-size="12" font-weight="700">차트 데이터를 불러오는 중입니다</text>`;
    return;
  }

  let minV = Infinity;
  let maxV = -Infinity;
  for (const row of candles) {
    if (row[3] < minV) minV = row[3];
    if (row[2] > maxV) maxV = row[2];
  }
  if (isIntraday && Number.isFinite(todayOpen)) {
    if (todayOpen < minV) minV = todayOpen;
    if (todayOpen > maxV) maxV = todayOpen;
  }
  const pad = (maxV - minV) * 0.12 || 1;
  minV -= pad;
  maxV += pad;

  const W = 360, H = 190, topP = 14, botP = 18, leftP = 8, rightP = 8;
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

  const step = plotW / candles.length;
  if (state.chartType === 'candle') {
    const bodyW = Math.max(6, step * 0.58);
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
    html += `<circle cx="${lx.toFixed(1)}" cy="${yOf(last[4]).toFixed(1)}" r="4.5" fill="${lineCol}" />`;
  }

  svg.innerHTML = html;
  svg.querySelectorAll('.candle-hit').forEach(el => {
    el.addEventListener('click', () => {
      const row = candles[Number(el.dataset.idx)];
      if (!row) return;
      const dec = state.tab === 'STOCK' && state.stockPayload && state.stockPayload.currency === 'KRW' ? 0 : 2;
      document.getElementById('chart-readout').textContent =
        `${row[0]} · 시가 ${fmtNum(row[1], dec)} · 종가 ${fmtNum(row[4], dec)}`;
    });
  });
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
    presetsEl.querySelectorAll('.preset-btn').forEach(b => {
      b.addEventListener('click', () => {
        state.stockQuery = b.dataset.preset;
        safeWrite('daybook_v8_stock', state.stockQuery);
        document.getElementById('stock-search-input').value = state.stockQuery;
        fetchStockData(state.stockQuery);
      });
    });
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
    nameStr = sp ? sp.name : state.stockQuery;
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
      extraTag = sp.sectorLabel || sp.symbol;
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
    openLine.textContent = phase === 'intraday'
      ? `오늘 시초가 ${prefix}${fmtNum(todayOpen, dec)}${unit} (현재 시가 대비 ${fmtSigned(diffPct, '%')})`
      : `직전 시초가 ${prefix}${fmtNum(todayOpen, dec)}${unit} · 야간 선행지표 반영`;
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
    const sc = Number.isFinite(pr.dirScore) ? pr.dirScore : 0;
    scoreEl.textContent = (sc > 0 ? '+' : '') + sc;
    scoreEl.style.color = sc > 0 ? c.up : sc < 0 ? c.down : c.flat;

    const sKey = (isStock && state.stockPayload ? state.stockPayload.symbol : state.tab) + ':' + pr.phase;
    const dlt = state.scoreDeltas[sKey];
    if (Number.isFinite(dlt) && dlt !== 0) {
      deltaEl.textContent = (dlt > 0 ? '▲+' : '▼') + dlt;
      deltaEl.style.color = dlt > 0 ? c.up : c.down;
    } else {
      deltaEl.textContent = '방향 점수';
      deltaEl.style.color = c.muted;
    }
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
  renderCandlestickChart(todayOpen, phase === 'intraday');

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
  if (btn) { btn.disabled = true; btn.textContent = '↻ 갱신 중'; }
  try {
    const res = await fetch(state.workerUrl.replace(/\/+$/, '') + '/live');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.futures) state.marketsData.FUTURES = data.futures;
    if (data.news) state.marketsData.NEWS = data.news;
    if (data.indices) state.liveIndices = data.indices;
    if (data.candles) state.liveCandles = data.candles;
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
      if (state.currentPhaseResult) recordScoreDelta(state.tab + ':' + state.currentPhaseResult.phase, state.currentPhaseResult.dirScore);
    }
    renderAll();
    if (!silent) showToast('최신 시세와 야간 선행지표를 반영했습니다.');
  } catch (err) {
    if (!silent) showToast('실시간 연결 지연: 기본 수록 데이터로 표시합니다.', true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ 새로고침'; }
  }
}

async function fetchStockData(query) {
  const q = String(query || '').trim();
  if (!q) return;
  if (!state.workerUrl) {
    state.stockError = '하단 설정에서 서버 주소를 입력해 주세요';
    renderAll();
    return;
  }
  state.stockLoading = true;
  state.stockError = '';
  renderAll();
  try {
    const res = await fetch(`${state.workerUrl.replace(/\/+$/, '')}/stock?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '조회 실패');
    state.stockPayload = data;
    let analysis = typeof analyzeStockSeries === 'function' ? analyzeStockSeries(data) : null;
    if (analysis && data.perp && typeof applyStockPerpOverlay === 'function') {
      analysis = applyStockPerpOverlay(analysis, data.perp, true);
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
      progress: autoInfo.progress,
      vol: analysis ? analysis.vol10 : 2.1,
      curPrice: last ? last[1] : NaN,
      todayOpen: last && Number.isFinite(last[3]) ? last[3] : NaN,
      ewyPct: fut.EWY_pct,
      nqPct: fut.NQ_pct,
      esPct: fut.ES_pct,
      k200Pct: fut.K200_pct,
      perpPct: data.perp ? data.perp.pct : NaN
    });
    if (state.stockPhaseResult) recordScoreDelta(data.symbol + ':' + state.stockPhaseResult.phase, state.stockPhaseResult.dirScore);
  } catch (err) {
    state.stockError = err.message || '종목 조회 실패';
  } finally {
    state.stockLoading = false;
    renderAll();
  }
}

function bindEvents() {
  document.querySelectorAll('.main-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      state.phaseOverride = null;
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
        progress: autoInfo.progress || 0.45,
        vol: state.stockAnalysis ? state.stockAnalysis.vol10 : 2.1,
        curPrice: last ? last[1] : NaN,
        todayOpen: last && Number.isFinite(last[3]) ? last[3] : NaN,
        ewyPct: fut.EWY_pct,
        nqPct: fut.NQ_pct,
        esPct: fut.ES_pct,
        k200Pct: fut.K200_pct,
        perpPct: data.perp ? data.perp.pct : NaN
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

  document.getElementById('stock-search-form').addEventListener('submit', e => {
    e.preventDefault();
    const val = (document.getElementById('stock-search-input').value || '').trim();
    if (!val) return;
    state.stockQuery = val;
    safeWrite('daybook_v8_stock', val);
    fetchStockData(val);
  });
}

function initV8() {
  bindEvents();
  computeActiveIndex();
  renderAll();
  fetchLiveMarketData(true);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initV8);
} else {
  initV8();
}

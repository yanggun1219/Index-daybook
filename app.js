// 지수 관측소 v7.1 — 다크모드 금융 터미널 리뉴얼 + 보드/카운트업/차트 드로우 애니메이션

const MARKET_NAMES = {
  KOSPI: '코스피',
  KOSDAQ: '코스닥',
  NASDAQ: '나스닥 종합'
};

function readStorage(key, fallback) {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    return v !== null ? v : fallback;
  } catch (_) {
    return fallback;
  }
}

function writeStorage(key, val) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, val);
  } catch (_) {}
}

const state = {
  marketsData: JSON.parse(JSON.stringify(markets)),
  key: 'KOSPI',
  horizon: 1, // 1 = 다음 거래일, 5 = 향후 5거래일(1주 추세)
  tab: 'forecast',
  theme: readStorage('daybook_theme', 'dark'),
  dateIdx: -1,
  latestValidIdx: -1,
  currentForecast: null,
  historyV4: null,
  historyV2: null,
  historyV1: null,
  simValues: [],
  simNews: 0,
  simKrFut: 0,
  useNewsOverlay: true,
  useKrFutOverlay: true,
  isLiveIntraday: false,
  liveUpdatedKst: '',
  workerUrl: readStorage('daybook_worker_url', ''),
  newsExpanded: false,
  selectedFutChart: null,
  futChartTf: '15m',
  futChartCache: {},
  futChartInstance: null,
  chartInstance: null,
  animateBoard: true,
  activeRafs: [],
  stockQuery: 'SK하이닉스',
  stockSectorOverride: '',
  stockLoading: false,
  stockError: '',
  stockResult: null,
  stockCache: {},
  stockChartInstance: null
};

const fmtPct = x => (x === null || x === undefined || Number.isNaN(x) ? '-' : (100 * x).toFixed(1) + '%');
const fmtMove = x =>
  x === null || x === undefined || Number.isNaN(x)
    ? '사례 없음'
    : (x > 0 ? '+' : '') + x.toFixed(2) + '%';

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isDark() {
  return state.theme === 'dark';
}

function applyTheme(mode, redrawCharts) {
  state.theme = mode === 'light' ? 'light' : 'dark';
  const dark = isDark();
  document.documentElement.classList.toggle('dark', dark);
  writeStorage('daybook_theme', state.theme);
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    btn.textContent = dark ? '☀️' : '🌙';
    btn.setAttribute('aria-label', dark ? '라이트모드로 전환' : '다크모드로 전환');
  }
  const meta = document.getElementById('theme-color-meta');
  if (meta) meta.setAttribute('content', dark ? '#070d19' : '#f1f5f9');
  if (redrawCharts) {
    renderFuturesChart();
    renderPriceChart();
    if (state.tab === 'stock' && state.stockResult) renderStockChart();
  }
}

function cancelActiveAnimations() {
  for (const id of state.activeRafs) cancelAnimationFrame(id);
  state.activeRafs = [];
}

function runCountUps(root) {
  cancelActiveAnimations();
  const els = root.querySelectorAll('[data-countup]');
  const reduceMotion =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  for (const el of els) {
    const target = Number(el.dataset.target);
    const decimals = Number(el.dataset.decimals || 0);
    const suffix = el.dataset.suffix || '';
    const prefix = el.dataset.prefix || '';
    if (!Number.isFinite(target)) continue;
    if (reduceMotion) {
      el.textContent = prefix + target.toFixed(decimals) + suffix;
      continue;
    }
    const duration = Number(el.dataset.duration || 640);
    const start = performance.now();
    const step = now => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const cur = target * eased;
      el.textContent = prefix + cur.toFixed(decimals) + suffix;
      if (t < 1) {
        const rafId = requestAnimationFrame(step);
        state.activeRafs.push(rafId);
      } else {
        el.textContent = prefix + target.toFixed(decimals) + suffix;
      }
    };
    const rafId = requestAnimationFrame(step);
    state.activeRafs.push(rafId);
  }

  // 히어로 게이지 바 애니메이션
  const gaugeBar = root.querySelector('[data-gauge-target]');
  if (gaugeBar) {
    const targetW = gaugeBar.dataset.gaugeTarget;
    if (reduceMotion) {
      gaugeBar.style.width = targetW;
    } else {
      gaugeBar.style.width = '0%';
      const rafId = requestAnimationFrame(() => {
        const rafId2 = requestAnimationFrame(() => {
          gaugeBar.style.width = targetW;
        });
        state.activeRafs.push(rafId2);
      });
      state.activeRafs.push(rafId);
    }
  }
}

function triggerChartReveal(wrapId) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  wrap.classList.remove('chart-reveal-anim');
  void wrap.offsetWidth;
  wrap.classList.add('chart-reveal-anim');
}

function boardCls(step) {
  return state.animateBoard ? ' board-enter stagger-' + step : '';
}

function showToast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className =
    'fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-sm font-medium shadow-xl border transition-opacity ' +
    (isError
      ? 'bg-rose-700 text-white border-rose-500/40'
      : 'bg-slate-900 dark:bg-slate-800 text-white border-slate-700');
  el.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => el.classList.add('hidden'), 3200);
}

function validateImport(obj) {
  const keys = ['KOSPI', 'KOSDAQ', 'NASDAQ'];
  for (const k of keys) {
    if (!obj[k]) continue;
    if (!Array.isArray(obj[k]) || obj[k].length < 25) {
      throw new Error(k + ' 데이터는 최소 25행 이상 배열이어야 합니다.');
    }
    let prev = '';
    for (const row of obj[k]) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row[0])) {
        throw new Error(k + ' 날짜 형식이 YYYY-MM-DD가 아닙니다.');
      }
      if (row[0] <= prev) throw new Error(k + ' 날짜가 오름차순이 아닙니다: ' + row[0]);
      if (!Number.isFinite(row[1]) || !Number.isFinite(row[2])) {
        throw new Error(k + ' 종가 또는 등락률이 숫자가 아닙니다: ' + row[0]);
      }
      prev = row[0];
    }
  }
}

function updateHorizonButtons() {
  for (const btn of document.querySelectorAll('#horizon-tabs button')) {
    const active = Number(btn.dataset.h) === state.horizon;
    btn.setAttribute('aria-pressed', String(active));
    btn.className = active
      ? 'flex-1 py-1.5 px-3 rounded-lg text-xs font-bold bg-teal-600 text-white shadow-sm transition whitespace-nowrap'
      : 'flex-1 py-1.5 px-3 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 transition whitespace-nowrap';
  }
}

function recomputeMarket(id, keepDate, animate) {
  state.key = id;
  state.animateBoard = animate !== false;
  const rows = state.marketsData[id] || [];
  state.historyV4 = null;
  state.historyV2 = null;
  state.historyV1 = null;

  const dateSel = document.getElementById('date-select');
  if (!keepDate) {
    dateSel.replaceChildren();
    let latestValid = -1;
    for (let i = 24; i < rows.length; i++) {
      if (adjacent(rows[i - 1], rows[i])) {
        dateSel.prepend(new Option(rows[i][0], String(i)));
        latestValid = i;
      }
    }
    state.latestValidIdx = latestValid;
    state.dateIdx = latestValid;
    if (latestValid >= 0) dateSel.value = String(latestValid);
  } else {
    let lv = -1;
    for (let i = 24; i < rows.length; i++) if (adjacent(rows[i - 1], rows[i])) lv = i;
    state.latestValidIdx = lv;
  }

  if (state.dateIdx >= 0) {
    const rawF = forecastSingleDay(rows, state.dateIdx, id, state.marketsData, state.horizon);
    const isLatest = state.dateIdx === state.latestValidIdx;
    const liveNewsScore =
      state.marketsData.NEWS && Number.isFinite(state.marketsData.NEWS.sentiment)
        ? state.marketsData.NEWS.sentiment
        : 0;
    const futObj = state.marketsData.FUTURES || {};
    const liveKrFut = Number.isFinite(futObj.K200_pct) ? futObj.K200_pct : 0;
    const liveKrBasis = Number.isFinite(futObj.K200_basis) ? futObj.K200_basis : 0;
    let adjF = isLatest
      ? applyNewsOverlay(rawF, liveNewsScore, id, state.useNewsOverlay)
      : applyNewsOverlay(rawF, 0, id, false);
    adjF = isLatest
      ? applyKrFuturesOverlay(adjF, liveKrFut, liveKrBasis, id, state.useKrFutOverlay)
      : applyKrFuturesOverlay(adjF, 0, 0, id, false);
    state.currentForecast = adjF;
    state.simValues = state.currentForecast ? [...state.currentForecast.rawFeats] : [];
    state.simNews = isLatest ? liveNewsScore : 0;
    state.simKrFut = isLatest ? liveKrFut : 0;
  } else {
    state.currentForecast = null;
    state.simValues = [];
  }

  for (const btn of document.querySelectorAll('#market-tabs button')) {
    const active = btn.dataset.key === id;
    btn.setAttribute('aria-pressed', String(active));
    btn.className = active
      ? 'flex-1 py-2 px-3 rounded-lg text-sm font-bold bg-slate-900 dark:bg-teal-500/20 text-white dark:text-teal-300 border border-transparent dark:border-teal-400/40 shadow-sm transition'
      : 'flex-1 py-2 px-3 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 transition';
  }
  updateHorizonButtons();
  renderAll();
}

function switchTab(tabId) {
  state.tab = tabId;
  state.animateBoard = true;
  for (const btn of document.querySelectorAll('#view-tabs button')) {
    const active = btn.dataset.tab === tabId;
    btn.setAttribute('aria-selected', String(active));
    btn.className = active
      ? 'flex-1 py-2.5 text-sm font-bold border-b-2 border-teal-600 dark:border-teal-400 text-teal-800 dark:text-teal-300 transition'
      : 'flex-1 py-2.5 text-sm font-medium border-b-2 border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition';
  }
  document.getElementById('panel-forecast').classList.toggle('hidden', tabId !== 'forecast');
  document.getElementById('panel-stock').classList.toggle('hidden', tabId !== 'stock');
  document.getElementById('panel-simulator').classList.toggle('hidden', tabId !== 'simulator');
  document.getElementById('panel-backtest').classList.toggle('hidden', tabId !== 'backtest');
  if (tabId === 'forecast') {
    renderPriceChart();
    renderFuturesChart();
  }
  if (tabId === 'stock') {
    renderStockTab();
    if (!state.stockResult && !state.stockLoading && state.workerUrl) {
      fetchAndAnalyzeStock(state.stockQuery, state.stockSectorOverride);
    }
  }
  if (tabId === 'simulator') renderSimulator();
  if (tabId === 'backtest') renderBacktest();
}

function getSparkSeries(key) {
  const fut = state.marketsData.FUTURES || {};
  let series = fut.series && Array.isArray(fut.series[key]) ? fut.series[key] : [];
  if (!series.length && (key === 'CL' || key === 'GC') && Array.isArray(state.marketsData[key])) {
    series = state.marketsData[key].slice(-16).map(r => [r[0].slice(5), r[1]]);
  }
  if (!series.length && key === 'K200' && Array.isArray(state.marketsData.KOSPI)) {
    series = state.marketsData.KOSPI.slice(-16).map(r => [r[0].slice(5), r[1]]);
  }
  return series.map(p => Number(p[1])).filter(Number.isFinite);
}

function buildMiniSparkline(key, isUp) {
  const vals = getSparkSeries(key);
  if (vals.length < 3) return '';
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const w = 56;
  const h = 20;
  const pts = vals.map((v, idx) => {
    const x = (idx / (vals.length - 1)) * w;
    const y = h - 2 - ((v - min) / span) * (h - 4);
    return x.toFixed(1) + ',' + y.toFixed(1);
  });
  const stroke = isUp ? '#fb7185' : '#60a5fa';
  const fill = isUp ? 'rgba(251, 113, 133, 0.14)' : 'rgba(96, 165, 250, 0.14)';
  const areaD = 'M0,' + h + ' L' + pts.join(' L') + ' L' + w + ',' + h + ' Z';
  const lineD = 'M' + pts.join(' L');
  return (
    '<svg viewBox="0 0 ' + w + ' ' + h + '" class="w-14 h-5 shrink-0 overflow-visible" aria-hidden="true">' +
    '<path d="' + areaD + '" fill="' + fill + '" />' +
    '<path d="' + lineD + '" fill="none" stroke="' + stroke + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" pathLength="100" class="spark-path" />' +
    '</svg>'
  );
}

function renderFuturesCard(f) {
  const fut = state.marketsData.FUTURES;
  const items =
    fut && typeof fut === 'object'
      ? [
          { key: 'K200', label: '코스피200 선물', val: fut.K200_pct, price: fut.K200, basis: fut.K200_basis },
          { key: 'NQ', label: '나스닥100 선물', val: fut.NQ_pct, price: fut.NQ },
          { key: 'ES', label: 'S&P500 선물', val: fut.ES_pct, price: fut.ES },
          { key: 'CL', label: 'WTI 유가', val: fut.CL_pct, price: fut.CL },
          { key: 'GC', label: '국제 금', val: fut.GC_pct, price: fut.GC },
          { key: 'BTC', label: 'BTC 무기한 선물', val: fut.BTC_pct, price: fut.BTC, funding: fut.BTC_funding }
        ].filter(x => Number.isFinite(x.val))
      : [];

  let html =
    '<section class="rounded-2xl surface-card p-4 shadow-sm' + boardCls(2) + '">' +
    '<div class="flex items-center justify-between gap-2 mb-2.5">' +
    '<div class="min-w-0">' +
    '<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100">국내·해외 선물 · 원자재</h2>' +
    '<div class="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">' +
    escapeHtml((fut && fut.updatedKst) || '수집 대기') +
    '</div>' +
    '</div>' +
    (state.key !== 'NASDAQ'
      ? '<button id="toggle-krfut-overlay" type="button" class="px-2.5 py-1 rounded-lg text-[11px] font-bold transition shrink-0 ' +
        (state.useKrFutOverlay
          ? 'bg-teal-600 text-white shadow-sm'
          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700') +
        '">국내선물 ' +
        (state.useKrFutOverlay ? 'ON' : 'OFF') +
        '</button>'
      : '') +
    '</div>';

  if (items.length) {
    html +=
      '<div class="grid grid-cols-2 gap-2">' +
      items
        .map(it => {
          const pos = it.val >= 0;
          const selected = state.selectedFutChart === it.key;
          const spark = buildMiniSparkline(it.key, pos);
          return (
            '<button type="button" data-fut-key="' + it.key + '" class="text-left w-full rounded-xl px-3 py-2.5 transition border ' +
            (selected
              ? 'bg-teal-50/70 dark:bg-teal-500/10 border-teal-500 ring-1 ring-teal-500/70'
              : 'surface-inset hover:border-slate-300 dark:hover:border-slate-600') +
            '">' +
            '<div class="flex items-center justify-between gap-1 text-[11px] text-slate-500 dark:text-slate-400">' +
            '<span class="truncate font-medium">' + it.label + '</span>' +
            (Number.isFinite(it.basis)
              ? '<span class="text-[10px] font-bold shrink-0 ' +
                (it.basis >= 0 ? 'text-red-600 dark:text-rose-400' : 'text-blue-600 dark:text-sky-400') +
                '">B ' + (it.basis >= 0 ? '+' : '') + it.basis.toFixed(1) + '</span>'
              : '') +
            (Number.isFinite(it.funding)
              ? '<span class="text-[10px] font-semibold shrink-0 text-indigo-600 dark:text-indigo-300">F ' +
                (it.funding >= 0 ? '+' : '') + it.funding.toFixed(3) + '%</span>'
              : '') +
            '</div>' +
            '<div class="mt-1 flex items-end justify-between gap-1.5">' +
            '<div class="min-w-0 tabular-nums">' +
            '<div class="text-xs font-bold text-slate-900 dark:text-slate-100 leading-tight">' +
            (Number.isFinite(it.price) ? it.price.toLocaleString('en-US') : '-') +
            '</div>' +
            '<div class="text-xs font-extrabold mt-0.5 ' +
            (pos ? 'text-red-600 dark:text-rose-400' : 'text-blue-600 dark:text-sky-400') +
            '">' +
            fmtMove(it.val) +
            '</div>' +
            '</div>' +
            spark +
            '</div>' +
            '</button>'
          );
        })
        .join('') +
      '</div>' +
      '<div class="mt-2 text-[11px] text-slate-400 dark:text-slate-500">각 타일을 누르면 15분봉·1시간봉·일봉 상세 차트가 열립니다. (B=베이시스, F=펀딩비)</div>' +
      (state.selectedFutChart
        ? '<div class="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800">' +
          '<div class="flex items-center justify-between gap-2 mb-2 flex-wrap">' +
          '<span id="fut-chart-title" class="text-xs font-bold text-slate-800 dark:text-slate-100"></span>' +
          '<div class="flex items-center gap-1">' +
          ['15m:15분봉', '1h:1시간봉', '1d:일봉']
            .map(spec => {
              const [tfCode, tfLbl] = spec.split(':');
              const active = state.futChartTf === tfCode;
              return (
                '<button type="button" data-fut-tf="' + tfCode + '" class="px-2 py-0.5 rounded-md text-[11px] font-bold transition ' +
                (active
                  ? 'bg-teal-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700') +
                '">' + tfLbl + '</button>'
              );
            })
            .join('') +
          '<button id="fut-chart-close" type="button" class="ml-1 text-[11px] font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800">닫기</button>' +
          '</div>' +
          '</div>' +
          '<div id="fut-chart-status" class="text-[11px] text-teal-600 dark:text-teal-400 mb-1 hidden"></div>' +
          '<div id="fut-chart-wrap" class="relative h-48 overflow-hidden"><canvas id="futMiniChart"></canvas></div>' +
          '</div>'
        : '');
  } else {
    html +=
      '<p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">상단 <strong>실시간 조회</strong>를 누르거나 GitHub Actions가 실행되면 국내·해외 선물 시세가 채워집니다.</p>';
  }
  html += '</section>';
  return html;
}

function renderNewsCard(f) {
  const news = state.marketsData.NEWS;
  const hasNews = news && Array.isArray(news.items) && news.items.length > 0;
  const score = hasNews && Number.isFinite(news.sentiment) ? news.sentiment : 0;
  const toneClass =
    score >= 15
      ? 'bg-red-50 dark:bg-rose-500/15 text-red-700 dark:text-rose-300 border border-red-200/70 dark:border-rose-500/30'
      : score <= -15
        ? 'bg-blue-50 dark:bg-sky-500/15 text-blue-700 dark:text-sky-300 border border-blue-200/70 dark:border-sky-500/30'
        : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700';
  const toneLabel = !hasNews ? '수집 대기' : score >= 15 ? '우호적' : score <= -15 ? '경계·부정' : '중립';
  const impactNote =
    f && f.newsApplied
      ? '확률 보정 ' + (f.newsImpactPct >= 0 ? '+' : '') + f.newsImpactPct.toFixed(2) + '%p 반영 중'
      : state.useNewsOverlay
        ? '뉴스 수집 시 확률에 자동 보정(최대 ±4.5%p)'
        : '뉴스 보정 꺼짐 (순수 가격 모델)';

  let html =
    '<section class="rounded-2xl surface-card p-4 shadow-sm' + boardCls(3) + '">' +
    '<div class="flex items-center justify-between gap-2 mb-2 flex-wrap">' +
    '<div class="flex items-center gap-2">' +
    '<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100">실시간 증시 · 경제 속보</h2>' +
    '<span class="px-2 py-0.5 rounded-full text-[11px] font-bold tabular-nums ' + toneClass + '">' +
    (hasNews ? '심리 ' + toneLabel + ' (' + (score > 0 ? '+' : '') + score + ')' : toneLabel) +
    '</span>' +
    '</div>' +
    '<button id="toggle-news-overlay" type="button" class="px-2.5 py-1 rounded-lg text-[11px] font-bold transition ' +
    (state.useNewsOverlay
      ? 'bg-teal-600 text-white shadow-sm'
      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700') +
    '">투심 반영 ' +
    (state.useNewsOverlay ? 'ON' : 'OFF') +
    '</button>' +
    '</div>' +
    '<div class="text-[11px] text-slate-500 dark:text-slate-400 mb-2">' + impactNote + '</div>';

  if (hasNews) {
    html +=
      '<ul class="divide-y divide-slate-100 dark:divide-slate-800/90 text-xs">' +
      news.items
        .slice(0, state.newsExpanded ? news.items.length : 3)
        .map(item => {
          const safeUrl = /^https?:\/\//.test(item.url || '') ? item.url : '';
          const titleHtml = safeUrl
            ? '<a href="' +
              escapeHtml(safeUrl) +
              '" target="_blank" rel="noopener noreferrer" class="font-medium text-slate-800 dark:text-slate-100 hover:text-teal-600 dark:hover:text-teal-300 underline-offset-2 hover:underline">' +
              escapeHtml(item.title) +
              '</a>'
            : '<span class="font-medium text-slate-800 dark:text-slate-100">' + escapeHtml(item.title) + '</span>';
          const summaryHtml = item.summary
            ? '<div class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">' + escapeHtml(item.summary) + '</div>'
            : '';
          return (
            '<li class="py-2.5 flex items-start justify-between gap-2">' +
            '<div class="leading-snug">' +
            titleHtml +
            summaryHtml +
            (item.source ? '<div class="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">' + escapeHtml(item.source) + '</div>' : '') +
            '</div>' +
            '</li>'
          );
        })
        .join('') +
      '</ul>' +
      (news.items.length > 3
        ? '<button id="toggle-news-expand" type="button" class="mt-2.5 w-full py-2 rounded-xl surface-inset hover:border-teal-500/50 text-xs font-semibold text-slate-700 dark:text-slate-200 transition">' +
          (state.newsExpanded ? '뉴스 접기 (3건만 보기) ▴' : '최신 뉴스 전체보기 (총 ' + news.items.length + '건) ▾') +
          '</button>'
        : '');
  } else {
    html +=
      '<p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">아직 수집된 뉴스가 없습니다. 상단 <strong>실시간 조회</strong>를 누르면 국내 증시·경제 속보가 표시됩니다.</p>';
  }
  html += '</section>';
  return html;
}

function renderForecast() {
  const rows = state.marketsData[state.key] || [];
  const i = state.dateIdx;
  const f = state.currentForecast;
  const r = rows[i];
  const container = document.getElementById('forecast-content');

  if (!f || !r) {
    container.innerHTML =
      '<div class="surface-card rounded-2xl p-6 text-center text-slate-600 dark:text-slate-400">유효한 예측을 계산할 수 있는 과거 표본이 부족합니다 (최소 18거래일 필요).</div>';
    return;
  }

  const horizonLabel = state.horizon === 5 ? '향후 5거래일(1주) 상승 확률' : '다음 거래일 상승 확률';
  const isBull = f.p >= 0.5;

  // 상태별 히어로 글로우 그라데이션
  const heroGlow =
    f.signal.tone === 'teal'
      ? 'radial-gradient(circle at 18% 0%, rgba(251, 113, 133, 0.24), transparent 58%)'
      : f.signal.tone === 'rose'
        ? 'radial-gradient(circle at 18% 0%, rgba(56, 189, 248, 0.24), transparent 58%)'
        : 'radial-gradient(circle at 18% 0%, rgba(45, 212, 191, 0.18), transparent 58%)';

  const sigBadgeClass =
    f.signal.tone === 'teal'
      ? 'bg-rose-500/20 text-rose-200 border border-rose-400/40'
      : f.signal.tone === 'rose'
        ? 'bg-sky-500/20 text-sky-200 border border-sky-400/40'
        : 'bg-slate-800/90 text-slate-300 border border-slate-700';

  const regimeBadgeClass =
    f.regimeTone === 'rose'
      ? 'bg-rose-500/20 text-rose-200 border border-rose-500/25'
      : f.regimeTone === 'teal'
        ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/25'
        : 'bg-slate-800 text-slate-300 border border-slate-700';

  // 시나리오 범위 바 (0% 중심 기준 좌/우 폭 계산)
  const maxAbs = Math.max(Math.abs(f.low), Math.abs(f.high), 1.5);
  const leftBarPct = Math.min(50, (Math.max(0, -f.low) / maxAbs) * 46);
  const rightBarPct = Math.min(50, (Math.max(0, f.high) / maxAbs) * 46);
  const loPt = Math.round(r[1] * (1 + f.low / 100));
  const hiPt = Math.round(r[1] * (1 + f.high / 100));

  const extraSection = f.candidates.length
    ? '<section class="rounded-2xl surface-card p-4 shadow-sm' + boardCls(5) + '">' +
      '<div class="flex items-center justify-between mb-1.5">' +
      '<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100">확장 지표 상태</h2>' +
      '<span class="text-xs text-slate-500 dark:text-slate-400">' +
      (state.key === 'NASDAQ' && f.krLeadDate
        ? '한국장 선행 ' + f.krLeadDate + ' 반영'
        : '미국장 ' + (f.usDate || '미수록') + (f.usSessions > 1 ? ' (' + f.usSessions + '일 누적)' : '')) +
      '</span>' +
      '</div>' +
      '<div class="divide-y divide-slate-100 dark:divide-slate-800/90">' +
      f.candidates
        .map(k => {
          let val = f.extra[k];
          let isLiveOverlayVal = false;
          const isLatestRow = state.dateIdx === state.latestValidIdx;
          if (!Number.isFinite(val) && isLatestRow) {
            const futLive = state.marketsData.FUTURES || {};
            const newsLive = state.marketsData.NEWS || {};
            if (k === 'krFut' && Number.isFinite(futLive.K200_pct)) { val = futLive.K200_pct; isLiveOverlayVal = true; }
            else if (k === 'krBasis' && Number.isFinite(futLive.K200_basis)) { val = futLive.K200_basis; isLiveOverlayVal = true; }
            else if (k === 'oil' && Number.isFinite(futLive.CL_pct)) { val = futLive.CL_pct; isLiveOverlayVal = true; }
            else if (k === 'gold' && Number.isFinite(futLive.GC_pct)) { val = futLive.GC_pct; isLiveOverlayVal = true; }
            else if (k === 'news' && Array.isArray(newsLive.items) && newsLive.items.length && Number.isFinite(newsLive.sentiment)) { val = newsLive.sentiment; isLiveOverlayVal = true; }
          }
          const hasVal = Number.isFinite(val);
          const isActive = f.active.includes(k);
          const badge = isActive
            ? '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-teal-50 dark:bg-teal-500/15 text-teal-800 dark:text-teal-300">모델 반영</span>'
            : isLiveOverlayVal
              ? '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-50 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300">실시간 보정</span>'
              : hasVal
                ? '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300">표본 대기</span>'
                : '<span class="px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">갱신 대기</span>';
          return (
            '<div class="py-2 flex items-center justify-between gap-2 text-xs">' +
            '<span class="font-medium text-slate-700 dark:text-slate-300">' + EXTRA_META[k].label + '</span>' +
            '<div class="flex items-center gap-2 tabular-nums">' +
            '<span class="font-semibold text-slate-900 dark:text-slate-100">' +
            (hasVal ? val.toFixed(2) + EXTRA_META[k].unit : '-') +
            '</span>' +
            badge +
            '</div>' +
            '</div>'
          );
        })
        .join('') +
      '</div>' +
      '</section>'
    : '';

  const contribRows = f.contributions
    .map(c => {
      const pos = c.impactPct >= 0;
      const barW = Math.min(100, Math.abs(c.impactPct) * 8);
      return (
        '<div class="py-2 border-b border-slate-100 dark:border-slate-800/90 last:border-b-0">' +
        '<div class="flex items-center justify-between text-xs mb-1">' +
        '<span class="font-medium text-slate-700 dark:text-slate-300">' +
        c.label +
        ' <span class="text-slate-400 dark:text-slate-500 font-normal">(' +
        (c.value > 0 && c.key !== 'vol10' && c.key !== 'vix' && c.key !== 'breadth' ? '+' : '') +
        c.value.toFixed(2) +
        c.unit +
        ')</span></span>' +
        '<span class="font-bold tabular-nums ' +
        (pos ? 'text-red-600 dark:text-rose-400' : 'text-blue-600 dark:text-sky-400') +
        '">' +
        (pos ? '+' : '') +
        c.impactPct.toFixed(2) +
        '%p</span>' +
        '</div>' +
        '<div class="h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">' +
        '<div class="h-full rounded-full ' +
        (pos ? 'bg-red-500 dark:bg-rose-400' : 'bg-blue-500 dark:bg-sky-400') +
        '" style="width:' +
        Math.max(4, barW).toFixed(1) +
        '%"></div>' +
        '</div>' +
        '</div>'
      );
    })
    .join('');

  const fwdActual = forwardReturn(rows, i, state.horizon);
  const nextActual =
    fwdActual !== null
      ? '<span class="font-bold ' +
        (fwdActual >= 0 ? 'text-red-600 dark:text-rose-400' : 'text-blue-600 dark:text-sky-400') +
        '">' +
        fmtMove(fwdActual) +
        '</span> (' +
        rows[i + state.horizon][0] +
        ')'
      : '<span class="text-slate-500 dark:text-slate-400">마감 전</span>';

  const heroCard =
    '<section class="rounded-2xl bg-slate-900 dark:bg-[#0d1629] text-white p-5 border border-slate-800 dark:border-slate-700/70 shadow-lg relative overflow-hidden' +
    boardCls(1) +
    '" style="background-image:' + heroGlow + '">' +
    '<div class="flex items-center justify-between gap-2 flex-wrap">' +
    '<span class="text-xs font-semibold text-slate-300">' +
    MARKET_NAMES[state.key] +
    ' ' +
    horizonLabel +
    '</span>' +
    '<div class="flex items-center gap-1.5 flex-wrap">' +
    (state.isLiveIntraday
      ? '<span class="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-200 border border-amber-400/40 font-semibold">장중 잠정</span>'
      : '') +
    '<span class="text-[11px] px-2 py-0.5 rounded-full ' + regimeBadgeClass + '">' + f.regime + '</span>' +
    '<span class="text-[11px] px-2 py-0.5 rounded-full bg-slate-800/90 text-teal-300 border border-slate-700 tabular-nums">표본 ' +
    f.n +
    '일</span>' +
    '</div>' +
    '</div>' +
    '<div class="mt-3 flex items-center justify-between gap-3">' +
    '<div class="text-4xl sm:text-5xl font-extrabold tracking-tight tabular-nums ' +
    (isBull ? 'text-rose-400' : 'text-sky-400') +
    '"' +
    (state.animateBoard
      ? ' data-countup="1" data-target="' + (f.p * 100).toFixed(1) + '" data-decimals="1" data-suffix="%"'
      : '') +
    '>' +
    fmtPct(f.p) +
    '</div>' +
    '<div class="text-right">' +
    '<span class="inline-block text-xs font-bold px-2.5 py-1 rounded-full ' + sigBadgeClass + '">' +
    f.signal.label +
    '</span>' +
    '<div class="text-xs text-slate-400 mt-1.5 tabular-nums">종합 점수 <strong class="text-white"' +
    (state.animateBoard ? ' data-countup="1" data-target="' + f.score + '" data-decimals="0"' : '') +
    '>' +
    f.score +
    '</strong> / 100</div>' +
    '</div>' +
    '</div>' +
    '<div class="mt-4 relative h-2.5 w-full bg-slate-800 rounded-full overflow-hidden">' +
    '<div class="absolute left-1/2 top-0 bottom-0 w-px bg-slate-500/60 z-10"></div>' +
    '<div class="h-full rounded-full transition-all duration-700 ease-out ' +
    (isBull ? 'bg-gradient-to-r from-rose-500 to-rose-300' : 'bg-gradient-to-r from-blue-600 to-sky-400') +
    '" data-gauge-target="' + (f.p * 100).toFixed(1) + '%" style="width:' + (f.p * 100).toFixed(1) + '%"></div>' +
    '</div>' +
    '<div class="mt-2.5 flex items-center justify-between text-xs text-slate-300 tabular-nums">' +
    '<span>상승 <strong class="text-rose-300">' + fmtPct(f.p) + '</strong> · 하락·보합 <strong class="text-sky-300">' + fmtPct(f.down) + '</strong></span>' +
    '<span class="text-slate-400">기준 빈도 ' + fmtPct(f.base) + '</span>' +
    '</div>' +
    '</section>';

  const bandCard =
    '<section class="rounded-2xl surface-card p-4 shadow-sm' + boardCls(4) + '">' +
    '<div class="flex items-center justify-between mb-2.5">' +
    '<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100">' +
    (state.horizon === 5 ? '향후 5거래일 예상 등락 폭 (80% 구간)' : '다음 거래일 예상 등락 폭 (80% 구간)') +
    '</h2>' +
    '<span class="text-xs text-slate-500 dark:text-slate-400 tabular-nums">10일 변동성 ' + f.vol.toFixed(2) + '%</span>' +
    '</div>' +
    '<div class="rounded-xl surface-inset px-3.5 py-3">' +
    '<div class="flex items-center justify-between gap-2">' +
    '<span class="text-xs font-medium text-slate-600 dark:text-slate-300">시나리오 밴드 (P10 ~ P90)</span>' +
    '<span class="text-sm font-extrabold text-slate-900 dark:text-white tabular-nums">' +
    '<span class="text-blue-600 dark:text-sky-400">' + fmtMove(f.low) + '</span>' +
    ' <span class="text-slate-400 font-normal">~</span> ' +
    '<span class="text-red-600 dark:text-rose-400">' + fmtMove(f.high) + '</span>' +
    '</span>' +
    '</div>' +
    '<div class="mt-2.5 relative h-3 rounded-full bg-slate-200/80 dark:bg-slate-800 overflow-hidden">' +
    '<div class="absolute top-0 bottom-0 bg-gradient-to-l from-sky-500 to-blue-600/80 rounded-l-full bar-grow-left" style="right:50%;width:' +
    leftBarPct.toFixed(1) + '%"></div>' +
    '<div class="absolute top-0 bottom-0 bg-gradient-to-r from-rose-500 to-red-500/80 rounded-r-full bar-grow-right" style="left:50%;width:' +
    rightBarPct.toFixed(1) + '%"></div>' +
    '<div class="absolute left-1/2 top-0 bottom-0 w-0.5 bg-slate-700 dark:bg-slate-200 -translate-x-1/2"></div>' +
    '</div>' +
    '<div class="mt-1.5 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">' +
    '<span>하단 약 <strong class="text-blue-600 dark:text-sky-300">' + loPt.toLocaleString('ko-KR') + ' pt</strong></span>' +
    '<span class="text-[10px]">0% 기준</span>' +
    '<span>상단 약 <strong class="text-red-600 dark:text-rose-300">' + hiPt.toLocaleString('ko-KR') + ' pt</strong></span>' +
    '</div>' +
    '</div>' +
    '<div class="mt-2.5 grid grid-cols-2 gap-2.5">' +
    '<div class="rounded-xl bg-red-50/80 dark:bg-rose-500/10 border border-red-100 dark:border-rose-500/20 px-3 py-2.5">' +
    '<div class="text-[11px] text-red-700 dark:text-rose-300 font-medium">상승 시 중앙값</div>' +
    '<div class="text-base font-extrabold text-red-700 dark:text-rose-400 tabular-nums mt-0.5">' + fmtMove(f.gain) + '</div>' +
    '</div>' +
    '<div class="rounded-xl bg-blue-50/80 dark:bg-sky-500/10 border border-blue-100 dark:border-sky-500/20 px-3 py-2.5">' +
    '<div class="text-[11px] text-blue-700 dark:text-sky-300 font-medium">하락 시 중앙값</div>' +
    '<div class="text-base font-extrabold text-blue-700 dark:text-sky-400 tabular-nums mt-0.5">' + fmtMove(f.loss) + '</div>' +
    '</div>' +
    '</div>' +
    '<div class="mt-2.5 flex items-center justify-between text-xs text-slate-600 dark:text-slate-400 pt-2 border-t border-slate-100 dark:border-slate-800/90">' +
    '<span>기준 종가 (' + r[0] + '): <strong class="text-slate-900 dark:text-slate-100 tabular-nums">' +
    r[1].toLocaleString('ko-KR') + ' pt</strong> (' + fmtMove(r[2]) + ')</span>' +
    '<span>실제: ' + nextActual + '</span>' +
    '</div>' +
    '</section>';

  const priceChartCard =
    '<section class="rounded-2xl surface-card p-4 shadow-sm' + boardCls(5) + '">' +
    '<div class="flex items-center justify-between mb-2">' +
    '<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100">최근 30거래일 종가 추이 및 예상 밴드</h2>' +
    '<span class="text-xs text-slate-500 dark:text-slate-400">' +
    (state.horizon === 5 ? '+5거래일 P10~P90' : '+1거래일 P10~P90') +
    '</span>' +
    '</div>' +
    '<div id="price-chart-wrap" class="relative h-56 overflow-hidden"><canvas id="priceChart"></canvas></div>' +
    '</section>';

  const contribCard =
    '<section class="rounded-2xl surface-card p-4 shadow-sm' + boardCls(6) + '">' +
    '<div class="flex items-center justify-between mb-1.5">' +
    '<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100">변수별 확률 기여도 분해</h2>' +
    '<span class="text-xs text-slate-500 dark:text-slate-400">시간감쇠 정규화 기준</span>' +
    '</div>' +
    '<div>' + contribRows + '</div>' +
    '</section>';

  // Z 폴드 펼친 화면 / 태블릿 / 데스크톱 2단 대시보드 + 모바일 1단 자동 전환
  container.innerHTML =
    '<div class="lg:grid lg:grid-cols-12 lg:gap-4 lg:items-start">' +
    '<div class="lg:col-span-6 space-y-3">' +
    heroCard +
    bandCard +
    priceChartCard +
    contribCard +
    '</div>' +
    '<div class="lg:col-span-6 space-y-3 mt-3 lg:mt-0">' +
    renderFuturesCard(f) +
    renderNewsCard(f) +
    extraSection +
    '</div>' +
    '</div>';

  if (state.animateBoard) {
    runCountUps(container);
    state.animateBoard = false;
  }

  const toggleKrBtn = document.getElementById('toggle-krfut-overlay');
  if (toggleKrBtn) {
    toggleKrBtn.addEventListener('click', () => {
      state.useKrFutOverlay = !state.useKrFutOverlay;
      recomputeMarket(state.key, true, false);
      showToast(state.useKrFutOverlay ? '코스피200 국내선물 보정을 켰습니다.' : '국내선물 보정을 껐습니다.');
    });
  }
  const toggleBtn = document.getElementById('toggle-news-overlay');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      state.useNewsOverlay = !state.useNewsOverlay;
      recomputeMarket(state.key, true, false);
      showToast(state.useNewsOverlay ? '뉴스 투심 보정을 켰습니다.' : '순수 가격 모델 확률로 전환했습니다.');
    });
  }
  for (const btn of document.querySelectorAll('button[data-fut-key]')) {
    btn.addEventListener('click', () => {
      const k = btn.dataset.futKey;
      state.selectedFutChart = state.selectedFutChart === k ? null : k;
      state.animateBoard = false;
      renderForecast();
    });
  }
  for (const tfBtn of document.querySelectorAll('button[data-fut-tf]')) {
    tfBtn.addEventListener('click', () => {
      state.futChartTf = tfBtn.dataset.futTf;
      state.animateBoard = false;
      renderForecast();
    });
  }
  const closeFutBtn = document.getElementById('fut-chart-close');
  if (closeFutBtn) {
    closeFutBtn.addEventListener('click', () => {
      state.selectedFutChart = null;
      state.animateBoard = false;
      renderForecast();
    });
  }
  const expandNewsBtn = document.getElementById('toggle-news-expand');
  if (expandNewsBtn) {
    expandNewsBtn.addEventListener('click', () => {
      state.newsExpanded = !state.newsExpanded;
      state.animateBoard = false;
      renderForecast();
    });
  }
  renderFuturesChart();
  renderPriceChart();
}

async function renderFuturesChart() {
  const key = state.selectedFutChart;
  const tf = state.futChartTf || '15m';
  const canvas = document.getElementById('futMiniChart');
  const titleEl = document.getElementById('fut-chart-title');
  const statusEl = document.getElementById('fut-chart-status');
  if (!key || !canvas || typeof Chart === 'undefined') return;
  if (state.futChartInstance) {
    state.futChartInstance.destroy();
    state.futChartInstance = null;
  }

  const tfName = tf === '15m' ? '15분봉' : tf === '1h' ? '1시간봉' : '일봉';
  const labelMap = {
    K200: '코스피200 (' + tfName + ')',
    NQ: '나스닥100 선물 (' + tfName + ')',
    ES: 'S&P500 선물 (' + tfName + ')',
    CL: 'WTI 국제유가 (' + tfName + ')',
    GC: '국제 금 선물 (' + tfName + ')',
    BTC: 'BTC 무기한 선물 (' + tfName + ')'
  };
  if (titleEl) titleEl.textContent = labelMap[key] || key;

  const cacheId = key + ':' + tf;
  let points = state.futChartCache[cacheId] || [];
  const baseUrl = (state.workerUrl || '').trim().replace(/\/+$/, '');

  if (!points.length && baseUrl) {
    if (statusEl) {
      statusEl.textContent = tfName + ' 데이터를 불러오는 중...';
      statusEl.classList.remove('hidden');
    }
    try {
      const res = await fetch(baseUrl + '/chart?key=' + encodeURIComponent(key) + '&tf=' + encodeURIComponent(tf));
      if (res.ok) {
        const j = await res.json();
        if (Array.isArray(j.points) && j.points.length) {
          points = j.points;
          state.futChartCache[cacheId] = points;
        }
      }
    } catch (_) {}
    if (statusEl) statusEl.classList.add('hidden');
  }

  if (!points.length) {
    const fut = state.marketsData.FUTURES || {};
    let series = fut.series && Array.isArray(fut.series[key]) ? fut.series[key] : [];
    if (!series.length && (key === 'CL' || key === 'GC') && Array.isArray(state.marketsData[key])) {
      series = state.marketsData[key].slice(-20).map(r => [r[0].slice(5), r[1]]);
    }
    if (!series.length && key === 'K200' && Array.isArray(state.marketsData.KOSPI)) {
      series = state.marketsData.KOSPI.slice(-20).map(r => [r[0].slice(5), r[1]]);
    }
    points = series.map(p => [p[0], p[1], p[1], p[1]]);
  }

  if (state.selectedFutChart !== key || state.futChartTf !== tf || !points.length) return;
  const freshCanvas = document.getElementById('futMiniChart');
  if (!freshCanvas) return;

  const dark = isDark();
  const labels = points.map(p => p[0]);
  const vals = points.map(p => p[1]);
  const isUp = vals[vals.length - 1] >= vals[0];
  const stroke = isUp ? (dark ? '#fb7185' : '#dc2626') : (dark ? '#60a5fa' : '#2563eb');
  const fillBg = isUp
    ? dark ? 'rgba(251, 113, 133, 0.14)' : 'rgba(220, 38, 38, 0.08)'
    : dark ? 'rgba(96, 165, 250, 0.14)' : 'rgba(37, 99, 235, 0.08)';
  const tickColor = dark ? '#94a3b8' : '#64748b';
  const gridColor = dark ? 'rgba(148, 163, 184, 0.12)' : '#f1f5f9';

  state.futChartInstance = new Chart(freshCanvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: labelMap[key] || key,
        data: vals,
        borderColor: stroke,
        backgroundColor: fillBg,
        borderWidth: 2,
        pointRadius: points.length > 35 ? 0 : 2,
        pointHoverRadius: 4,
        fill: true,
        tension: 0.18
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: dark ? '#0f172a' : '#1e293b',
          borderColor: dark ? 'rgba(148,163,184,0.25)' : 'transparent',
          borderWidth: dark ? 1 : 0,
          callbacks: {
            label: ctx => {
              const p = points[ctx.dataIndex];
              if (p && p.length >= 4 && p[2] !== p[3]) {
                return '종가 ' + p[1].toLocaleString('en-US') + ' (고 ' + p[2].toLocaleString('en-US') + ' / 저 ' + p[3].toLocaleString('en-US') + ')';
              }
              return '가격 ' + Number(ctx.parsed.y).toLocaleString('en-US');
            }
          }
        }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 5, font: { size: 10 }, color: tickColor }, grid: { display: false } },
        y: { ticks: { font: { size: 10 }, color: tickColor }, grid: { color: gridColor } }
      }
    }
  });
  triggerChartReveal('fut-chart-wrap');
}

function renderPriceChart() {
  const canvas = document.getElementById('priceChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const rows = state.marketsData[state.key] || [];
  const i = state.dateIdx;
  const f = state.currentForecast;
  if (!f || !rows[i]) return;

  if (state.chartInstance) {
    state.chartInstance.destroy();
    state.chartInstance = null;
  }

  const dark = isDark();
  const slice = rows.slice(Math.max(0, i - 29), i + 1);
  const labels = slice.map(v => v[0].slice(5));
  labels.push(state.horizon === 5 ? '+5일(예상)' : '다음날(예상)');

  const closeData = slice.map(v => v[1]);
  const lastClose = closeData[closeData.length - 1];
  const hiPt = Number((lastClose * (1 + f.high / 100)).toFixed(2));
  const loPt = Number((lastClose * (1 + f.low / 100)).toFixed(2));
  const midPt = Number((lastClose * (1 + (f.high + f.low) / 200)).toFixed(2));

  const upperBand = new Array(slice.length - 1).fill(null).concat([lastClose, hiPt]);
  const lowerBand = new Array(slice.length - 1).fill(null).concat([lastClose, loPt]);
  const closeLine = closeData.concat([null]);
  const projLine = new Array(slice.length - 1).fill(null).concat([lastClose, midPt]);

  const tickColor = dark ? '#94a3b8' : '#64748b';
  const gridColor = dark ? 'rgba(148, 163, 184, 0.12)' : '#f1f5f9';

  state.chartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '종가 (pt)',
          data: closeLine,
          borderColor: dark ? '#2dd4bf' : '#0f766e',
          backgroundColor: dark ? 'rgba(45, 212, 191, 0.12)' : 'rgba(15, 118, 110, 0.08)',
          borderWidth: 2.2,
          pointRadius: 1.5,
          tension: 0.2
        },
        {
          label: '예상 상단 (P90)',
          data: upperBand,
          borderColor: dark ? '#fb7185' : '#dc2626',
          borderDash: [4, 4],
          borderWidth: 1.5,
          pointRadius: 3,
          fill: false
        },
        {
          label: '예상 하단 (P10)',
          data: lowerBand,
          borderColor: dark ? '#60a5fa' : '#2563eb',
          borderDash: [4, 4],
          borderWidth: 1.5,
          pointRadius: 3,
          fill: '-1',
          backgroundColor: dark ? 'rgba(56, 189, 248, 0.15)' : 'rgba(14, 165, 233, 0.12)'
        },
        {
          label: '중심 추정',
          data: projLine,
          borderColor: dark ? '#cbd5e1' : '#334155',
          borderDash: [2, 2],
          borderWidth: 1.5,
          pointRadius: 3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { boxWidth: 10, font: { size: 11 }, color: tickColor }
        }
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 6, font: { size: 11 }, color: tickColor },
          grid: { display: false }
        },
        y: {
          ticks: { font: { size: 11 }, color: tickColor },
          grid: { color: gridColor }
        }
      }
    }
  });
  triggerChartReveal('price-chart-wrap');
}

function renderSimulator() {
  const f = state.currentForecast;
  const container = document.getElementById('simulator-content');
  if (!f) {
    container.innerHTML =
      '<div class="surface-card rounded-2xl p-6 text-center text-slate-600 dark:text-slate-400">시뮬레이션할 기준 모델이 없습니다.</div>';
    return;
  }

  const meta = f.meta;
  if (state.simValues.length !== meta.length) {
    state.simValues = [...f.rawFeats];
  }

  const volIdx = meta.findIndex(m => m.key === 'vol10');
  const getSimVol = () => (volIdx >= 0 ? state.simValues[volIdx] : f.vol);
  const simRaw = predictWithModel(f.modelRef, state.simValues, getSimVol(), state.key, meta, state.horizon);
  const simOut = applyKrFuturesOverlay(applyNewsOverlay(simRaw, state.simNews, state.key, true), state.simKrFut, 0, state.key, state.key !== 'NASDAQ');
  const diffP = (simOut.p - f.p) * 100;

  const slidersHtml = meta
    .map((m, idx) => {
      const val = state.simValues[idx];
      return (
        '<div class="py-2.5 border-b border-slate-100 dark:border-slate-800/90 last:border-b-0">' +
        '<div class="flex items-center justify-between text-xs mb-1.5">' +
        '<label for="sim-' + idx + '" class="font-semibold text-slate-700 dark:text-slate-300">' + m.label + '</label>' +
        '<span id="sim-val-' + idx + '" class="font-bold text-slate-900 dark:text-slate-100 tabular-nums">' +
        (val > 0 && m.key !== 'vol10' && m.key !== 'vix' && m.key !== 'breadth' ? '+' : '') +
        val.toFixed(2) +
        m.unit +
        '</span>' +
        '</div>' +
        '<input id="sim-' + idx + '" data-idx="' + idx + '" type="range" min="' + m.min + '" max="' + m.max + '" step="' + m.step + '" value="' + val.toFixed(2) + '" class="w-full accent-teal-600 dark:accent-teal-400 cursor-pointer" />' +
        '</div>'
      );
    })
    .join('');

  container.innerHTML =
    '<section class="rounded-2xl bg-slate-900 dark:bg-[#0d1629] text-white p-5 border border-slate-800 dark:border-slate-700/70 shadow-lg' + boardCls(1) + '">' +
    '<div class="flex items-center justify-between">' +
    '<span class="text-xs text-slate-300">' +
    MARKET_NAMES[state.key] + ' (' + (state.horizon === 5 ? '5거래일' : '1거래일') + ') 시뮬레이션</span>' +
    '<span id="sim-change" class="text-xs font-bold tabular-nums ' +
    (diffP >= 0 ? 'text-rose-300' : 'text-sky-300') +
    '">기존 대비 ' + (diffP >= 0 ? '+' : '') + diffP.toFixed(1) + '%p</span>' +
    '</div>' +
    '<div class="mt-2 flex items-baseline justify-between">' +
    '<div id="sim-prob" class="text-4xl font-extrabold text-teal-300 tabular-nums">' + fmtPct(simOut.p) + '</div>' +
    '<div id="sim-band" class="text-sm font-semibold text-slate-200 tabular-nums">' + fmtMove(simOut.low) + ' ~ ' + fmtMove(simOut.high) + '</div>' +
    '</div>' +
    '<p class="mt-2 text-xs text-slate-400">장전 나스닥·환율·유가·변동성을 조정해 확률과 80% 예상 밴드 변화를 즉시 확인합니다.</p>' +
    '</section>' +
    '<section class="mt-3 rounded-2xl surface-card p-4 shadow-sm' + boardCls(2) + '">' +
    '<div class="flex items-center justify-between mb-2">' +
    '<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100">입력 변수 조정</h2>' +
    '<button id="sim-reset" type="button" class="text-xs font-semibold text-teal-700 dark:text-teal-300 hover:text-teal-900 dark:hover:text-teal-200 px-2.5 py-1 rounded-lg bg-teal-50 dark:bg-teal-500/15 border border-teal-200/70 dark:border-teal-500/30">현재 기준값 복원</button>' +
    '</div>' +
    '<div>' +
    slidersHtml +
    (state.key !== 'NASDAQ'
      ? '<div class="py-2.5 border-t border-slate-100 dark:border-slate-800/90">' +
        '<div class="flex items-center justify-between text-xs mb-1.5">' +
        '<label for="sim-krfut" class="font-semibold text-teal-800 dark:text-teal-300">코스피200 국내선물 등락 (KIS)</label>' +
        '<span id="sim-krfut-val" class="font-bold text-teal-900 dark:text-teal-200 tabular-nums">' +
        (state.simKrFut > 0 ? '+' : '') + state.simKrFut.toFixed(2) + '%</span>' +
        '</div>' +
        '<input id="sim-krfut" type="range" min="-6" max="6" step="0.1" value="' + state.simKrFut.toFixed(2) + '" class="w-full accent-teal-600 dark:accent-teal-400 cursor-pointer" />' +
        '</div>'
      : '') +
    '<div class="py-2.5 border-t border-slate-100 dark:border-slate-800/90">' +
    '<div class="flex items-center justify-between text-xs mb-1.5">' +
    '<label for="sim-news" class="font-semibold text-teal-800 dark:text-teal-300">증시 뉴스 투심 점수 (오버레이)</label>' +
    '<span id="sim-news-val" class="font-bold text-teal-900 dark:text-teal-200 tabular-nums">' +
    (state.simNews > 0 ? '+' : '') + state.simNews + '점</span>' +
    '</div>' +
    '<input id="sim-news" type="range" min="-100" max="100" step="5" value="' + state.simNews + '" class="w-full accent-teal-600 dark:accent-teal-400 cursor-pointer" />' +
    '</div>' +
    '</div>' +
    '</section>';

  const refreshSimDisplay = () => {
    const rawUpd = predictWithModel(f.modelRef, state.simValues, getSimVol(), state.key, meta, state.horizon);
    const updated = applyKrFuturesOverlay(applyNewsOverlay(rawUpd, state.simNews, state.key, true), state.simKrFut, 0, state.key, state.key !== 'NASDAQ');
    document.getElementById('sim-prob').textContent = fmtPct(updated.p);
    const dPct = (updated.p - f.p) * 100;
    const chEl = document.getElementById('sim-change');
    chEl.textContent = '기존 대비 ' + (dPct >= 0 ? '+' : '') + dPct.toFixed(1) + '%p';
    chEl.className = 'text-xs font-bold tabular-nums ' + (dPct >= 0 ? 'text-rose-300' : 'text-sky-300');
    document.getElementById('sim-band').textContent = fmtMove(updated.low) + ' ~ ' + fmtMove(updated.high);
  };

  for (const input of container.querySelectorAll('input[data-idx]')) {
    input.addEventListener('input', e => {
      const idx = Number(e.target.dataset.idx);
      state.simValues[idx] = Number(e.target.value);
      const m = meta[idx];
      document.getElementById('sim-val-' + idx).textContent =
        (state.simValues[idx] > 0 && m.key !== 'vol10' && m.key !== 'vix' && m.key !== 'breadth' ? '+' : '') +
        state.simValues[idx].toFixed(2) +
        m.unit;
      refreshSimDisplay();
    });
  }

  const krFutSlider = document.getElementById('sim-krfut');
  if (krFutSlider) {
    krFutSlider.addEventListener('input', e => {
      state.simKrFut = Number(e.target.value);
      document.getElementById('sim-krfut-val').textContent = (state.simKrFut > 0 ? '+' : '') + state.simKrFut.toFixed(2) + '%';
      refreshSimDisplay();
    });
  }
  const newsSlider = document.getElementById('sim-news');
  if (newsSlider) {
    newsSlider.addEventListener('input', e => {
      state.simNews = Number(e.target.value);
      document.getElementById('sim-news-val').textContent = (state.simNews > 0 ? '+' : '') + state.simNews + '점';
      refreshSimDisplay();
    });
  }

  document.getElementById('sim-reset').addEventListener('click', () => {
    state.simValues = [...f.rawFeats];
    state.simNews = f.newsScore || 0;
    state.simKrFut = f.krFutPct || 0;
    state.animateBoard = false;
    renderSimulator();
    showToast('선택한 기준일의 실제 변수 값으로 복원했습니다.');
  });
}

function renderBacktest() {
  const rows = state.marketsData[state.key] || [];
  const i = state.dateIdx;
  const container = document.getElementById('backtest-content');

  if (!state.historyV4 || !state.historyV2) {
    const res = buildHistories(rows, state.key, state.marketsData, state.horizon);
    state.historyV4 = res.enhanced;
    state.historyV2 = res.base;
  }
  if (state.horizon === 1 && !state.historyV1) {
    state.historyV1 = rows.map((_, idx) => forecastV1(rows, idx));
  }

  const pairs = [];
  for (let j = 0; j < i; j++) {
    const p4 = state.historyV4[j];
    const p2 = state.historyV2[j];
    const p1 = state.horizon === 1 ? state.historyV1[j] : null;
    const y = forwardReturn(rows, j, state.horizon);
    if (p4 && p2 && y !== null && (state.horizon === 5 || p1)) {
      pairs.push({ p4, p2, p1, y });
    }
  }

  const avg = (arr, fn) => (arr.length ? arr.reduce((s, v) => s + fn(v), 0) / arr.length : null);
  const brierV4 = avg(pairs, v => (v.p4.p - Number(v.y > 0)) ** 2);
  const brierV2 = avg(pairs, v => (v.p2.p - Number(v.y > 0)) ** 2);
  const brierV1 = state.horizon === 1 ? avg(pairs, v => (v.p1.p - Number(v.y > 0)) ** 2) : null;
  const brierBase = avg(pairs, v => (v.p2.base - Number(v.y > 0)) ** 2);
  const covV4 = avg(pairs, v => Number(v.y >= v.p4.low && v.y <= v.p4.high));
  const covV2 = avg(pairs, v => Number(v.y >= v.p2.low && v.y <= v.p2.high));
  const covV1 = state.horizon === 1 ? avg(pairs, v => Number(v.y >= v.p1.low && v.y <= v.p1.high)) : null;

  const thr = getConvictionThreshold(state.key);
  const thrHiPct = Math.round(thr * 100);
  const thrLoPct = Math.round((1 - thr) * 100);
  const hiPairs = pairs.filter(v => v.p4.p >= thr || v.p4.p <= 1 - thr);
  const hasEnoughHi = hiPairs.length >= MIN_CONVICTION_SAMPLES;
  const hiAcc = hasEnoughHi ? avg(hiPairs, v => Number((v.p4.p >= 0.5) === (v.y > 0))) : null;
  const hiBrier = hasEnoughHi ? avg(hiPairs, v => (v.p4.p - Number(v.y > 0)) ** 2) : null;

  const fmtB = x => (x === null ? '-' : x.toFixed(4));

  container.innerHTML =
    '<section class="rounded-2xl bg-slate-900 dark:bg-[#0d1629] text-white p-4 border border-slate-800 dark:border-slate-700/70 shadow-lg' + boardCls(1) + '">' +
    '<div class="flex items-center justify-between mb-2">' +
    '<h2 class="text-sm font-bold text-white">고확신 신호(' + thrHiPct + '%↑ / ' + thrLoPct + '%↓) 선별 성적표</h2>' +
    '<span class="text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-teal-300 border border-slate-700 tabular-nums">' + hiPairs.length + '회 발생</span>' +
    '</div>' +
    '<div class="grid grid-cols-2 gap-2.5 tabular-nums">' +
    '<div class="rounded-xl bg-slate-800/80 border border-slate-700/60 p-3">' +
    '<div class="text-[11px] text-slate-400">고확신 구간 실제 방향 적중률</div>' +
    '<div class="text-2xl font-extrabold text-teal-300 mt-0.5">' + (hasEnoughHi ? fmtPct(hiAcc) : '표본 부족') + '</div>' +
    '</div>' +
    '<div class="rounded-xl bg-slate-800/80 border border-slate-700/60 p-3">' +
    '<div class="text-[11px] text-slate-400">고확신 구간 브라이어 점수</div>' +
    '<div class="text-2xl font-extrabold text-white mt-0.5">' + (hasEnoughHi ? fmtB(hiBrier) : '관망 권장') + '</div>' +
    '</div>' +
    '</div>' +
    '<p class="mt-2 text-[11px] text-slate-400">방향성이 모호한 ' + thrLoPct + '~' + thrHiPct + '% 관망 구간을 제외하고, 20회 이상 검증된 고확신 신호만 집계합니다.</p>' +
    '</section>' +
    '<section class="mt-3 rounded-2xl surface-card p-4 shadow-sm' + boardCls(2) + '">' +
    '<div class="flex items-center justify-between mb-2">' +
    '<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100">전체 기간 모델 비교 (' +
    MARKET_NAMES[state.key] + ' · ' + (state.horizon === 5 ? '5거래일' : '1거래일') + ' · ' + pairs.length + '회)</h2>' +
    '</div>' +
    '<div class="overflow-x-auto">' +
    '<table class="w-full text-xs text-left border-collapse">' +
    '<thead><tr class="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">' +
    '<th class="py-2 pr-2 font-semibold">모델</th>' +
    '<th class="py-2 px-2 font-semibold text-right">브라이어 점수</th>' +
    '<th class="py-2 pl-2 font-semibold text-right">80% 구간 적중률</th>' +
    '</tr></thead>' +
    '<tbody class="divide-y divide-slate-100 dark:divide-slate-800/90 tabular-nums">' +
    '<tr class="bg-teal-50/60 dark:bg-teal-500/10 font-semibold text-slate-900 dark:text-slate-100">' +
    '<td class="py-2.5 pr-2">개선 v7.1 (시장별 전용 엔진)</td>' +
    '<td class="py-2.5 px-2 text-right text-teal-800 dark:text-teal-300">' + fmtB(brierV4) + '</td>' +
    '<td class="py-2.5 pl-2 text-right text-teal-800 dark:text-teal-300">' + fmtPct(covV4) + '</td>' +
    '</tr>' +
    '<tr class="text-slate-700 dark:text-slate-300">' +
    '<td class="py-2.5 pr-2">기본 v2 (균등 가중 로지스틱)</td>' +
    '<td class="py-2.5 px-2 text-right">' + fmtB(brierV2) + '</td>' +
    '<td class="py-2.5 pl-2 text-right">' + fmtPct(covV2) + '</td>' +
    '</tr>' +
    (state.horizon === 1
      ? '<tr class="text-slate-600 dark:text-slate-400"><td class="py-2.5 pr-2">기존 v1 (단순 k-NN)</td><td class="py-2.5 px-2 text-right">' +
        fmtB(brierV1) + '</td><td class="py-2.5 pl-2 text-right">' + fmtPct(covV1) + '</td></tr>'
      : '') +
    '<tr class="text-slate-500 dark:text-slate-500">' +
    '<td class="py-2.5 pr-2">단순 기준 모델 (과거 상승 빈도)</td>' +
    '<td class="py-2.5 px-2 text-right">' + fmtB(brierBase) + '</td>' +
    '<td class="py-2.5 pl-2 text-right">-</td>' +
    '</tr>' +
    '</tbody></table></div>' +
    '</section>' +
    '<section class="mt-3 rounded-2xl surface-card p-4 shadow-sm' + boardCls(3) + '">' +
    '<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100 mb-1">실시간 조회 서버 연결 (Cloudflare Workers)</h2>' +
    '<p class="text-xs text-slate-500 dark:text-slate-400 mb-2">Cloudflare Workers에 배포한 중계 URL을 저장하면 상단 <strong>실시간 조회</strong> 버튼으로 KIS 국내지수·코스피200 선물·나스닥 선물을 즉시 반영합니다.</p>' +
    '<div class="flex gap-2">' +
    '<input id="worker-url-input" type="url" placeholder="https://index-daybook-live.xxx.workers.dev" value="' +
    escapeHtml(state.workerUrl) +
    '" class="flex-1 text-xs border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-800/90" />' +
    '<button id="worker-url-save" type="button" class="px-3.5 py-2 rounded-xl bg-teal-600 text-white text-xs font-bold hover:bg-teal-500 transition whitespace-nowrap">저장</button>' +
    '</div>' +
    '</section>' +
    '<section class="mt-3 rounded-2xl surface-card p-4 shadow-sm' + boardCls(4) + '">' +
    '<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100 mb-1.5">최신 데이터 불러오기 (data.js / JSON / CSV)</h2>' +
    '<div class="flex flex-wrap items-center gap-2 mt-2">' +
    '<label class="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-900 dark:bg-teal-600 text-white text-xs font-bold cursor-pointer hover:bg-slate-800 dark:hover:bg-teal-500 transition">' +
    '<span>파일 선택 (JS/JSON/CSV)</span>' +
    '<input id="file-import" type="file" accept=".js,.json,.csv,.txt" class="hidden" />' +
    '</label>' +
    '<button id="data-reset" type="button" class="px-3.5 py-2 rounded-xl border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 transition">기본 스냅샷 복원</button>' +
    '</div>' +
    '<div class="mt-3 text-xs text-slate-500 dark:text-slate-400">현재 수록: 코스피 ' +
    (state.marketsData.KOSPI || []).length + '일 · 코스닥 ' +
    (state.marketsData.KOSDAQ || []).length + '일 · 나스닥 ' +
    (state.marketsData.NASDAQ || []).length + '일</div>' +
    '</section>';

  document.getElementById('file-import').addEventListener('change', handleFileImport);
  const saveBtn = document.getElementById('worker-url-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const val = (document.getElementById('worker-url-input').value || '').trim().replace(/\/+$/, '');
      if (val && !/^https:\/\//.test(val)) {
        showToast('https:// 로 시작하는 Cloudflare Workers 주소를 입력해 주세요.', true);
        return;
      }
      state.workerUrl = val;
      writeStorage('daybook_worker_url', val);
      showToast(val ? '실시간 중계 서버 주소를 저장했습니다.' : '실시간 서버 주소를 비웠습니다.');
    });
  }
  document.getElementById('data-reset').addEventListener('click', () => {
    state.marketsData = JSON.parse(JSON.stringify(markets));
    state.isLiveIntraday = false;
    recomputeMarket(state.key, false, true);
    showToast('기본 수록 데이터(종가)로 복원했습니다.');
  });
}

function handleFileImport(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = String(reader.result || '').trim();
      if (text.startsWith('{') || text.startsWith('const markets')) {
        const cleaned = text.replace(/^const\s+markets\s*=\s*/, '').replace(/;\s*$/, '');
        const parsed = JSON.parse(cleaned);
        if (!parsed.KOSPI && !parsed.KOSDAQ && !parsed.NASDAQ) {
          throw new Error('KOSPI/KOSDAQ/NASDAQ 키가 필요합니다.');
        }
        validateImport(parsed);
        state.marketsData = { ...state.marketsData, ...parsed };
        recomputeMarket(state.key, false, true);
        showToast('데이터를 반영해 v7.1 전체 모델을 재계산했습니다.');
      } else {
        const lines = text
          .split(/\r?\n/)
          .filter(l => l.trim() && !l.startsWith('date') && !l.startsWith('날짜'));
        const rows = lines
          .map(line => {
            const p = line.split(',').map(s => s.trim());
            const row = [p[0], Number(p[1]), Number(p[2])];
            for (const val of p.slice(3, 6)) row.push(val ? Number(val) : null);
            return row;
          })
          .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r[0]) && !Number.isNaN(r[1]) && !Number.isNaN(r[2]));
        if (rows.length < 25) throw new Error('유효한 CSV 행이 최소 25개 이상 필요합니다.');
        validateImport({ [state.key]: rows });
        state.marketsData[state.key] = rows;
        recomputeMarket(state.key, false, true);
        showToast(MARKET_NAMES[state.key] + ' CSV ' + rows.length + '일을 반영했습니다.');
      }
    } catch (err) {
      showToast('데이터 파싱 오류: ' + err.message, true);
    }
  };
  reader.readAsText(file, 'utf-8');
}


const STOCK_PRESETS = [
  { name: 'SK하이닉스', q: '000660', sector: 'semi', tag: '반도체' },
  { name: '삼성전자', q: '005930', sector: 'semi', tag: '반도체' },
  { name: 'LG에너지솔루션', q: '373220', sector: 'battery', tag: '2차전지' },
  { name: '현대차', q: '005380', sector: 'auto', tag: '자동차' },
  { name: 'HD현대중공업', q: '329180', sector: 'ship', tag: '조선·방산' },
  { name: '셀트리온', q: '068270', sector: 'bio', tag: '바이오' },
  { name: 'KB금융', q: '105560', sector: 'fin', tag: '금융' },
  { name: 'NAVER', q: '035420', sector: 'tech', tag: '인터넷·AI' },
  { name: '엔비디아', q: 'NVDA', sector: 'us_semi', tag: '미 반도체' },
  { name: '테슬라', q: 'TSLA', sector: 'us_ev', tag: '미 전기차' }
];

const SECTOR_OPTIONS = [
  ['', '업종 자동 매칭'],
  ['semi', '반도체 (SOX·NVDA·MU·환율)'],
  ['battery', '2차전지 (TSLA·LIT·금리·환율)'],
  ['auto', '자동차·수출 (환율·S&P·유가·나스닥)'],
  ['ship', '조선·방산 (유가·환율·산업재·S&P)'],
  ['bio', '바이오·제약 (XBI·나스닥·금리·VIX)'],
  ['fin', '금융·은행 (금리·XLF·VIX·코스피)'],
  ['tech', '인터넷·AI (QQQ·금리·VIX·코스피)'],
  ['us_semi', '미국 반도체·AI (SOX·나스닥·금리·VIX)'],
  ['us_ev', '미국 전기차·성장 (나스닥·LIT·금리·VIX)'],
  ['general', '일반 대형주 (나스닥·S&P·환율·VIX)']
];

function fmtStockPrice(val, currency) {
  if (!Number.isFinite(val)) return '-';
  if (currency === 'KRW') return Math.round(val).toLocaleString('ko-KR') + '원';
  return '$' + val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function fetchAndAnalyzeStock(query, sectorOverride) {
  const q = String(query || '').trim();
  if (!q) {
    showToast('종목명, 6자리 코드 또는 미국 티커를 입력해 주세요.', true);
    return;
  }
  state.stockQuery = q;
  state.stockSectorOverride = sectorOverride || '';
  const baseUrl = (state.workerUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    state.stockError = '';
    state.stockResult = null;
    renderStockTab();
    showToast('먼저 검증·데이터 탭에서 Cloudflare Workers 주소를 저장해 주세요.');
    return;
  }

  const cacheKey = q.toUpperCase() + '|' + state.stockSectorOverride;
  if (state.stockCache[cacheKey]) {
    state.stockResult = state.stockCache[cacheKey];
    state.stockError = '';
    state.animateBoard = true;
    renderStockTab();
    return;
  }

  state.stockLoading = true;
  state.stockError = '';
  renderStockTab();
  try {
    const reqUrl =
      baseUrl +
      '/stock?q=' +
      encodeURIComponent(q) +
      (state.stockSectorOverride ? '&sector=' + encodeURIComponent(state.stockSectorOverride) : '');
    const res = await fetch(reqUrl, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || '종목 데이터 조회 실패 (' + res.status + ')');
    const analysis = analyzeIndividualStock(data);
    if (analysis.error) throw new Error(analysis.error);
    state.stockCache[cacheKey] = analysis;
    state.stockResult = analysis;
    state.stockError = '';
    state.animateBoard = true;
  } catch (err) {
    state.stockError = err.message || '종목 분석 중 오류가 발생했습니다.';
    state.stockResult = null;
  } finally {
    state.stockLoading = false;
    renderStockTab();
  }
}

function renderStockChart() {
  const s = state.stockResult;
  const canvas = document.getElementById('stockPriceChart');
  if (!s || !canvas || typeof Chart === 'undefined') return;
  if (state.stockChartInstance) {
    state.stockChartInstance.destroy();
    state.stockChartInstance = null;
  }

  const dark = isDark();
  const rows = s.recentRows || [];
  if (!rows.length) return;
  const labels = rows.map(v => v[0].slice(5));
  labels.push('다음날(예상)');
  const closes = rows.map(v => v[1]);
  const lastClose = closes[closes.length - 1];
  const hiPt = Number(s.hiPrice.toFixed(2));
  const loPt = Number(s.loPrice.toFixed(2));
  const midPt = Number(((hiPt + loPt) / 2).toFixed(2));

  const closeLine = closes.concat([null]);
  const upperBand = new Array(rows.length - 1).fill(null).concat([lastClose, hiPt]);
  const lowerBand = new Array(rows.length - 1).fill(null).concat([lastClose, loPt]);
  const projLine = new Array(rows.length - 1).fill(null).concat([lastClose, midPt]);

  const tickColor = dark ? '#94a3b8' : '#64748b';
  const gridColor = dark ? 'rgba(148, 163, 184, 0.12)' : '#f1f5f9';

  state.stockChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '종가',
          data: closeLine,
          borderColor: dark ? '#2dd4bf' : '#0f766e',
          backgroundColor: dark ? 'rgba(45, 212, 191, 0.12)' : 'rgba(15, 118, 110, 0.08)',
          borderWidth: 2.2,
          pointRadius: 1.5,
          tension: 0.2
        },
        {
          label: '예상 상단 (P90)',
          data: upperBand,
          borderColor: dark ? '#fb7185' : '#dc2626',
          borderDash: [4, 4],
          borderWidth: 1.5,
          pointRadius: 3,
          fill: false
        },
        {
          label: '예상 하단 (P10)',
          data: lowerBand,
          borderColor: dark ? '#60a5fa' : '#2563eb',
          borderDash: [4, 4],
          borderWidth: 1.5,
          pointRadius: 3,
          fill: '-1',
          backgroundColor: dark ? 'rgba(56, 189, 248, 0.15)' : 'rgba(14, 165, 233, 0.12)'
        },
        {
          label: '중심 추정',
          data: projLine,
          borderColor: dark ? '#cbd5e1' : '#334155',
          borderDash: [2, 2],
          borderWidth: 1.5,
          pointRadius: 3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { boxWidth: 10, font: { size: 11 }, color: tickColor }
        }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 6, font: { size: 11 }, color: tickColor }, grid: { display: false } },
        y: { ticks: { font: { size: 11 }, color: tickColor }, grid: { color: gridColor } }
      }
    }
  });
  triggerChartReveal('stock-chart-wrap');
}

function renderStockTab() {
  const container = document.getElementById('stock-content');
  if (!container) return;

  const presetHtml = STOCK_PRESETS.map(p => {
    const active =
      state.stockResult &&
      (state.stockResult.name === p.name || state.stockResult.symbol.startsWith(p.q));
    return (
      '<button type="button" data-stock-preset="' + escapeHtml(p.q) + '" data-stock-sector="' + p.sector + '" data-stock-name="' + escapeHtml(p.name) + '" class="px-2.5 py-1.5 rounded-xl text-xs font-semibold transition border whitespace-nowrap ' +
      (active
        ? 'bg-teal-600 text-white border-teal-500 shadow-sm'
        : 'surface-inset text-slate-700 dark:text-slate-200 hover:border-teal-500/60') +
      '">' +
      escapeHtml(p.name) +
      ' <span class="text-[10px] opacity-75">' + p.tag + '</span>' +
      '</button>'
    );
  }).join('');

  const sectorOptsHtml = SECTOR_OPTIONS.map(([val, lbl]) =>
    '<option value="' + val + '"' + (state.stockSectorOverride === val ? ' selected' : '') + '>' + lbl + '</option>'
  ).join('');

  let bodyHtml = '';
  if (!state.workerUrl) {
    bodyHtml =
      '<section class="mt-3 rounded-2xl surface-card p-5 text-center">' +
      '<div class="text-sm font-bold text-slate-900 dark:text-slate-100">실시간 중계 서버(Cloudflare Workers) 연결 필요</div>' +
      '<p class="mt-1.5 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">개별 종목 2년 일봉·업종별 선행지표·종목 속보 뉴스를 실시간으로 수집하기 위해 Cloudflare Workers URL이 필요합니다. v7.1 Worker를 배포한 뒤 아래 버튼으로 주소를 저장해 주세요.</p>' +
      '<button id="stock-goto-worker" type="button" class="mt-3 px-4 py-2 rounded-xl bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold transition">Workers 주소 설정하러 가기</button>' +
      '</section>';
  } else if (state.stockLoading) {
    bodyHtml =
      '<section class="mt-3 rounded-2xl surface-card p-6 text-center">' +
      '<div class="inline-block w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full animate-spin"></div>' +
      '<div class="mt-2.5 text-sm font-bold text-slate-800 dark:text-slate-100">' + escapeHtml(state.stockQuery) + ' 실시간 시세·업종 선행지표 학습 중...</div>' +
      '<div class="mt-1 text-xs text-slate-500 dark:text-slate-400">최근 2년 일봉 수집 및 워크포워드 백테스트 검증 중입니다.</div>' +
      '</section>';
  } else if (state.stockError) {
    bodyHtml =
      '<section class="mt-3 rounded-2xl surface-card p-5 text-center">' +
      '<div class="text-sm font-bold text-rose-600 dark:text-rose-400">종목 조회 오류</div>' +
      '<p class="mt-1.5 text-xs text-slate-600 dark:text-slate-400">' + escapeHtml(state.stockError) + '</p>' +
      '<p class="mt-1 text-[11px] text-slate-400 dark:text-slate-500">Cloudflare Worker가 v7.1(`/stock` 지원)으로 배포되었는지 확인해 주세요.</p>' +
      '</section>';
  } else if (state.stockResult) {
    const s = state.stockResult;
    const isBull = s.p >= 0.5;
    const heroGlow =
      s.signal.tone === 'teal'
        ? 'radial-gradient(circle at 18% 0%, rgba(251, 113, 133, 0.24), transparent 58%)'
        : s.signal.tone === 'rose'
          ? 'radial-gradient(circle at 18% 0%, rgba(56, 189, 248, 0.24), transparent 58%)'
          : 'radial-gradient(circle at 18% 0%, rgba(45, 212, 191, 0.18), transparent 58%)';
    const sigBadgeClass =
      s.signal.tone === 'teal'
        ? 'bg-rose-500/20 text-rose-200 border border-rose-400/40'
        : s.signal.tone === 'rose'
          ? 'bg-sky-500/20 text-sky-200 border border-sky-400/40'
          : 'bg-slate-800/90 text-slate-300 border border-slate-700';
    const relBadgeClass =
      s.reliability.tone === 'teal'
        ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/35'
        : s.reliability.tone === 'rose'
          ? 'bg-rose-500/20 text-rose-200 border border-rose-400/35'
          : 'bg-amber-500/20 text-amber-200 border border-amber-400/35';

    const maxAbs = Math.max(Math.abs(s.lowPct), Math.abs(s.highPct), 2);
    const leftBarPct = Math.min(50, (Math.max(0, -s.lowPct) / maxAbs) * 46);
    const rightBarPct = Math.min(50, (Math.max(0, s.highPct) / maxAbs) * 46);
    const fmtB = x => (x === null || x === undefined ? '-' : x.toFixed(4));

    const contribHtml = s.contributions
      .map(c => {
        const pos = c.impactPct >= 0;
        const barW = Math.min(100, Math.abs(c.impactPct) * 8);
        return (
          '<div class="py-2 border-b border-slate-100 dark:border-slate-800/90 last:border-b-0">' +
          '<div class="flex items-center justify-between text-xs mb-1">' +
          '<span class="font-medium text-slate-700 dark:text-slate-300">' +
          escapeHtml(c.label) +
          ' <span class="text-slate-400 dark:text-slate-500 font-normal">(' +
          (!c.isLevel && c.value > 0 && c.key !== 'vol10' ? '+' : '') +
          c.value.toFixed(2) + c.unit +
          ')</span></span>' +
          '<span class="font-bold tabular-nums ' +
          (pos ? 'text-red-600 dark:text-rose-400' : 'text-blue-600 dark:text-sky-400') +
          '">' + (pos ? '+' : '') + c.impactPct.toFixed(2) + '%p</span>' +
          '</div>' +
          '<div class="h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">' +
          '<div class="h-full rounded-full ' +
          (pos ? 'bg-red-500 dark:bg-rose-400' : 'bg-blue-500 dark:bg-sky-400') +
          '" style="width:' + Math.max(4, barW).toFixed(1) + '%"></div>' +
          '</div>' +
          '</div>'
        );
      })
      .join('');

    const newsHtml = s.news.length
      ? '<ul class="divide-y divide-slate-100 dark:divide-slate-800/90 text-xs">' +
        s.news
          .map(it => {
            const safeUrl = /^https?:\/\//.test(it.url || '') ? it.url : '';
            return (
              '<li class="py-2">' +
              (safeUrl
                ? '<a href="' + escapeHtml(safeUrl) + '" target="_blank" rel="noopener noreferrer" class="font-medium text-slate-800 dark:text-slate-100 hover:text-teal-600 dark:hover:text-teal-300 hover:underline leading-snug block">' + escapeHtml(it.title) + '</a>'
                : '<div class="font-medium text-slate-800 dark:text-slate-100 leading-snug">' + escapeHtml(it.title) + '</div>') +
              (it.source ? '<div class="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">' + escapeHtml(it.source) + '</div>' : '') +
              '</li>'
            );
          })
          .join('') +
        '</ul>'
      : '<p class="text-xs text-slate-500 dark:text-slate-400">최근 7일 관련 뉴스가 없습니다.</p>';

    bodyHtml =
      '<div class="mt-3 lg:grid lg:grid-cols-12 lg:gap-4 lg:items-start">' +
      '<div class="lg:col-span-6 space-y-3">' +
      // Stock Hero
      '<section class="rounded-2xl bg-slate-900 dark:bg-[#0d1629] text-white p-5 border border-slate-800 dark:border-slate-700/70 shadow-lg relative overflow-hidden' + boardCls(1) + '" style="background-image:' + heroGlow + '">' +
      '<div class="flex items-center justify-between gap-2 flex-wrap">' +
      '<div>' +
      '<div class="text-xs font-bold text-teal-300">' + escapeHtml(s.sectorLabel) + ' 전용 모델 · ' + escapeHtml(s.symbol) + '</div>' +
      '<div class="text-lg font-extrabold text-white mt-0.5">' + escapeHtml(s.name) + ' <span class="text-sm font-bold tabular-nums ' + (s.ret1 >= 0 ? 'text-rose-400' : 'text-sky-400') + '">' + fmtStockPrice(s.close, s.currency) + ' (' + fmtMove(s.ret1) + ')</span></div>' +
      '</div>' +
      '<div class="flex items-center gap-1.5 flex-wrap">' +
      (s.isLiveIntraday ? '<span class="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-200 border border-amber-400/40 font-semibold">KIS 실시간</span>' : '') +
      '<span class="text-[11px] px-2 py-0.5 rounded-full font-semibold ' + relBadgeClass + '">' + escapeHtml(s.reliability.label) + '</span>' +
      '</div>' +
      '</div>' +
      '<div class="mt-3 flex items-center justify-between gap-3">' +
      '<div class="text-4xl sm:text-5xl font-extrabold tracking-tight tabular-nums ' + (isBull ? 'text-rose-400' : 'text-sky-400') + '"' +
      (state.animateBoard ? ' data-countup="1" data-target="' + (s.p * 100).toFixed(1) + '" data-decimals="1" data-suffix="%"' : '') +
      '>' + fmtPct(s.p) + '</div>' +
      '<div class="text-right">' +
      '<span class="inline-block text-xs font-bold px-2.5 py-1 rounded-full ' + sigBadgeClass + '">' + s.signal.label + '</span>' +
      '<div class="text-xs text-slate-400 mt-1.5 tabular-nums">다음 거래일 상승 확률</div>' +
      '</div>' +
      '</div>' +
      '<div class="mt-4 relative h-2.5 w-full bg-slate-800 rounded-full overflow-hidden">' +
      '<div class="absolute left-1/2 top-0 bottom-0 w-px bg-slate-500/60 z-10"></div>' +
      '<div class="h-full rounded-full transition-all duration-700 ease-out ' + (isBull ? 'bg-gradient-to-r from-rose-500 to-rose-300' : 'bg-gradient-to-r from-blue-600 to-sky-400') + '" data-gauge-target="' + (s.p * 100).toFixed(1) + '%" style="width:' + (s.p * 100).toFixed(1) + '%"></div>' +
      '</div>' +
      '<div class="mt-2.5 text-[11px] text-slate-300 leading-snug">' + escapeHtml(s.reliability.desc) + '</div>' +
      '</section>' +
      // Stock Band Card
      '<section class="rounded-2xl surface-card p-4 shadow-sm' + boardCls(2) + '">' +
      '<div class="flex items-center justify-between mb-2.5">' +
      '<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100">다음 거래일 예상 가격 폭 (80% 구간)</h2>' +
      '<span class="text-xs text-slate-500 dark:text-slate-400 tabular-nums">10일 변동성 ' + s.vol10.toFixed(2) + '%</span>' +
      '</div>' +
      '<div class="rounded-xl surface-inset px-3.5 py-3">' +
      '<div class="flex items-center justify-between gap-2">' +
      '<span class="text-xs font-medium text-slate-600 dark:text-slate-300">시나리오 밴드 (P10 ~ P90)</span>' +
      '<span class="text-sm font-extrabold tabular-nums"><span class="text-blue-600 dark:text-sky-400">' + fmtMove(s.lowPct) + '</span> <span class="text-slate-400 font-normal">~</span> <span class="text-red-600 dark:text-rose-400">' + fmtMove(s.highPct) + '</span></span>' +
      '</div>' +
      '<div class="mt-2.5 relative h-3 rounded-full bg-slate-200/80 dark:bg-slate-800 overflow-hidden">' +
      '<div class="absolute top-0 bottom-0 bg-gradient-to-l from-sky-500 to-blue-600/80 rounded-l-full bar-grow-left" style="right:50%;width:' + leftBarPct.toFixed(1) + '%"></div>' +
      '<div class="absolute top-0 bottom-0 bg-gradient-to-r from-rose-500 to-red-500/80 rounded-r-full bar-grow-right" style="left:50%;width:' + rightBarPct.toFixed(1) + '%"></div>' +
      '<div class="absolute left-1/2 top-0 bottom-0 w-0.5 bg-slate-700 dark:bg-slate-200 -translate-x-1/2"></div>' +
      '</div>' +
      '<div class="mt-1.5 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">' +
      '<span>하단 약 <strong class="text-blue-600 dark:text-sky-300">' + fmtStockPrice(s.loPrice, s.currency) + '</strong></span>' +
      '<span class="text-[10px]">0% 기준</span>' +
      '<span>상단 약 <strong class="text-red-600 dark:text-rose-300">' + fmtStockPrice(s.hiPrice, s.currency) + '</strong></span>' +
      '</div>' +
      '</div>' +
      '<div class="mt-2.5 grid grid-cols-2 gap-2.5">' +
      '<div class="rounded-xl bg-red-50/80 dark:bg-rose-500/10 border border-red-100 dark:border-rose-500/20 px-3 py-2">' +
      '<div class="text-[11px] text-red-700 dark:text-rose-300 font-medium">상승 시 중앙값</div>' +
      '<div class="text-base font-extrabold text-red-700 dark:text-rose-400 tabular-nums mt-0.5">' + fmtMove(s.gainMed) + '</div>' +
      '</div>' +
      '<div class="rounded-xl bg-blue-50/80 dark:bg-sky-500/10 border border-blue-100 dark:border-sky-500/20 px-3 py-2">' +
      '<div class="text-[11px] text-blue-700 dark:text-sky-300 font-medium">하락 시 중앙값</div>' +
      '<div class="text-base font-extrabold text-blue-700 dark:text-sky-400 tabular-nums mt-0.5">' + fmtMove(s.lossMed) + '</div>' +
      '</div>' +
      '</div>' +
      '</section>' +
      // 30-day Stock Chart
      '<section class="rounded-2xl surface-card p-4 shadow-sm' + boardCls(3) + '">' +
      '<div class="flex items-center justify-between mb-2">' +
      '<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100">최근 30거래일 주가 추이 및 예상 밴드</h2>' +
      '<span class="text-xs text-slate-500 dark:text-slate-400">기준일 ' + escapeHtml(s.date) + '</span>' +
      '</div>' +
      '<div id="stock-chart-wrap" class="relative h-56 overflow-hidden"><canvas id="stockPriceChart"></canvas></div>' +
      '</section>' +
      '</div>' +
      // Right Column
      '<div class="lg:col-span-6 space-y-3 mt-3 lg:mt-0">' +
      '<section class="rounded-2xl surface-card p-4 shadow-sm' + boardCls(2) + '">' +
      '<div class="flex items-center justify-between mb-1.5">' +
      '<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100">' + escapeHtml(s.sectorLabel) + ' 추종 지표 기여도</h2>' +
      '<span class="text-xs text-slate-500 dark:text-slate-400">표본 ' + s.backtest.trainN + '일</span>' +
      '</div>' +
      '<div>' + contribHtml + '</div>' +
      '</section>' +
      '<section class="rounded-2xl surface-card p-4 shadow-sm' + boardCls(3) + '">' +
      '<div class="flex items-center justify-between mb-2">' +
      '<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100">종목 워크포워드 검증 성적표</h2>' +
      '<span class="text-xs text-slate-500 dark:text-slate-400 tabular-nums">' + s.backtest.n + '회 검증</span>' +
      '</div>' +
      '<div class="grid grid-cols-2 gap-2 text-xs tabular-nums">' +
      '<div class="rounded-xl surface-inset p-3">' +
      '<div class="text-[11px] text-slate-500 dark:text-slate-400">종목 모델 브라이어</div>' +
      '<div class="text-lg font-extrabold text-teal-700 dark:text-teal-300 mt-0.5">' + fmtB(s.backtest.brierModel) + '</div>' +
      '<div class="text-[10px] text-slate-400 mt-0.5">기준 모델 ' + fmtB(s.backtest.brierBase) + '</div>' +
      '</div>' +
      '<div class="rounded-xl surface-inset p-3">' +
      '<div class="text-[11px] text-slate-500 dark:text-slate-400">고확신(62%↑/38%↓) 적중률</div>' +
      '<div class="text-lg font-extrabold text-slate-900 dark:text-white mt-0.5">' + (s.backtest.hiAcc !== null ? fmtPct(s.backtest.hiAcc) : '표본 부족') + '</div>' +
      '<div class="text-[10px] text-slate-400 mt-0.5">' + s.backtest.hiN + '회 발생 · 80%밴드 ' + fmtPct(s.backtest.cov80) + '</div>' +
      '</div>' +
      '</div>' +
      '</section>' +
      '<section class="rounded-2xl surface-card p-4 shadow-sm' + boardCls(4) + '">' +
      '<div class="flex items-center justify-between mb-2">' +
      '<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100">' + escapeHtml(s.name) + ' 최신 속보 · 공시 체크</h2>' +
      '<span class="text-[11px] text-slate-400">실적·공시 확인 필수</span>' +
      '</div>' +
      newsHtml +
      '</section>' +
      '</div>' +
      '</div>';
  } else {
    bodyHtml =
      '<section class="mt-3 rounded-2xl surface-card p-5 text-center text-xs text-slate-500 dark:text-slate-400">위 업종별 대장주 버튼을 누르거나 종목명·코드를 입력해 분석을 시작하세요.</section>';
  }

  container.innerHTML =
    '<section class="rounded-2xl surface-card p-4 shadow-sm">' +
    '<div class="flex items-center justify-between gap-2 mb-2.5 flex-wrap">' +
    '<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100">업종별 대장주 프리셋 · 개별 종목 검색</h2>' +
    '<span class="text-[11px] text-slate-500 dark:text-slate-400">업종별 선행지표 자동 매칭</span>' +
    '</div>' +
    '<div class="flex flex-wrap gap-1.5 mb-3">' + presetHtml + '</div>' +
    '<form id="stock-search-form" class="flex flex-col sm:flex-row gap-2">' +
    '<input id="stock-query-input" type="text" value="' + escapeHtml(state.stockQuery) + '" placeholder="종목명(예: SK하이닉스), 6자리 코드(000660), 미국 티커(NVDA)" class="flex-1 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/90 px-3 py-2 text-slate-800 dark:text-slate-100" />' +
    '<div class="flex gap-2">' +
    '<select id="stock-sector-select" aria-label="추종 업종 선택" class="flex-1 sm:w-52 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/90 px-2.5 py-2 text-slate-800 dark:text-slate-100">' + sectorOptsHtml + '</select>' +
    '<button type="submit" class="px-4 py-2 rounded-xl bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold transition whitespace-nowrap">분석 실행</button>' +
    '</div>' +
    '</form>' +
    '</section>' +
    bodyHtml;

  if (state.animateBoard && state.stockResult) {
    runCountUps(container);
    state.animateBoard = false;
  }

  const form = document.getElementById('stock-search-form');
  if (form) {
    form.addEventListener('submit', e => {
      e.preventDefault();
      const qVal = (document.getElementById('stock-query-input').value || '').trim();
      const sVal = document.getElementById('stock-sector-select').value || '';
      fetchAndAnalyzeStock(qVal, sVal);
    });
  }
  const secSel = document.getElementById('stock-sector-select');
  if (secSel) {
    secSel.addEventListener('change', e => {
      state.stockSectorOverride = e.target.value;
      if (state.stockQuery && state.workerUrl) {
        fetchAndAnalyzeStock(state.stockQuery, state.stockSectorOverride);
      }
    });
  }
  for (const btn of container.querySelectorAll('button[data-stock-preset]')) {
    btn.addEventListener('click', () => {
      state.stockSectorOverride = btn.dataset.stockSector || '';
      state.stockQuery = btn.dataset.stockName || btn.dataset.stockPreset;
      fetchAndAnalyzeStock(btn.dataset.stockPreset, state.stockSectorOverride);
    });
  }
  const gotoBtn = document.getElementById('stock-goto-worker');
  if (gotoBtn) {
    gotoBtn.addEventListener('click', () => {
      switchTab('backtest');
      const inp = document.getElementById('worker-url-input');
      if (inp) inp.focus();
    });
  }
  if (state.stockResult) renderStockChart();
}

function renderAll() {
  renderForecast();
  renderSimulator();
  if (state.tab === 'backtest') renderBacktest();
}

async function fetchLiveSnapshot(isAuto) {
  const btn = document.getElementById('live-fetch-btn');
  let baseUrl = (state.workerUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    if (isAuto) return;
    switchTab('backtest');
    const inp = document.getElementById('worker-url-input');
    if (inp) inp.focus();
    showToast('먼저 아래에 Cloudflare Workers 주소를 입력하고 저장해 주세요.');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = '조회 중...';
  }
  try {
    const res = await fetch(baseUrl + '/live', { cache: 'no-store' });
    if (!res.ok) throw new Error('서버 응답 오류 (' + res.status + ')');
    const data = await res.json();

    if (data.futures && typeof data.futures === 'object') {
      state.marketsData.FUTURES = { ...(state.marketsData.FUTURES || {}), ...data.futures };
    }
    if (data.news && Array.isArray(data.news.items) && data.news.items.length) {
      state.marketsData.NEWS = data.news;
    }

    const dateKst = data.dateKst;
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

    state.isLiveIntraday = true;
    state.liveUpdatedKst = data.updatedKst || '';
    recomputeMarket(state.key, false, true);
    const warnMsg = data.warnings && data.warnings.length ? ' (' + data.warnings[0] + ')' : '';
    if (!isAuto) showToast('실시간 시세와 국내 증시 속보를 반영했습니다.' + warnMsg);
  } catch (err) {
    showToast('실시간 조회 실패: ' + err.message, true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '실시간 조회';
    }
  }
}

function initApp() {
  applyTheme(state.theme, false);

  const themeBtn = document.getElementById('theme-toggle-btn');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      applyTheme(isDark() ? 'light' : 'dark', true);
    });
  }

  const tabsEl = document.getElementById('market-tabs');
  for (const [id, label] of Object.entries(MARKET_NAMES)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.key = id;
    b.addEventListener('click', () => recomputeMarket(id, false, true));
    tabsEl.append(b);
  }

  for (const btn of document.querySelectorAll('#horizon-tabs button')) {
    btn.addEventListener('click', () => {
      state.horizon = Number(btn.dataset.h);
      recomputeMarket(state.key, true, true);
    });
  }

  for (const btn of document.querySelectorAll('#view-tabs button')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }

  document.getElementById('date-select').addEventListener('change', e => {
    state.dateIdx = Number(e.target.value);
    state.animateBoard = true;
    const rows = state.marketsData[state.key] || [];
    const rawF = forecastSingleDay(rows, state.dateIdx, state.key, state.marketsData, state.horizon);
    const isLatest = state.dateIdx === state.latestValidIdx;
    const liveNewsScore =
      state.marketsData.NEWS && Number.isFinite(state.marketsData.NEWS.sentiment)
        ? state.marketsData.NEWS.sentiment
        : 0;
    const futObj = state.marketsData.FUTURES || {};
    const liveKrFut = Number.isFinite(futObj.K200_pct) ? futObj.K200_pct : 0;
    const liveKrBasis = Number.isFinite(futObj.K200_basis) ? futObj.K200_basis : 0;
    let adjF = isLatest
      ? applyNewsOverlay(rawF, liveNewsScore, state.key, state.useNewsOverlay)
      : applyNewsOverlay(rawF, 0, state.key, false);
    adjF = isLatest
      ? applyKrFuturesOverlay(adjF, liveKrFut, liveKrBasis, state.key, state.useKrFutOverlay)
      : applyKrFuturesOverlay(adjF, 0, 0, state.key, false);
    state.currentForecast = adjF;
    state.simValues = state.currentForecast ? [...state.currentForecast.rawFeats] : [];
    state.simNews = isLatest ? liveNewsScore : 0;
    state.simKrFut = isLatest ? liveKrFut : 0;
    renderAll();
  });

  const liveBtn = document.getElementById('live-fetch-btn');
  if (liveBtn) liveBtn.addEventListener('click', () => fetchLiveSnapshot(false));
  recomputeMarket('KOSPI', false, true);
  switchTab('forecast');
  if (state.workerUrl) fetchLiveSnapshot(true);
}

document.addEventListener('DOMContentLoaded', initApp);

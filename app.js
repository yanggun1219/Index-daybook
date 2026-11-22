// 지수 관측소 v5.5 — 듀얼 호라이즌(1일·5일) + 고확신 신호 필터 + 선물·원자재·뉴스 모바일 앱

const MARKET_NAMES = {
  KOSPI: '코스피',
  KOSDAQ: '코스닥',
  NASDAQ: '나스닥 종합'
};

const state = {
  marketsData: JSON.parse(JSON.stringify(markets)),
  key: 'KOSPI',
  horizon: 1, // 1 = 다음 거래일, 5 = 향후 5거래일(1주 추세)
  tab: 'forecast',
  dateIdx: -1,
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
  workerUrl: (typeof localStorage !== 'undefined' && localStorage.getItem('daybook_worker_url')) || '',
  newsExpanded: false,
  selectedFutChart: null,
  futChartInstance: null,
  chartInstance: null
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

function showToast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className =
    'fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg transition-opacity ' +
    (isError ? 'bg-rose-700 text-white' : 'bg-slate-900 text-white');
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
      ? 'flex-1 py-1.5 px-3 rounded-lg text-xs font-bold bg-teal-700 text-white shadow-sm transition'
      : 'flex-1 py-1.5 px-3 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 transition';
  }
}

function recomputeMarket(id, keepDate) {
  state.key = id;
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
    state.dateIdx = latestValid;
    if (latestValid >= 0) dateSel.value = String(latestValid);
  }

  if (state.dateIdx >= 0) {
    const rawF = forecastSingleDay(rows, state.dateIdx, id, state.marketsData, state.horizon);
    const isLatest = state.dateIdx === rows.length - 1;
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
      ? 'flex-1 py-2 px-3 rounded-lg text-sm font-semibold bg-slate-900 text-white shadow-sm transition'
      : 'flex-1 py-2 px-3 rounded-lg text-sm font-medium text-slate-600 hover:text-slate-900 transition';
  }
  updateHorizonButtons();
  renderAll();
}

function switchTab(tabId) {
  state.tab = tabId;
  for (const btn of document.querySelectorAll('#view-tabs button')) {
    const active = btn.dataset.tab === tabId;
    btn.setAttribute('aria-selected', String(active));
    btn.className = active
      ? 'flex-1 py-2 text-sm font-semibold border-b-2 border-teal-700 text-teal-800 transition'
      : 'flex-1 py-2 text-sm font-medium border-b-2 border-transparent text-slate-500 hover:text-slate-800 transition';
  }
  document.getElementById('panel-forecast').classList.toggle('hidden', tabId !== 'forecast');
  document.getElementById('panel-simulator').classList.toggle('hidden', tabId !== 'simulator');
  document.getElementById('panel-backtest').classList.toggle('hidden', tabId !== 'backtest');
  if (tabId === 'forecast') renderPriceChart();
  if (tabId === 'backtest') renderBacktest();
}

function renderFuturesAndNewsSection(f) {
  const fut = state.marketsData.FUTURES;
  const news = state.marketsData.NEWS;

  let html = '';
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

  html +=
    '<section class="mt-3 rounded-2xl bg-white border border-slate-200 p-4 shadow-sm">' +
    '<div class="flex items-center justify-between mb-2">' +
    '<div class="flex items-center gap-2">' +
    '<h2 class="text-sm font-bold text-slate-900">국내·해외 선물 · 원자재</h2>' +
    '<span class="text-[11px] text-slate-500">' +
    escapeHtml((fut && fut.updatedKst) || '수집 대기') +
    '</span>' +
    '</div>' +
    (state.key !== 'NASDAQ'
      ? '<button id="toggle-krfut-overlay" type="button" class="px-2.5 py-1 rounded-lg text-[11px] font-semibold transition ' +
        (state.useKrFutOverlay ? 'bg-teal-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200') +
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
          return (
            '<button type="button" data-fut-key="' + it.key + '" class="text-left w-full rounded-xl px-3 py-2 transition border ' +
            (state.selectedFutChart === it.key ? 'bg-slate-100 border-teal-600 ring-1 ring-teal-600' : 'bg-slate-50 border-slate-100 hover:border-slate-300') +
            '">' +
            '<div class="flex items-center justify-between text-[11px] text-slate-500">' +
            '<span>' + it.label + '</span>' +
            (Number.isFinite(it.basis) ? '<span class="text-[10px] font-semibold ' + (it.basis >= 0 ? 'text-red-600' : 'text-blue-600') + '">베이시스 ' + (it.basis >= 0 ? '+' : '') + it.basis.toFixed(2) + '</span>' : '') +
            (Number.isFinite(it.funding) ? '<span class="text-[10px] font-semibold text-indigo-700">펀딩 ' + (it.funding >= 0 ? '+' : '') + it.funding.toFixed(3) + '%</span>' : '') +
            '</div>' +
            '<div class="mt-0.5 flex items-baseline justify-between tabular-nums">' +
            '<span class="text-xs font-semibold text-slate-800">' +
            (Number.isFinite(it.price) ? it.price.toLocaleString('en-US') : '-') +
            '</span>' +
            '<span class="text-xs font-bold ' +
            (pos ? 'text-red-600' : 'text-blue-600') +
            '">' +
            fmtMove(it.val) +
            '</span>' +
            '</div>' +
            '</button>'
          );
        })
        .join('') +
      '</div>' +
      '<div class="mt-2 text-[11px] text-slate-400">각 항목을 누르면 최근 20거래일 추이 그래프가 열립니다.</div>' +
      (state.selectedFutChart
        ? '<div class="mt-2.5 pt-2.5 border-t border-slate-100">' +
          '<div class="flex items-center justify-between mb-1.5">' +
          '<span id="fut-chart-title" class="text-xs font-bold text-slate-800"></span>' +
          '<button id="fut-chart-close" type="button" class="text-[11px] font-semibold text-slate-500 hover:text-slate-800 px-2 py-0.5 rounded bg-slate-100">닫기</button>' +
          '</div>' +
          '<div class="relative h-40"><canvas id="futMiniChart"></canvas></div>' +
          '</div>'
        : '');
  } else {
    html +=
      '<p class="text-xs text-slate-500 leading-relaxed">GitHub Actions의 <strong>Update Index Data</strong> 워크플로우가 실행되면 나스닥100·S&amp;P500 선물, WTI 유가, 금 시세가 자동으로 채워집니다.</p>';
  }
  html += '</section>';

  const hasNews = news && Array.isArray(news.items) && news.items.length > 0;
  const score = hasNews && Number.isFinite(news.sentiment) ? news.sentiment : 0;
  const toneClass =
    score >= 15
      ? 'bg-red-50 text-red-700'
      : score <= -15
        ? 'bg-blue-50 text-blue-700'
        : 'bg-slate-100 text-slate-700';
  const toneLabel = !hasNews ? '수집 대기' : score >= 15 ? '우호적' : score <= -15 ? '경계·부정' : '중립';
  const impactNote =
    f && f.newsApplied
      ? '확률 보정 ' + (f.newsImpactPct >= 0 ? '+' : '') + f.newsImpactPct.toFixed(2) + '%p 반영 중'
      : state.useNewsOverlay
        ? '뉴스 수집 시 확률에 자동 보정(최대 ±4.5%p)'
        : '뉴스 보정 꺼짐 (순수 가격 모델)';

  html +=
    '<section class="mt-3 rounded-2xl bg-white border border-slate-200 p-4 shadow-sm">' +
    '<div class="flex items-center justify-between gap-2 mb-2 flex-wrap">' +
    '<div class="flex items-center gap-2">' +
    '<h2 class="text-sm font-bold text-slate-900">글로벌 주요 경제 뉴스</h2>' +
    '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold tabular-nums ' +
    toneClass +
    '">' +
    (hasNews ? '심리 ' + toneLabel + ' (' + (score > 0 ? '+' : '') + score + ')' : toneLabel) +
    '</span>' +
    '</div>' +
    '<button id="toggle-news-overlay" type="button" class="px-2.5 py-1 rounded-lg text-[11px] font-semibold transition ' +
    (state.useNewsOverlay
      ? 'bg-teal-700 text-white'
      : 'bg-slate-100 text-slate-600 hover:bg-slate-200') +
    '">투심 반영 ' +
    (state.useNewsOverlay ? 'ON' : 'OFF') +
    '</button>' +
    '</div>' +
    '<div class="text-[11px] text-slate-500 mb-2">' +
    impactNote +
    '</div>';

  if (hasNews) {
    html +=
      '<ul class="divide-y divide-slate-100 text-xs">' +
      news.items
        .slice(0, state.newsExpanded ? news.items.length : 3)
        .map(item => {
          const safeUrl = /^https?:\/\//.test(item.url || '') ? item.url : '';
          const titleHtml = safeUrl
            ? '<a href="' +
              escapeHtml(safeUrl) +
              '" target="_blank" rel="noopener noreferrer" class="font-medium text-slate-800 hover:text-teal-700 underline-offset-2 hover:underline">' +
              escapeHtml(item.title) +
              '</a>'
            : '<span class="font-medium text-slate-800">' + escapeHtml(item.title) + '</span>';
          const transBadge = item.translated
            ? '<span class="ml-1.5 inline-block px-1.5 py-0.2 rounded bg-teal-50 text-teal-700 text-[10px] font-semibold align-middle">한글번역</span>'
            : '';
          const summaryHtml = item.summary
            ? '<div class="text-[11px] text-slate-500 mt-0.5 leading-snug">' + escapeHtml(item.summary) + '</div>'
            : '';
          return (
            '<li class="py-2.5 flex items-start justify-between gap-2">' +
            '<div class="leading-snug">' +
            titleHtml +
            transBadge +
            summaryHtml +
            (item.source ? '<div class="text-[10px] text-slate-400 mt-0.5">' + escapeHtml(item.source) + '</div>' : '') +
            '</div>' +
            '</li>'
          );
        })
        .join('') +
      '</ul>' +
      (news.items.length > 3
        ? '<button id="toggle-news-expand" type="button" class="mt-2 w-full py-2 rounded-xl bg-slate-50 hover:bg-slate-100 border border-slate-200 text-xs font-semibold text-slate-700 transition">' +
          (state.newsExpanded ? '뉴스 접기 (3건만 보기) ▴' : '최신 뉴스 전체보기 (총 ' + news.items.length + '건) ▾') +
          '</button>'
        : '');
  } else {
    html +=
      '<p class="text-xs text-slate-500 leading-relaxed">아직 수집된 뉴스가 없습니다. GitHub Actions에서 <strong>Update Index Data</strong>를 실행하면 최신 헤드라인 5건과 심리 점수가 표시되며, 시뮬레이터 탭에서 뉴스 심리(-100~+100)를 직접 조정해 볼 수도 있습니다.</p>';
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
      '<div class="bg-white rounded-2xl border border-slate-200 p-6 text-center text-slate-600">유효한 예측을 계산할 수 있는 과거 표본이 부족합니다 (최소 18거래일 필요).</div>';
    return;
  }

  const horizonLabel = state.horizon === 5 ? '향후 5거래일(1주) 상승 확률' : '다음 거래일 상승 확률';

  const sigBadgeClass =
    f.signal.tone === 'teal'
      ? 'bg-red-500/25 text-red-200 border border-red-400/40'
      : f.signal.tone === 'rose'
        ? 'bg-blue-500/25 text-sky-200 border border-sky-400/40'
        : 'bg-slate-800 text-slate-300 border border-slate-700';

  const regimeBadgeClass =
    f.regimeTone === 'rose'
      ? 'bg-rose-500/20 text-rose-200'
      : f.regimeTone === 'teal'
        ? 'bg-emerald-500/20 text-emerald-200'
        : 'bg-slate-800 text-slate-300';

  const extraSection = f.candidates.length
    ? '<section class="mt-3 rounded-2xl bg-white border border-slate-200 p-4 shadow-sm">' +
      '<div class="flex items-center justify-between mb-1.5">' +
      '<h2 class="text-sm font-bold text-slate-900">확장 지표 상태</h2>' +
      '<span class="text-xs text-slate-500">' +
      (state.key === 'NASDAQ' && f.krLeadDate
        ? '한국장 선행 ' + f.krLeadDate + ' 반영'
        : '미국장 ' + (f.usDate || '미수록') + (f.usSessions > 1 ? ' (' + f.usSessions + '일 누적)' : '')) +
      '</span>' +
      '</div>' +
      '<div class="divide-y divide-slate-100">' +
      f.candidates
        .map(k => {
          let val = f.extra[k];
          let isLiveOverlayVal = false;
          const isLatestRow = state.dateIdx === rows.length - 1;
          if (!Number.isFinite(val) && isLatestRow) {
            const futLive = state.marketsData.FUTURES || {};
            const newsLive = state.marketsData.NEWS || {};
            if (k === 'krFut' && Number.isFinite(futLive.K200_pct)) { val = futLive.K200_pct; isLiveOverlayVal = true; }
            else if (k === 'krBasis' && Number.isFinite(futLive.K200_basis)) { val = futLive.K200_basis; isLiveOverlayVal = true; }
            else if (k === 'news' && Array.isArray(newsLive.items) && newsLive.items.length && Number.isFinite(newsLive.sentiment)) { val = newsLive.sentiment; isLiveOverlayVal = true; }
          }
          const hasVal = Number.isFinite(val);
          const isActive = f.active.includes(k);
          const badge = isActive
            ? '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-teal-50 text-teal-800">모델 반영</span>'
            : isLiveOverlayVal
              ? '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-50 text-indigo-700">실시간 보정</span>'
              : hasVal
                ? '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800">표본 대기</span>'
                : '<span class="px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-500">갱신 대기</span>';
          return (
            '<div class="py-2 flex items-center justify-between gap-2 text-xs">' +
            '<span class="font-medium text-slate-700">' +
            EXTRA_META[k].label +
            '</span>' +
            '<div class="flex items-center gap-2 tabular-nums">' +
            '<span class="font-semibold text-slate-900">' +
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
        '<div class="py-2 border-b border-slate-100 last:border-b-0">' +
        '<div class="flex items-center justify-between text-xs mb-1">' +
        '<span class="font-medium text-slate-700">' +
        c.label +
        ' <span class="text-slate-400 font-normal">(' +
        (c.value > 0 && c.key !== 'vol10' && c.key !== 'vix' && c.key !== 'breadth' ? '+' : '') +
        c.value.toFixed(2) +
        c.unit +
        ')</span></span>' +
        '<span class="font-semibold tabular-nums ' +
        (pos ? 'text-red-600' : 'text-blue-600') +
        '">' +
        (pos ? '+' : '') +
        c.impactPct.toFixed(2) +
        '%p</span>' +
        '</div>' +
        '<div class="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">' +
        '<div class="h-full rounded-full ' +
        (pos ? 'bg-red-500' : 'bg-blue-500') +
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
      ? '<span class="font-semibold ' +
        (fwdActual >= 0 ? 'text-red-600' : 'text-blue-600') +
        '">' +
        fmtMove(fwdActual) +
        '</span> (' +
        rows[i + state.horizon][0] +
        ')'
      : '<span class="text-slate-500">마감 전</span>';

  container.innerHTML =
    '<section class="rounded-2xl bg-slate-900 text-white p-5 shadow-sm">' +
    '<div class="flex items-center justify-between gap-2 flex-wrap">' +
    '<span class="text-xs font-medium text-slate-300">' +
    MARKET_NAMES[state.key] +
    ' ' +
    horizonLabel +
    ' (v5.5)</span>' +
    '<div class="flex items-center gap-1.5">' +
    (state.isLiveIntraday ? '<span class="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/25 text-amber-200 border border-amber-400/40 font-semibold">장중 실시간 잠정</span>' : '') +
    '<span class="text-[11px] px-2 py-0.5 rounded-full ' +
    regimeBadgeClass +
    '">' +
    f.regime +
    '</span>' +
    '<span class="text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-teal-300 tabular-nums">표본 ' +
    f.n +
    '일</span>' +
    '</div>' +
    '</div>' +
    '<div class="mt-2.5 flex items-center justify-between gap-3">' +
    '<div class="text-4xl sm:text-5xl font-bold tracking-tight tabular-nums ' + (f.p >= 0.5 ? 'text-rose-400' : 'text-sky-400') + '">' +
    fmtPct(f.p) +
    '</div>' +
    '<div class="text-right">' +
    '<span class="inline-block text-xs font-bold px-2.5 py-1 rounded-full ' +
    sigBadgeClass +
    '">' +
    f.signal.label +
    '</span>' +
    '<div class="text-xs text-slate-400 mt-1 tabular-nums">종합 점수 <strong class="text-white">' +
    f.score +
    '</strong> / 100</div>' +
    '</div>' +
    '</div>' +
    '<div class="mt-3 h-2.5 w-full bg-slate-700 rounded-full overflow-hidden">' +
    '<div class="h-full rounded-full transition-all ' + (f.p >= 0.5 ? 'bg-rose-400' : 'bg-sky-400') + '" style="width:' +
    (f.p * 100).toFixed(1) +
    '%"></div>' +
    '</div>' +
    '<div class="mt-2.5 flex items-center justify-between text-xs text-slate-300 tabular-nums">' +
    '<span>상승 ' +
    fmtPct(f.p) +
    ' · 하락·보합 ' +
    fmtPct(f.down) +
    '</span>' +
    '<span>과거 기준 빈도 ' +
    fmtPct(f.base) +
    '</span>' +
    '</div>' +
    '</section>' +
    renderFuturesAndNewsSection(f) +
    '<section class="mt-3 rounded-2xl bg-white border border-slate-200 p-4 shadow-sm">' +
    '<div class="flex items-center justify-between mb-2">' +
    '<h2 class="text-sm font-bold text-slate-900">' +
    (state.horizon === 5 ? '향후 5거래일 예상 등락 폭 (80% 구간)' : '다음 거래일 예상 등락 폭 (80% 구간)') +
    '</h2>' +
    '<span class="text-xs text-slate-500 tabular-nums">10일 변동성 ' +
    f.vol.toFixed(2) +
    '%</span>' +
    '</div>' +
    '<div class="rounded-xl bg-slate-50 border border-slate-200 px-3.5 py-3 flex items-center justify-between">' +
    '<span class="text-xs font-medium text-slate-600">예상 시나리오 밴드 (P10 ~ P90)</span>' +
    '<span class="text-base font-bold text-slate-900 tabular-nums">' +
    fmtMove(f.low) +
    ' ~ ' +
    fmtMove(f.high) +
    '</span>' +
    '</div>' +
    '<div class="mt-2.5 grid grid-cols-2 gap-2.5">' +
    '<div class="rounded-xl bg-red-50/70 px-3 py-2.5">' +
    '<div class="text-xs text-red-700">상승 시 중앙값</div>' +
    '<div class="text-base font-bold text-red-800 tabular-nums mt-0.5">' +
    fmtMove(f.gain) +
    '</div>' +
    '</div>' +
    '<div class="rounded-xl bg-blue-50/70 px-3 py-2.5">' +
    '<div class="text-xs text-blue-700">하락 시 중앙값</div>' +
    '<div class="text-base font-bold text-blue-800 tabular-nums mt-0.5">' +
    fmtMove(f.loss) +
    '</div>' +
    '</div>' +
    '</div>' +
    '<div class="mt-2.5 flex items-center justify-between text-xs text-slate-600 pt-2 border-t border-slate-100">' +
    '<span>기준 종가 (' +
    r[0] +
    '): <strong class="text-slate-900 tabular-nums">' +
    r[1].toLocaleString('ko-KR') +
    ' pt</strong> (' +
    fmtMove(r[2]) +
    ')</span>' +
    '<span>실제: ' +
    nextActual +
    '</span>' +
    '</div>' +
    '</section>' +
    extraSection +
    '<section class="mt-3 rounded-2xl bg-white border border-slate-200 p-4 shadow-sm">' +
    '<div class="flex items-center justify-between mb-2">' +
    '<h2 class="text-sm font-bold text-slate-900">최근 30거래일 종가 추이 및 예상 밴드</h2>' +
    '<span class="text-xs text-slate-500">' +
    (state.horizon === 5 ? '+5거래일 P10~P90' : '+1거래일 P10~P90') +
    '</span>' +
    '</div>' +
    '<div class="relative h-56"><canvas id="priceChart"></canvas></div>' +
    '</section>' +
    '<section class="mt-3 rounded-2xl bg-white border border-slate-200 p-4 shadow-sm">' +
    '<div class="flex items-center justify-between mb-1.5">' +
    '<h2 class="text-sm font-bold text-slate-900">변수별 확률 기여도 분해</h2>' +
    '<span class="text-xs text-slate-500">시간감쇠 정규화 기준</span>' +
    '</div>' +
    '<div>' +
    contribRows +
    '</div>' +
    '</section>';

  const toggleKrBtn = document.getElementById('toggle-krfut-overlay');
  if (toggleKrBtn) {
    toggleKrBtn.addEventListener('click', () => {
      state.useKrFutOverlay = !state.useKrFutOverlay;
      recomputeMarket(state.key, true);
      showToast(state.useKrFutOverlay ? '코스피200 국내선물 보정을 켰습니다.' : '국내선물 보정을 껐습니다.');
    });
  }
  const toggleBtn = document.getElementById('toggle-news-overlay');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      state.useNewsOverlay = !state.useNewsOverlay;
      recomputeMarket(state.key, true);
      showToast(state.useNewsOverlay ? '글로벌 뉴스 투심 보정을 켰습니다.' : '순수 가격 모델 확률로 전환했습니다.');
    });
  }
  for (const btn of document.querySelectorAll('button[data-fut-key]')) {
    btn.addEventListener('click', () => {
      const k = btn.dataset.futKey;
      state.selectedFutChart = state.selectedFutChart === k ? null : k;
      renderForecast();
    });
  }
  const closeFutBtn = document.getElementById('fut-chart-close');
  if (closeFutBtn) {
    closeFutBtn.addEventListener('click', () => {
      state.selectedFutChart = null;
      renderForecast();
    });
  }
  const expandNewsBtn = document.getElementById('toggle-news-expand');
  if (expandNewsBtn) {
    expandNewsBtn.addEventListener('click', () => {
      state.newsExpanded = !state.newsExpanded;
      renderForecast();
    });
  }
  renderFuturesChart();
  renderPriceChart();
}


function renderFuturesChart() {
  const key = state.selectedFutChart;
  const canvas = document.getElementById('futMiniChart');
  const titleEl = document.getElementById('fut-chart-title');
  if (!key || !canvas || typeof Chart === 'undefined') return;
  if (state.futChartInstance) {
    state.futChartInstance.destroy();
    state.futChartInstance = null;
  }

  const labelMap = {
    K200: '코스피200 선물 (최근 추이)',
    NQ: '나스닥100 선물 (최근 20일)',
    ES: 'S&P500 선물 (최근 20일)',
    CL: 'WTI 국제유가 (최근 20일)',
    GC: '국제 금 선물 (최근 20일)',
    BTC: 'BTC 무기한 선물 (최근 20일)'
  };
  if (titleEl) titleEl.textContent = labelMap[key] || key;

  const fut = state.marketsData.FUTURES || {};
  let series = fut.series && Array.isArray(fut.series[key]) ? fut.series[key] : [];
  if (!series.length && (key === 'CL' || key === 'GC') && Array.isArray(state.marketsData[key])) {
    series = state.marketsData[key].slice(-20).map(r => [r[0].slice(5), r[1]]);
  }
  if (!series.length && key === 'K200' && Array.isArray(state.marketsData.KOSPI)) {
    // 코스피200 선물 일봉 누적 전에는 코스피 지수 20일 추이를 참고 차트로 표시
    series = state.marketsData.KOSPI.slice(-20).map(r => [r[0].slice(5), r[1]]);
    if (titleEl) titleEl.textContent = '코스피 현물 연동 추이 (최근 20일)';
  }
  if (!series.length) return;

  const labels = series.map(p => p[0]);
  const vals = series.map(p => p[1]);
  const isUp = vals[vals.length - 1] >= vals[0];
  const stroke = isUp ? '#dc2626' : '#2563eb';
  const fillBg = isUp ? 'rgba(220, 38, 38, 0.08)' : 'rgba(37, 99, 235, 0.08)';

  state.futChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: labelMap[key] || key,
        data: vals,
        borderColor: stroke,
        backgroundColor: fillBg,
        borderWidth: 2,
        pointRadius: 2,
        fill: true,
        tension: 0.2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxTicksLimit: 5, font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { font: { size: 10 } }, grid: { color: '#f1f5f9' } }
      }
    }
  });
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

  state.chartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '종가 (pt)',
          data: closeLine,
          borderColor: '#0f766e',
          backgroundColor: 'rgba(15, 118, 110, 0.08)',
          borderWidth: 2.2,
          pointRadius: 1.5,
          tension: 0.2
        },
        {
          label: '예상 상단 (P90)',
          data: upperBand,
          borderColor: '#dc2626',
          borderDash: [4, 4],
          borderWidth: 1.5,
          pointRadius: 3,
          fill: false
        },
        {
          label: '예상 하단 (P10)',
          data: lowerBand,
          borderColor: '#2563eb',
          borderDash: [4, 4],
          borderWidth: 1.5,
          pointRadius: 3,
          fill: '-1',
          backgroundColor: 'rgba(14, 165, 233, 0.12)'
        },
        {
          label: '중심 추정',
          data: projLine,
          borderColor: '#334155',
          borderDash: [2, 2],
          borderWidth: 1.5,
          pointRadius: 3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { boxWidth: 10, font: { size: 11 } }
        }
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 6, font: { size: 11 } },
          grid: { display: false }
        },
        y: {
          ticks: { font: { size: 11 } },
          grid: { color: '#f1f5f9' }
        }
      }
    }
  });
}

function renderSimulator() {
  const f = state.currentForecast;
  const container = document.getElementById('simulator-content');
  if (!f) {
    container.innerHTML =
      '<div class="bg-white rounded-2xl border border-slate-200 p-6 text-center text-slate-600">시뮬레이션할 기준 모델이 없습니다.</div>';
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
        '<div class="py-2.5 border-b border-slate-100 last:border-b-0">' +
        '<div class="flex items-center justify-between text-xs mb-1.5">' +
        '<label for="sim-' +
        idx +
        '" class="font-semibold text-slate-700">' +
        m.label +
        '</label>' +
        '<span id="sim-val-' +
        idx +
        '" class="font-bold text-slate-900 tabular-nums">' +
        (val > 0 && m.key !== 'vol10' && m.key !== 'vix' && m.key !== 'breadth' ? '+' : '') +
        val.toFixed(2) +
        m.unit +
        '</span>' +
        '</div>' +
        '<input id="sim-' +
        idx +
        '" data-idx="' +
        idx +
        '" type="range" min="' +
        m.min +
        '" max="' +
        m.max +
        '" step="' +
        m.step +
        '" value="' +
        val.toFixed(2) +
        '" class="w-full accent-teal-700 cursor-pointer" />' +
        '</div>'
      );
    })
    .join('');

  container.innerHTML =
    '<section class="rounded-2xl bg-slate-900 text-white p-5 shadow-sm">' +
    '<div class="flex items-center justify-between">' +
    '<span class="text-xs text-slate-300">' +
    MARKET_NAMES[state.key] +
    ' (' +
    (state.horizon === 5 ? '5거래일' : '1거래일') +
    ') 시뮬레이션</span>' +
    '<span id="sim-change" class="text-xs font-semibold tabular-nums ' +
    (diffP >= 0 ? 'text-rose-300' : 'text-sky-300') +
    '">기존 대비 ' +
    (diffP >= 0 ? '+' : '') +
    diffP.toFixed(1) +
    '%p</span>' +
    '</div>' +
    '<div class="mt-2 flex items-baseline justify-between">' +
    '<div id="sim-prob" class="text-4xl font-bold text-emerald-300 tabular-nums">' +
    fmtPct(simOut.p) +
    '</div>' +
    '<div id="sim-band" class="text-sm font-semibold text-slate-200 tabular-nums">' +
    fmtMove(simOut.low) +
    ' ~ ' +
    fmtMove(simOut.high) +
    '</div>' +
    '</div>' +
    '<p class="mt-2 text-xs text-slate-400">장전 나스닥·환율·유가·변동성을 조정해 확률과 80% 예상 밴드 변화를 즉시 확인합니다.</p>' +
    '</section>' +
    '<section class="mt-3 rounded-2xl bg-white border border-slate-200 p-4 shadow-sm">' +
    '<div class="flex items-center justify-between mb-2">' +
    '<h2 class="text-sm font-bold text-slate-900">입력 변수 조정</h2>' +
    '<button id="sim-reset" type="button" class="text-xs font-semibold text-teal-700 hover:text-teal-900 px-2.5 py-1 rounded-lg bg-teal-50">현재 기준값 복원</button>' +
    '</div>' +
    '<div>' +
    slidersHtml +
    (state.key !== 'NASDAQ'
      ? '<div class="py-2.5 border-t border-slate-100">' +
        '<div class="flex items-center justify-between text-xs mb-1.5">' +
        '<label for="sim-krfut" class="font-semibold text-teal-800">코스피200 국내선물 등락 (KIS)</label>' +
        '<span id="sim-krfut-val" class="font-bold text-teal-900 tabular-nums">' +
        (state.simKrFut > 0 ? '+' : '') +
        state.simKrFut.toFixed(2) +
        '%</span>' +
        '</div>' +
        '<input id="sim-krfut" type="range" min="-6" max="6" step="0.1" value="' +
        state.simKrFut.toFixed(2) +
        '" class="w-full accent-teal-700 cursor-pointer" />' +
        '</div>'
      : '') +
    '<div class="py-2.5 border-t border-slate-100">' +
    '<div class="flex items-center justify-between text-xs mb-1.5">' +
    '<label for="sim-news" class="font-semibold text-teal-800">글로벌 뉴스 투심 점수 (오버레이)</label>' +
    '<span id="sim-news-val" class="font-bold text-teal-900 tabular-nums">' +
    (state.simNews > 0 ? '+' : '') +
    state.simNews +
    '점</span>' +
    '</div>' +
    '<input id="sim-news" type="range" min="-100" max="100" step="5" value="' +
    state.simNews +
    '" class="w-full accent-teal-700 cursor-pointer" />' +
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
    chEl.className = 'text-xs font-semibold tabular-nums ' + (dPct >= 0 ? 'text-rose-300' : 'text-sky-300');
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

  // 시장별 고확신 구간 선별 성적표 (코스피·코스닥 65%/35%, 나스닥 60%/40%, 최소 20일 표본 가드)
  const thr = getConvictionThreshold(state.key);
  const thrHiPct = Math.round(thr * 100);
  const thrLoPct = Math.round((1 - thr) * 100);
  const hiPairs = pairs.filter(v => v.p4.p >= thr || v.p4.p <= 1 - thr);
  const hasEnoughHi = hiPairs.length >= MIN_CONVICTION_SAMPLES;
  const hiAcc = hasEnoughHi ? avg(hiPairs, v => Number((v.p4.p >= 0.5) === (v.y > 0))) : null;
  const hiBrier = hasEnoughHi ? avg(hiPairs, v => (v.p4.p - Number(v.y > 0)) ** 2) : null;

  const fmtB = x => (x === null ? '-' : x.toFixed(4));

  container.innerHTML =
    '<section class="rounded-2xl bg-slate-900 text-white p-4 shadow-sm">' +
    '<div class="flex items-center justify-between mb-2">' +
    '<h2 class="text-sm font-bold text-white">고확신 신호(' +
    thrHiPct +
    '%↑ / ' +
    thrLoPct +
    '%↓) 선별 성적표</h2>' +
    '<span class="text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-emerald-300 tabular-nums">' +
    hiPairs.length +
    '회 발생</span>' +
    '</div>' +
    '<div class="grid grid-cols-2 gap-2.5 tabular-nums">' +
    '<div class="rounded-xl bg-slate-800/80 p-3">' +
    '<div class="text-[11px] text-slate-400">고확신 구간 실제 방향 적중률</div>' +
    '<div class="text-2xl font-bold text-emerald-300 mt-0.5">' +
    (hasEnoughHi ? fmtPct(hiAcc) : '표본 부족') +
    '</div>' +
    '</div>' +
    '<div class="rounded-xl bg-slate-800/80 p-3">' +
    '<div class="text-[11px] text-slate-400">고확신 구간 브라이어 점수</div>' +
    '<div class="text-2xl font-bold text-white mt-0.5">' +
    (hasEnoughHi ? fmtB(hiBrier) : '관망 권장') +
    '</div>' +
    '</div>' +
    '</div>' +
    '<p class="mt-2 text-[11px] text-slate-400">방향성이 모호한 ' +
    thrLoPct +
    '~' +
    thrHiPct +
    '% 관망 구간을 제외하고, 20회 이상 검증된 고확신 신호만 집계합니다.</p>' +
    '</section>' +
    '<section class="mt-3 rounded-2xl bg-white border border-slate-200 p-4 shadow-sm">' +
    '<div class="flex items-center justify-between mb-2">' +
    '<h2 class="text-sm font-bold text-slate-900">전체 기간 모델 비교 (' +
    MARKET_NAMES[state.key] +
    ' · ' +
    (state.horizon === 5 ? '5거래일' : '1거래일') +
    ' · ' +
    pairs.length +
    '회)</h2>' +
    '</div>' +
    '<div class="overflow-x-auto">' +
    '<table class="w-full text-xs text-left border-collapse">' +
    '<thead><tr class="border-b border-slate-200 text-slate-500">' +
    '<th class="py-2 pr-2 font-semibold">모델</th>' +
    '<th class="py-2 px-2 font-semibold text-right">브라이어 점수</th>' +
    '<th class="py-2 pl-2 font-semibold text-right">80% 구간 적중률</th>' +
    '</tr></thead>' +
    '<tbody class="divide-y divide-slate-100 tabular-nums">' +
    '<tr class="bg-teal-50/50 font-semibold text-slate-900">' +
    '<td class="py-2.5 pr-2">개선 v5.5 (시장별 전용 엔진)</td>' +
    '<td class="py-2.5 px-2 text-right text-teal-800">' +
    fmtB(brierV4) +
    '</td>' +
    '<td class="py-2.5 pl-2 text-right text-teal-800">' +
    fmtPct(covV4) +
    '</td>' +
    '</tr>' +
    '<tr class="text-slate-700">' +
    '<td class="py-2.5 pr-2">기본 v2 (균등 가중 로지스틱)</td>' +
    '<td class="py-2.5 px-2 text-right">' +
    fmtB(brierV2) +
    '</td>' +
    '<td class="py-2.5 pl-2 text-right">' +
    fmtPct(covV2) +
    '</td>' +
    '</tr>' +
    (state.horizon === 1
      ? '<tr class="text-slate-600"><td class="py-2.5 pr-2">기존 v1 (단순 k-NN)</td><td class="py-2.5 px-2 text-right">' +
        fmtB(brierV1) +
        '</td><td class="py-2.5 pl-2 text-right">' +
        fmtPct(covV1) +
        '</td></tr>'
      : '') +
    '<tr class="text-slate-500">' +
    '<td class="py-2.5 pr-2">단순 기준 모델 (과거 상승 빈도)</td>' +
    '<td class="py-2.5 px-2 text-right">' +
    fmtB(brierBase) +
    '</td>' +
    '<td class="py-2.5 pl-2 text-right">-</td>' +
    '</tr>' +
    '</tbody></table></div>' +
    '</section>' +
    '<section class="mt-3 rounded-2xl bg-white border border-slate-200 p-4 shadow-sm">' +
    '<h2 class="text-sm font-bold text-slate-900 mb-1">실시간 조회 서버 연결 (Cloudflare Workers)</h2>' +
    '<p class="text-xs text-slate-500 mb-2">Cloudflare Workers에 배포한 중계 URL을 저장하면 상단 <strong>실시간 조회</strong> 버튼으로 KIS 국내지수·코스피200 선물·나스닥 선물을 즉시 반영합니다.</p>' +
    '<div class="flex gap-2">' +
    '<input id="worker-url-input" type="url" placeholder="https://index-daybook-live.xxx.workers.dev" value="' +
    escapeHtml(state.workerUrl) +
    '" class="flex-1 text-xs border border-slate-300 rounded-xl px-3 py-2 text-slate-800" />' +
    '<button id="worker-url-save" type="button" class="px-3.5 py-2 rounded-xl bg-teal-700 text-white text-xs font-semibold hover:bg-teal-800 transition whitespace-nowrap">저장</button>' +
    '</div>' +
    '</section>' +
    '<section class="mt-3 rounded-2xl bg-white border border-slate-200 p-4 shadow-sm">' +
    '<h2 class="text-sm font-bold text-slate-900 mb-1.5">최신 데이터 불러오기 (data.js / JSON / CSV)</h2>' +
    '<div class="flex flex-wrap items-center gap-2 mt-2">' +
    '<label class="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-900 text-white text-xs font-semibold cursor-pointer hover:bg-slate-800 transition">' +
    '<span>파일 선택 (JS/JSON/CSV)</span>' +
    '<input id="file-import" type="file" accept=".js,.json,.csv,.txt" class="hidden" />' +
    '</label>' +
    '<button id="data-reset" type="button" class="px-3.5 py-2 rounded-xl border border-slate-300 text-slate-700 text-xs font-semibold hover:bg-slate-50 transition">기본 스냅샷 복원</button>' +
    '</div>' +
    '<div class="mt-3 text-xs text-slate-500">현재 수록: 코스피 ' +
    (state.marketsData.KOSPI || []).length +
    '일 · 코스닥 ' +
    (state.marketsData.KOSDAQ || []).length +
    '일 · 나스닥 ' +
    (state.marketsData.NASDAQ || []).length +
    '일</div>' +
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
      try { localStorage.setItem('daybook_worker_url', val); } catch (_) {}
      showToast(val ? '실시간 중계 서버 주소를 저장했습니다.' : '실시간 서버 주소를 비웠습니다.');
    });
  }
  document.getElementById('data-reset').addEventListener('click', () => {
    state.marketsData = JSON.parse(JSON.stringify(markets));
    state.isLiveIntraday = false;
    recomputeMarket(state.key, false);
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
        recomputeMarket(state.key, false);
        showToast('데이터를 반영해 v5.5 전체 모델을 재계산했습니다.');
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
        recomputeMarket(state.key, false);
        showToast(MARKET_NAMES[state.key] + ' CSV ' + rows.length + '일을 반영했습니다.');
      }
    } catch (err) {
      showToast('데이터 파싱 오류: ' + err.message, true);
    }
  };
  reader.readAsText(file, 'utf-8');
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
        } else if (dateKst && dateKst > last[0]) {
          rows.push([dateKst, liveIdx.close, liveIdx.pct, useFx, null, null]);
        }
      }
    }

    state.isLiveIntraday = true;
    state.liveUpdatedKst = data.updatedKst || '';
    recomputeMarket(state.key, false);
    const warnMsg = data.warnings && data.warnings.length ? ' (' + data.warnings[0] + ')' : '';
    if (!isAuto) showToast('실시간 시세와 글로벌 뉴스를 반영했습니다.' + warnMsg);
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
  const tabsEl = document.getElementById('market-tabs');
  for (const [id, label] of Object.entries(MARKET_NAMES)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.key = id;
    b.addEventListener('click', () => recomputeMarket(id, false));
    tabsEl.append(b);
  }

  for (const btn of document.querySelectorAll('#horizon-tabs button')) {
    btn.addEventListener('click', () => {
      state.horizon = Number(btn.dataset.h);
      recomputeMarket(state.key, true);
    });
  }

  for (const btn of document.querySelectorAll('#view-tabs button')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }

  document.getElementById('date-select').addEventListener('change', e => {
    state.dateIdx = Number(e.target.value);
    const rows = state.marketsData[state.key] || [];
    const rawF = forecastSingleDay(rows, state.dateIdx, state.key, state.marketsData, state.horizon);
    const isLatest = state.dateIdx === rows.length - 1;
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
  recomputeMarket('KOSPI', false);
  switchTab('forecast');
  if (state.workerUrl) fetchLiveSnapshot(true);
}

document.addEventListener('DOMContentLoaded', initApp);

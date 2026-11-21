// 지수 관측소 v3.1 — 모바일 인터랙티브 앱 컨트롤러

const MARKET_NAMES = {
  KOSPI: '코스피',
  KOSDAQ: '코스닥',
  NASDAQ: '나스닥 종합'
};

const state = {
  marketsData: JSON.parse(JSON.stringify(markets)),
  key: 'KOSPI',
  tab: 'forecast',
  dateIdx: -1,
  currentForecast: null,
  historyV31: null,
  historyV2: null,
  historyV1: null,
  simValues: [],
  chartInstance: null
};

const fmtPct = x => (x === null || x === undefined || Number.isNaN(x) ? '-' : (100 * x).toFixed(1) + '%');
const fmtMove = x =>
  x === null || x === undefined || Number.isNaN(x)
    ? '사례 없음'
    : (x > 0 ? '+' : '') + x.toFixed(2) + '%';

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

function recomputeMarket(id) {
  state.key = id;
  const rows = state.marketsData[id] || [];
  state.historyV31 = null;
  state.historyV2 = null;
  state.historyV1 = null;

  const dateSel = document.getElementById('date-select');
  dateSel.replaceChildren();
  let latestValid = -1;
  for (let i = 24; i < rows.length; i++) {
    if (adjacent(rows[i - 1], rows[i])) {
      dateSel.prepend(new Option(rows[i][0], String(i)));
      latestValid = i;
    }
  }
  state.dateIdx = latestValid;
  if (latestValid >= 0) {
    dateSel.value = String(latestValid);
    state.currentForecast = forecastSingleDay(rows, latestValid, id, state.marketsData);
    state.simValues = state.currentForecast ? [...state.currentForecast.rawFeats] : [];
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

  const regimeBadgeClass =
    f.regimeTone === 'rose'
      ? 'bg-rose-500/20 text-rose-200 border border-rose-400/30'
      : f.regimeTone === 'teal'
        ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/30'
        : 'bg-slate-800 text-slate-200 border border-slate-700';

  const guardNotice =
    f.n < 60 || f.blockedReason
      ? '<div class="mt-3 rounded-xl bg-amber-50 border border-amber-200 px-3.5 py-2.5 text-xs text-amber-900 leading-relaxed"><strong>과적합 방어 작동:</strong> ' +
        (f.blockedReason ||
          '현재 학습 표본이 ' +
            f.n +
            '거래일뿐이어서 기준 빈도(' +
            fmtPct(f.base) +
            ') 방향으로 보수적으로 수축했습니다.') +
        ' <span class="text-amber-800">5년 치 데이터(update_data.py)를 연결하면 추가 지표가 자동 활성화됩니다.</span></div>'
      : '';

  const extraSection = f.candidates.length
    ? '<section class="mt-3 rounded-2xl bg-white border border-slate-200 p-4 shadow-sm">' +
      '<div class="flex items-center justify-between mb-1.5">' +
      '<h2 class="text-sm font-bold text-slate-900">확장 지표 상태</h2>' +
      '<span class="text-xs text-slate-500">미국장 기준 ' +
      (f.usDate || '미수록') +
      (f.usSessions > 1 ? ' (' + f.usSessions + '일 누적)' : '') +
      '</span>' +
      '</div>' +
      '<div class="divide-y divide-slate-100">' +
      f.candidates
        .map(k => {
          const val = f.extra[k];
          const hasVal = Number.isFinite(val);
          const isActive = f.active.includes(k);
          const badge = isActive
            ? '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-teal-50 text-teal-800">모델 반영</span>'
            : hasVal
              ? '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800">표본 대기(60일+)</span>'
              : '<span class="px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-500">미수록</span>';
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
        (pos ? 'text-teal-700' : 'text-rose-700') +
        '">' +
        (pos ? '+' : '') +
        c.impactPct.toFixed(2) +
        '%p</span>' +
        '</div>' +
        '<div class="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">' +
        '<div class="h-full rounded-full ' +
        (pos ? 'bg-teal-600' : 'bg-rose-500') +
        '" style="width:' +
        Math.max(4, barW).toFixed(1) +
        '%"></div>' +
        '</div>' +
        '</div>'
      );
    })
    .join('');

  const nextActual = adjacent(r, rows[i + 1])
    ? '<span class="font-semibold ' +
      (rows[i + 1][2] >= 0 ? 'text-teal-700' : 'text-rose-700') +
      '">' +
      fmtMove(rows[i + 1][2]) +
      '</span> (' +
      rows[i + 1][0] +
      ')'
    : '<span class="text-slate-500">다음 거래일 마감 전</span>';

  container.innerHTML =
    '<section class="rounded-2xl bg-slate-900 text-white p-5 shadow-sm">' +
    '<div class="flex items-center justify-between gap-2 flex-wrap">' +
    '<span class="text-xs font-medium text-slate-300">' +
    MARKET_NAMES[state.key] +
    ' 다음 거래일 상승 확률 (v3.1)</span>' +
    '<div class="flex items-center gap-1.5">' +
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
    '<div class="mt-2.5 flex items-baseline justify-between gap-3">' +
    '<div class="text-4xl sm:text-5xl font-bold tracking-tight text-emerald-300 tabular-nums">' +
    fmtPct(f.p) +
    '</div>' +
    '<div class="text-right">' +
    '<div class="text-xs text-slate-400">종합 점수</div>' +
    '<div class="text-xl font-bold text-white tabular-nums">' +
    f.score +
    '<span class="text-xs font-normal text-slate-400"> / 100</span></div>' +
    '</div>' +
    '</div>' +
    '<div class="mt-3 h-2.5 w-full bg-slate-700 rounded-full overflow-hidden">' +
    '<div class="h-full bg-emerald-400 rounded-full transition-all" style="width:' +
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
    guardNotice +
    '<section class="mt-3 rounded-2xl bg-white border border-slate-200 p-4 shadow-sm">' +
    '<div class="flex items-center justify-between mb-2">' +
    '<h2 class="text-sm font-bold text-slate-900">예상 등락 폭 (변동성 보정 80% 구간)</h2>' +
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
    '<div class="rounded-xl bg-teal-50/70 px-3 py-2.5">' +
    '<div class="text-xs text-teal-800">상승일 중앙값</div>' +
    '<div class="text-base font-bold text-teal-900 tabular-nums mt-0.5">' +
    fmtMove(f.gain) +
    '</div>' +
    '</div>' +
    '<div class="rounded-xl bg-rose-50/70 px-3 py-2.5">' +
    '<div class="text-xs text-rose-800">하락일 중앙값</div>' +
    '<div class="text-base font-bold text-rose-900 tabular-nums mt-0.5">' +
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
    '<h2 class="text-sm font-bold text-slate-900">최근 30거래일 종가 추이 및 다음날 예상 밴드</h2>' +
    '<span class="text-xs text-slate-500">P10 ~ P90</span>' +
    '</div>' +
    '<div class="relative h-56"><canvas id="priceChart"></canvas></div>' +
    '</section>' +
    '<section class="mt-3 rounded-2xl bg-white border border-slate-200 p-4 shadow-sm">' +
    '<div class="flex items-center justify-between mb-1.5">' +
    '<h2 class="text-sm font-bold text-slate-900">변수별 확률 기여도 분해</h2>' +
    '<span class="text-xs text-slate-500">정규화 가중치 기준</span>' +
    '</div>' +
    '<div>' +
    contribRows +
    '</div>' +
    '</section>';

  renderPriceChart();
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
  labels.push('다음날(예상)');

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
          borderColor: '#0284c7',
          borderDash: [4, 4],
          borderWidth: 1.5,
          pointRadius: 3,
          fill: false
        },
        {
          label: '예상 하단 (P10)',
          data: lowerBand,
          borderColor: '#e11d48',
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

  const simOut = predictWithModel(f.modelRef, state.simValues, state.simValues[3], state.key, meta);
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
    ' 시나리오 시뮬레이션</span>' +
    '<span id="sim-change" class="text-xs font-semibold tabular-nums ' +
    (diffP >= 0 ? 'text-emerald-300' : 'text-rose-300') +
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
    '<p class="mt-2 text-xs text-slate-400">장전 야간 나스닥 누적 등락, 환율, 단기 변동성을 슬라이더로 조정해 방향 확률과 80% 예상 밴드 변화를 즉시 확인합니다.</p>' +
    '</section>' +
    '<section class="mt-3 rounded-2xl bg-white border border-slate-200 p-4 shadow-sm">' +
    '<div class="flex items-center justify-between mb-2">' +
    '<h2 class="text-sm font-bold text-slate-900">입력 변수 조정</h2>' +
    '<button id="sim-reset" type="button" class="text-xs font-semibold text-teal-700 hover:text-teal-900 px-2.5 py-1 rounded-lg bg-teal-50">현재 기준값 복원</button>' +
    '</div>' +
    '<div>' +
    slidersHtml +
    '</div>' +
    '</section>';

  for (const input of container.querySelectorAll('input[type="range"]')) {
    input.addEventListener('input', e => {
      const idx = Number(e.target.dataset.idx);
      state.simValues[idx] = Number(e.target.value);
      const updated = predictWithModel(f.modelRef, state.simValues, state.simValues[3], state.key, meta);
      const m = meta[idx];
      document.getElementById('sim-val-' + idx).textContent =
        (state.simValues[idx] > 0 && m.key !== 'vol10' && m.key !== 'vix' && m.key !== 'breadth' ? '+' : '') +
        state.simValues[idx].toFixed(2) +
        m.unit;
      document.getElementById('sim-prob').textContent = fmtPct(updated.p);
      const dPct = (updated.p - f.p) * 100;
      const chEl = document.getElementById('sim-change');
      chEl.textContent = '기존 대비 ' + (dPct >= 0 ? '+' : '') + dPct.toFixed(1) + '%p';
      chEl.className = 'text-xs font-semibold tabular-nums ' + (dPct >= 0 ? 'text-emerald-300' : 'text-rose-300');
      document.getElementById('sim-band').textContent =
        fmtMove(updated.low) + ' ~ ' + fmtMove(updated.high);
    });
  }

  document.getElementById('sim-reset').addEventListener('click', () => {
    state.simValues = [...f.rawFeats];
    renderSimulator();
    showToast('선택한 기준일의 실제 변수 값으로 복원했습니다.');
  });
}

function renderBacktest() {
  const rows = state.marketsData[state.key] || [];
  const i = state.dateIdx;
  const container = document.getElementById('backtest-content');
  if (!state.historyV31 || !state.historyV2) {
    const res = buildHistories(rows, state.key, state.marketsData);
    state.historyV31 = res.enhanced;
    state.historyV2 = res.base;
  }
  if (!state.historyV1) {
    state.historyV1 = rows.map((_, idx) => forecastV1(rows, idx));
  }

  const pairs = [];
  for (let j = 0; j < i; j++) {
    const p31 = state.historyV31[j];
    const p2 = state.historyV2[j];
    const p1 = state.historyV1[j];
    if (p31 && p2 && p1 && adjacent(rows[j], rows[j + 1])) {
      pairs.push({ p31, p2, p1, y: rows[j + 1][2] });
    }
  }

  const avg = fn => (pairs.length ? pairs.reduce((s, v) => s + fn(v), 0) / pairs.length : null);
  const brierV31 = avg(v => (v.p31.p - Number(v.y > 0)) ** 2);
  const brierV2 = avg(v => (v.p2.p - Number(v.y > 0)) ** 2);
  const brierV1 = avg(v => (v.p1.p - Number(v.y > 0)) ** 2);
  const brierBase = avg(v => (v.p2.base - Number(v.y > 0)) ** 2);
  const covV31 = avg(v => Number(v.y >= v.p31.low && v.y <= v.p31.high));
  const covV2 = avg(v => Number(v.y >= v.p2.low && v.y <= v.p2.high));
  const covV1 = avg(v => Number(v.y >= v.p1.low && v.y <= v.p1.high));
  const activeCount = pairs.filter(v => v.p31.active && v.p31.active.length).length;

  const fmtB = x => (x === null ? '-' : x.toFixed(4));

  container.innerHTML =
    '<section class="rounded-2xl bg-white border border-slate-200 p-4 shadow-sm">' +
    '<div class="flex items-center justify-between mb-2">' +
    '<h2 class="text-sm font-bold text-slate-900">워크포워드 모델 성능 비교 (' +
    MARKET_NAMES[state.key] +
    ' · ' +
    pairs.length +
    '회)</h2>' +
    '<span class="text-xs text-slate-500">동일 기간 공정 평가</span>' +
    '</div>' +
    '<p class="text-xs text-slate-600 mb-3">브라이어 점수는 0에 가까울수록(동전 던지기 = 0.2500), 80% 구간 적중률은 80%에 가까울수록 우수합니다.</p>' +
    '<div class="overflow-x-auto">' +
    '<table class="w-full text-xs text-left border-collapse">' +
    '<thead><tr class="border-b border-slate-200 text-slate-500">' +
    '<th class="py-2 pr-2 font-semibold">모델</th>' +
    '<th class="py-2 px-2 font-semibold text-right">브라이어 점수</th>' +
    '<th class="py-2 pl-2 font-semibold text-right">80% 구간 적중률</th>' +
    '</tr></thead>' +
    '<tbody class="divide-y divide-slate-100 tabular-nums">' +
    '<tr class="bg-teal-50/50 font-semibold text-slate-900">' +
    '<td class="py-2.5 pr-2">개선 v3.1 (확장 활성 ' +
    activeCount +
    '회)</td>' +
    '<td class="py-2.5 px-2 text-right text-teal-800">' +
    fmtB(brierV31) +
    '</td>' +
    '<td class="py-2.5 pl-2 text-right text-teal-800">' +
    fmtPct(covV31) +
    '</td>' +
    '</tr>' +
    '<tr class="text-slate-700">' +
    '<td class="py-2.5 pr-2">기본 v2 (정규화 로지스틱)</td>' +
    '<td class="py-2.5 px-2 text-right">' +
    fmtB(brierV2) +
    '</td>' +
    '<td class="py-2.5 pl-2 text-right">' +
    fmtPct(covV2) +
    '</td>' +
    '</tr>' +
    '<tr class="text-slate-600">' +
    '<td class="py-2.5 pr-2">기존 v1 (단순 k-NN)</td>' +
    '<td class="py-2.5 px-2 text-right">' +
    fmtB(brierV1) +
    '</td>' +
    '<td class="py-2.5 pl-2 text-right">' +
    fmtPct(covV1) +
    '</td>' +
    '</tr>' +
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
    '<h2 class="text-sm font-bold text-slate-900 mb-1.5">최신 데이터 불러오기 (data.js / JSON / CSV)</h2>' +
    '<p class="text-xs text-slate-600 mb-3"><code class="bg-slate-100 px-1 py-0.5 rounded">update_data.py</code>로 생성한 5년 치 <code class="bg-slate-100 px-1 py-0.5 rounded">data.js</code>나 CSV를 올리면 확장 지표(SOX·수급·VIX·국채금리·DXY)가 자동 활성화됩니다.</p>' +
    '<div class="flex flex-wrap items-center gap-2">' +
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
    '일 · SOX ' +
    (state.marketsData.SOX || []).length +
    '일' +
    ((state.marketsData.VIX || []).length ? ' · VIX ' + state.marketsData.VIX.length + '일' : '') +
    '</div>' +
    '</section>';

  document.getElementById('file-import').addEventListener('change', handleFileImport);
  document.getElementById('data-reset').addEventListener('click', () => {
    state.marketsData = JSON.parse(JSON.stringify(markets));
    recomputeMarket(state.key);
    showToast('기본 수록 데이터로 복원했습니다.');
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
        state.marketsData = {
          ...state.marketsData,
          ...parsed
        };
        recomputeMarket(state.key);
        showToast('데이터를 반영해 v3.1 전체 모델을 재계산했습니다.');
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
        recomputeMarket(state.key);
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

function initApp() {
  const tabsEl = document.getElementById('market-tabs');
  for (const [id, label] of Object.entries(MARKET_NAMES)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.key = id;
    b.addEventListener('click', () => recomputeMarket(id));
    tabsEl.append(b);
  }

  for (const btn of document.querySelectorAll('#view-tabs button')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }

  document.getElementById('date-select').addEventListener('change', e => {
    state.dateIdx = Number(e.target.value);
    const rows = state.marketsData[state.key] || [];
    state.currentForecast = forecastSingleDay(rows, state.dateIdx, state.key, state.marketsData);
    state.simValues = state.currentForecast ? [...state.currentForecast.rawFeats] : [];
    renderAll();
  });

  recomputeMarket('KOSPI');
  switchTab('forecast');
}

document.addEventListener('DOMContentLoaded', initApp);

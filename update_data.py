"""
지수 관측소 v5.5 — 일간 시세·KIS 국내선물(토큰 1일 1회 캐싱)·BTC 무기한 선물·국문 뉴스 요약 자동 수집 스크립트
- 실행: python3 update_data.py --years 5 --krx-days 30
- 수집 항목:
  * 국내·미국 지수 및 매크로: ^KS11, ^KQ11, ^IXIC, KRW=X, ^SOX, ^VIX, ^VIX3M, ^TNX, DX-Y.NYB, ^GDAXI, CL=F, GC=F
  * 한국투자증권 실전 API(FHMIF10000000): 코스피200 최근월물 선물 현재가·등락률·베이시스 (토큰 /tmp 캐싱)
  * 글로벌 선물 스냅샷: 나스닥100(NQ=F), S&P500(ES=F), WTI(CL=F), 금(GC=F), BTC 무기한 선물(Binance->OKX->Yahoo)
  * 국문 경제 뉴스 1줄 요약(한경·매경 RSS) + 미국 증시 속보 자동 한글 번역 및 심리 점수(-100 ~ +100)
"""
import argparse
import io
import json
import math
import os
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
import yfinance as yf

KIS_REAL_BASE = "https://openapi.koreainvestment.com:9443"
KIS_TOKEN_CACHE_PATH = Path(os.environ.get("KIS_TOKEN_CACHE", "/tmp/kis_token_cache.json"))


def _http_get_json(url: str, headers: dict = None, timeout: int = 12):
    req_headers = {"User-Agent": "Mozilla/5.0"}
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(url, headers=req_headers, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_post_json(url: str, payload: dict, headers: dict = None, timeout: int = 15):
    body = json.dumps(payload).encode("utf-8")
    req_headers = {"Content-Type": "application/json; charset=UTF-8", "User-Agent": "Mozilla/5.0"}
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(url, data=body, headers=req_headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_kis_access_token(app_key: str, app_secret: str):
    """KIS 1일 1회 토큰 발급 원칙 준수: /tmp 캐시 파일에서 20시간 내 유효 토큰 재사용"""
    now_ts = time.time()
    if KIS_TOKEN_CACHE_PATH.exists():
        try:
            cached = json.loads(KIS_TOKEN_CACHE_PATH.read_text(encoding="utf-8"))
            if cached.get("access_token") and cached.get("expires_at", 0) > now_ts:
                print("KIS 캐시 토큰 재사용")
                return cached["access_token"]
        except Exception:
            pass

    tok_res = _http_post_json(
        f"{KIS_REAL_BASE}/oauth2/tokenP",
        {"grant_type": "client_credentials", "appkey": app_key, "appsecret": app_secret},
    )
    access_token = tok_res.get("access_token")
    if not access_token:
        raise RuntimeError(f"KIS 토큰 발급 실패: {tok_res}")

    try:
        KIS_TOKEN_CACHE_PATH.write_text(
            json.dumps({"access_token": access_token, "expires_at": now_ts + 72000}),
            encoding="utf-8",
        )
    except Exception as exc:
        print(f"KIS 토큰 캐시 저장 건너뜀: {exc}")
    return access_token


def _resolve_kospi200_futures_candidates():
    cands = []
    env_code = os.environ.get("KIS_FUTURES_CODE", "").strip()
    if env_code:
        cands.append(env_code)

    try:
        mst_url = "https://new.real.download.dws.co.kr/common/master/fo_idx_code_mts.mst.zip"
        req = urllib.request.Request(mst_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=12) as resp:
            zbytes = resp.read()
        with zipfile.ZipFile(io.BytesIO(zbytes)) as zf:
            for name in zf.namelist():
                raw = zf.read(name).decode("cp949", errors="ignore")
                for line in raw.splitlines():
                    parts = [p.strip() for p in line.split("|")]
                    if len(parts) < 3:
                        continue
                    short_code, kor_name = parts[1], parts[2]
                    if ("코스피200" in kor_name or "KOSPI200" in kor_name.upper()) and "선물" in kor_name:
                        if "미니" in kor_name or "스프레드" in kor_name or "SP" in short_code.upper():
                            continue
                        if re.match(r"^(A01|101)[0-9A-Z]{2,5}$", short_code) and short_code not in cands:
                            cands.append(short_code)
    except Exception as exc:
        print(f"KIS 마스터 파일 조회 건너뜀: {exc}")

    now_kst = datetime.now(ZoneInfo("Asia/Seoul"))
    y, m = now_kst.year, now_kst.month
    next_qs = [(y, qm) for qm in (3, 6, 9, 12) if qm > m or (qm == m and now_kst.day <= 14)]
    next_qs.append((y + 1, 3))
    month_hex = {3: "3", 6: "6", 9: "9", 12: "C"}
    year_old = {2025: "W", 2026: "X", 2027: "Y", 2028: "Z"}
    for qy, qm in next_qs[:2]:
        for c in (f"A01{str(qy)[-1]}{month_hex[qm]}", f"A01{str(qy)[-1]}{qm:02d}"):
            if c not in cands:
                cands.append(c)
        if qy in year_old:
            code_old = f"101{year_old[qy]}{qm:02d}"
            if code_old not in cands:
                cands.append(code_old)
    return cands


def fetch_kis_domestic_futures():
    app_key = os.environ.get("KIS_APP_KEY", "").strip()
    app_secret = os.environ.get("KIS_APP_SECRET", "").strip()
    if not app_key or not app_secret:
        print("KIS_APP_KEY / KIS_APP_SECRET 미설정 — 국내선물 API 건너뜀")
        return None

    try:
        access_token = get_kis_access_token(app_key, app_secret)
        headers = {
            "Content-Type": "application/json; charset=UTF-8",
            "authorization": f"Bearer {access_token}",
            "appkey": app_key,
            "appsecret": app_secret,
            "tr_id": "FHMIF10000000",
            "custtype": "P",
        }
        for code in _resolve_kospi200_futures_candidates():
            url = (
                f"{KIS_REAL_BASE}/uapi/domestic-futureoption/v1/quotations/inquire-price"
                f"?FID_COND_MRKT_DIV_CODE=F&FID_INPUT_ISCD={code}"
            )
            try:
                res = _http_get_json(url, headers=headers)
                if res.get("rt_cd") != "0":
                    continue
                out1 = res.get("output1") or {}
                out3 = res.get("output3") or {}
                price_str = out1.get("futs_prpr") or out1.get("stck_prpr")
                if not price_str:
                    continue
                price = float(price_str)
                if price <= 0:
                    continue
                pct = float(out1.get("futs_prdy_ctrt") or 0.0)
                basis_raw = out1.get("mrkt_basis") or out1.get("basis") or out3.get("mrkt_basis")
                basis = round(float(basis_raw), 2) if basis_raw not in (None, "") else None
                name = (out1.get("hts_kor_isnm") or f"코스피200 선물 ({code})").strip()
                print(f"KIS 국내선물 수집 성공: {code} ({name}) {price} ({pct:+.2f}%, 베이시스 {basis})")
                return {
                    "K200": round(price, 2),
                    "K200_pct": round(pct, 2),
                    "K200_basis": basis,
                    "K200_code": code,
                    "K200_name": name,
                }
            except Exception:
                continue
    except Exception as exc:
        print(f"KIS 국내선물 API 오류: {exc}")
    return None


def fetch_btc_perp():
    # 1) Binance Futures
    try:
        t = _http_get_json("https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT")
        price = float(t["lastPrice"])
        pct = float(t["priceChangePercent"])
        funding = None
        try:
            f = _http_get_json("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT")
            funding = round(float(f["lastFundingRate"]) * 100.0, 4)
        except Exception:
            pass
        if price > 0:
            return {"BTC": round(price), "BTC_pct": round(pct, 2), "BTC_funding": funding, "BTC_src": "Binance"}
    except Exception:
        pass

    # 2) OKX BTC-USDT-SWAP Fallback
    try:
        tj = _http_get_json("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP")
        row = (tj.get("data") or [{}])[0]
        price = float(row["last"])
        open24 = float(row.get("open24h") or price)
        pct = ((price / open24) - 1.0) * 100.0 if open24 else 0.0
        funding = None
        try:
            fj = _http_get_json("https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP")
            funding = round(float((fj.get("data") or [{}])[0]["fundingRate"]) * 100.0, 4)
        except Exception:
            pass
        if price > 0:
            return {"BTC": round(price), "BTC_pct": round(pct, 2), "BTC_funding": funding, "BTC_src": "OKX"}
    except Exception:
        pass

    # 3) Yahoo BTC-USD Fallback
    try:
        df = yf.download("BTC-USD", period="5d", interval="1d", progress=False)
        if not df.empty:
            close = df["Close"].squeeze().dropna()
            if len(close) >= 2:
                last_p, prev_p = float(close.iloc[-1]), float(close.iloc[-2])
                pct = ((last_p / prev_p) - 1.0) * 100.0 if prev_p else 0.0
                return {"BTC": round(last_p), "BTC_pct": round(pct, 2), "BTC_funding": None, "BTC_src": "Yahoo"}
    except Exception:
        pass
    return {}


def fetch_series(ticker: str, years: int = 5):
    zone = "Asia/Seoul" if ticker in ("^KS11", "^KQ11") else "America/New_York"
    local = datetime.now(ZoneInfo(zone))
    end = local + timedelta(days=int(local.hour >= 18))
    start = end - timedelta(days=365 * years)
    df = yf.download(
        ticker,
        start=start.strftime("%Y-%m-%d"),
        end=end.strftime("%Y-%m-%d"),
        progress=False,
    )
    if df.empty:
        raise RuntimeError(f"데이터를 가져오지 못했습니다: {ticker}")
    close = df["Close"].squeeze().dropna()
    pct = close.pct_change() * 100.0
    out = {}
    for dt, val in close.items():
        d_str = dt.strftime("%Y-%m-%d")
        p_val = pct.loc[dt]
        if p_val != p_val:
            continue
        out[d_str] = (round(float(val), 2), round(float(p_val), 4))
    return out


def fetch_optional_series(ticker: str, years: int = 5):
    try:
        return fetch_series(ticker, years=years)
    except Exception as exc:
        print(f"선택 지표 건너뜀({ticker}): {exc}")
        return {}


def fetch_live_futures():
    snapshot = {"updatedKst": datetime.now(ZoneInfo("Asia/Seoul")).strftime("%Y-%m-%d %H:%M KST")}
    pairs = [("NQ=F", "NQ"), ("ES=F", "ES"), ("CL=F", "CL"), ("GC=F", "GC")]
    for ticker, key in pairs:
        try:
            df = yf.download(ticker, period="5d", interval="1d", progress=False)
            if df.empty:
                continue
            close = df["Close"].squeeze().dropna()
            if len(close) >= 2:
                last_p = float(close.iloc[-1])
                prev_p = float(close.iloc[-2])
                pct = (last_p / prev_p - 1.0) * 100.0 if prev_p else 0.0
                snapshot[key] = round(last_p, 2)
                snapshot[f"{key}_pct"] = round(pct, 2)
        except Exception as exc:
            print(f"선물 스냅샷 건너뜀({ticker}): {exc}")
    snapshot.update(fetch_btc_perp())
    return snapshot


POS_WORDS = ("rally", "surge", "gain", "rise", "jump", "beat", "cut", "dovish", "cooling", "growth", "record", "up", "rebound", "bull", "soar", "boost", "상승", "반등", "호조", "강세", "완화", "최고", "급등", "돌파", "기대", "순매수")
NEG_WORDS = ("drop", "fall", "plunge", "slump", "crash", "fear", "inflation", "hawkish", "tariff", "war", "risk", "down", "selloff", "bear", "sink", "tumble", "하락", "급락", "우려", "약세", "관세", "충격", "폭락", "위기", "경계", "순매도", "긴축")


def _clean_text(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s or "")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _translate_en_to_ko(text: str) -> str:
    try:
        url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q={urllib.parse.quote(text)}"
        data = _http_get_json(url, timeout=8)
        if isinstance(data, list) and data and isinstance(data[0], list):
            joined = "".join(seg[0] for seg in data[0] if isinstance(seg, list) and seg and seg[0])
            return joined.strip() or text
    except Exception:
        pass
    return text


def fetch_global_news(limit: int = 15):
    items = []
    seen = set()

    # 1) 국내 경제지 증권 RSS (국문 + 1줄 요약)
    kr_feeds = [
        ("한국경제", "https://www.hankyung.com/feed/finance"),
        ("매일경제", "https://www.mk.co.kr/rss/50200011/"),
    ]
    for source_name, url in kr_feeds:
        if len(items) >= 10:
            break
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                xml_bytes = resp.read()
            root = ET.fromstring(xml_bytes)
            for item in root.findall(".//item"):
                title = _clean_text(item.findtext("title") or "")
                link = (item.findtext("link") or "").strip()
                summary = _clean_text(item.findtext("description") or "")
                if len(summary) > 96:
                    summary = summary[:95] + "…"
                if not title or title in seen:
                    continue
                seen.add(title)
                items.append({"title": title, "summary": summary, "url": link, "source": source_name, "translated": False})
                if len(items) >= 10:
                    break
        except Exception as exc:
            print(f"국문 뉴스 RSS 건너뜀({source_name}): {exc}")

    # 2) 미국 증시 글로벌 속보 (Yahoo Finance JSON -> 자동 국문 번역 + 번역 링크)
    try:
        y_url = "https://query1.finance.yahoo.com/v1/finance/search?q=NASDAQ+Fed+stock+market&newsCount=8&quotesCount=0"
        y_json = _http_get_json(y_url, timeout=10)
        for n in y_json.get("news", []):
            if len(items) >= limit:
                break
            title = str(n.get("title") or "").strip()
            link = str(n.get("link") or "").strip()
            source = str(n.get("publisher") or "Yahoo Finance").strip()
            if not title or title in seen:
                continue
            seen.add(title)
            ko_title = _translate_en_to_ko(title)
            ko_url = f"https://translate.google.com/translate?sl=en&tl=ko&u={urllib.parse.quote(link, safe='')}" if link else ""
            items.append({
                "title": ko_title,
                "summary": f"원문: {title}" if ko_title != title else "",
                "url": ko_url,
                "source": source,
                "translated": True,
            })
    except Exception as exc:
        print(f"영문 뉴스 조회 건너뜀: {exc}")

    pos_hits = 0
    neg_hits = 0
    for it in items:
        low = f"{it['title']} {it.get('summary', '')}".lower()
        pos_hits += sum(1 for w in POS_WORDS if w in low)
        neg_hits += sum(1 for w in NEG_WORDS if w in low)
    total = pos_hits + neg_hits
    sentiment = round(((pos_hits - neg_hits) / total) * 100) if total else 0
    return {
        "updatedKst": datetime.now(ZoneInfo("Asia/Seoul")).strftime("%Y-%m-%d %H:%M KST"),
        "sentiment": sentiment,
        "items": items[:limit],
    }


def fetch_kr_signals(market: str, dates, saved_map, recent_days: int = 30, backfill_kosdaq: bool = False):
    signals = {d: list(saved_map.get(d, [None, None])) for d in dates}
    try:
        from pykrx import stock
    except Exception as exc:
        print(f"{market}: pykrx 건너뜀({exc})")
        return signals

    sorted_dates = sorted(dates)
    if not sorted_dates:
        return signals

    try:
        for year in sorted({d[:4] for d in sorted_dates}):
            chunk = [d for d in sorted_dates if d.startswith(year)]
            start, end = chunk[0].replace("-", ""), chunk[-1].replace("-", "")
            net_df = stock.get_market_trading_value_by_date(start, end, market)
            buy_df = stock.get_market_trading_value_by_date(start, end, market, on="매수")
            if "외국인합계" in net_df.columns and "전체" in buy_df.columns:
                ratios = 100.0 * net_df["외국인합계"] / buy_df["전체"].where(buy_df["전체"] > 0)
                for dt, ratio in ratios.dropna().items():
                    d_str = dt.strftime("%Y-%m-%d")
                    if d_str in signals and math.isfinite(ratio):
                        signals[d_str][1] = round(float(ratio), 5)
    except Exception as exc:
        print(f"{market}: 외국인 수급 조회 건너뜀({exc})")

    if market == "KOSDAQ":
        target_dates = sorted_dates if backfill_kosdaq else sorted_dates[-recent_days:]
        for d_str in target_dates:
            if signals[d_str][0] is not None:
                continue
            try:
                frame = stock.get_market_ohlcv_by_ticker(d_str.replace("-", ""), market=market)
                if not frame.empty and "종가" in frame.columns and "등락률" in frame.columns:
                    changes = frame.loc[frame["종가"] > 0, "등락률"].dropna()
                    if len(changes):
                        signals[d_str][0] = round(float(100.0 * (changes > 0).mean()), 5)
                time.sleep(0.4)
            except Exception as exc:
                print(f"KOSDAQ {d_str} 상승 비율 조회 중단({exc})")
                break

    return signals


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--years", type=int, default=5)
    parser.add_argument("--krx-days", type=int, default=30)
    parser.add_argument("--backfill-kosdaq", action="store_true")
    args = parser.parse_args()

    kospi = fetch_series("^KS11", years=args.years)
    kosdaq = fetch_series("^KQ11", years=args.years)
    nasdaq = fetch_series("^IXIC", years=args.years)
    usdkrw = fetch_series("KRW=X", years=args.years)
    sox = fetch_series("^SOX", years=args.years)
    vix = fetch_series("^VIX", years=args.years)
    vix3m = fetch_optional_series("^VIX3M", years=args.years)
    tnx = fetch_series("^TNX", years=args.years)
    dxy = fetch_series("DX-Y.NYB", years=args.years)
    oil = fetch_optional_series("CL=F", years=args.years)
    gold = fetch_optional_series("GC=F", years=args.years)
    dax = fetch_optional_series("^GDAXI", years=args.years)

    data_path = Path(__file__).with_name("data.js")
    saved = {}
    if data_path.exists():
        saved = json.loads(data_path.read_text(encoding="utf-8").split("=", 1)[1].strip().rstrip(";"))

    fx_dates = sorted(usdkrw.keys())

    def latest_fx(d_str: str):
        prev = None
        for fd in fx_dates:
            if fd <= d_str:
                prev = usdkrw[fd][0]
            else:
                break
        return prev

    def build_kr(series, market):
        prev_map = {row[0]: row[4:6] for row in saved.get(market, []) if len(row) >= 6}
        sig = fetch_kr_signals(market, series.keys(), prev_map, args.krx_days, args.backfill_kosdaq)
        rows = []
        for d in sorted(series.keys()):
            c, p = series[d]
            fx = latest_fx(d)
            if fx is not None:
                rows.append([d, c, round(p, 2), fx, *sig[d]])
        return rows

    kis_fut = fetch_kis_domestic_futures()
    kr_fut_hist_map = {row[0]: row[1:] for row in saved.get("KR_FUT_HIST", []) if isinstance(row, list) and len(row) >= 2}
    news_now = fetch_global_news()
    today_kst = datetime.now(ZoneInfo("Asia/Seoul")).strftime("%Y-%m-%d")
    news_hist_map = {row[0]: row[1] for row in saved.get("NEWS_HIST", []) if isinstance(row, list) and len(row) >= 2}
    if news_now.get("items"):
        news_hist_map[today_kst] = news_now.get("sentiment", 0)
    news_hist = [[d, news_hist_map[d]] for d in sorted(news_hist_map.keys())]
    if kis_fut and kis_fut.get("K200_pct") is not None:
        kr_fut_hist_map[today_kst] = [kis_fut["K200_pct"], kis_fut.get("K200_basis")]
    kr_fut_hist = [[d, *kr_fut_hist_map[d]] for d in sorted(kr_fut_hist_map.keys())]

    payload = {
        "KOSPI": build_kr(kospi, "KOSPI"),
        "KOSDAQ": build_kr(kosdaq, "KOSDAQ"),
        "NASDAQ": [[d, nasdaq[d][0], nasdaq[d][1]] for d in sorted(nasdaq)],
        "SOX": [[d, sox[d][0]] for d in sorted(sox)],
        "VIX": [[d, vix[d][0]] for d in sorted(vix)],
        "VIX3M": [[d, vix3m[d][0]] for d in sorted(vix3m)],
        "TNX": [[d, tnx[d][0]] for d in sorted(tnx)],
        "DXY": [[d, dxy[d][0]] for d in sorted(dxy)],
        "CL": [[d, oil[d][0]] for d in sorted(oil)],
        "GC": [[d, gold[d][0]] for d in sorted(gold)],
        "DAX": [[d, dax[d][0]] for d in sorted(dax)],
        "FUTURES": {**fetch_live_futures(), **(kis_fut or {})},
        "NEWS": news_now,
        "NEWS_HIST": news_hist,
        "KR_FUT_HIST": kr_fut_hist,
    }

    temp = data_path.with_suffix(".tmp")
    with temp.open("w", encoding="utf-8") as f:
        f.write("const markets = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n")
    temp.replace(data_path)
    print(f"Updated v5.5 data.js -> KOSPI:{len(payload['KOSPI'])}, NEWS:{len(payload['NEWS']['items'])}, BTC:{payload['FUTURES'].get('BTC')}")


if __name__ == "__main__":
    main()

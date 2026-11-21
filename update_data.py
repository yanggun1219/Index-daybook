"""
지수 관측소 v3.2 — 일간 시세·원자재·선물·글로벌 뉴스 자동 수집 스크립트
- 실행: python3 update_data.py --years 5 --krx-days 30
- 수집 항목:
  * 국내·미국 지수 및 매크로: ^KS11, ^KQ11, ^IXIC, KRW=X, ^SOX, ^VIX, ^TNX, DX-Y.NYB
  * 원자재 5년 일봉: WTI 국제유가(CL=F), 국제 금 선물(GC=F)
  * 장전 실시간 선물 스냅샷: 나스닥100 선물(NQ=F), S&P500 선물(ES=F), WTI(CL=F), 금(GC=F)
  * 글로벌 주요 경제 뉴스 RSS 헤드라인 및 간이 심리 점수(-100 ~ +100)
"""
import argparse
import json
import math
import os
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
import yfinance as yf


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
    return snapshot


POS_WORDS = ("rally", "surge", "gain", "rise", "jump", "beat", "cut", "dovish", "cooling", "growth", "record", "up", "rebound", "상승", "반등", "호조", "강세", "완화")
NEG_WORDS = ("drop", "fall", "plunge", "slump", "crash", "fear", "inflation", "hawkish", "tariff", "war", "risk", "down", "selloff", "하락", "급락", "우려", "약세", "관세", "충격")


def fetch_global_news(limit: int = 6):
    feeds = [
        ("Yahoo Finance", "https://finance.yahoo.com/news/rssindex"),
        ("Google News 경제", "https://news.google.com/rss/search?q=NASDAQ+OR+KOSPI+OR+Fed+OR+oil&hl=en-US&gl=US&ceid=US:en"),
    ]
    items = []
    seen = set()
    for source_name, url in feeds:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                xml_bytes = resp.read()
            root = ET.fromstring(xml_bytes)
            for item in root.findall(".//item"):
                title = (item.findtext("title") or "").strip()
                link = (item.findtext("link") or "").strip()
                if not title or title in seen:
                    continue
                seen.add(title)
                items.append({"title": title, "url": link, "source": source_name})
                if len(items) >= limit:
                    break
        except Exception as exc:
            print(f"뉴스 RSS 건너뜀({source_name}): {exc}")
        if len(items) >= limit:
            break

    pos_hits = 0
    neg_hits = 0
    for it in items:
        low = it["title"].lower()
        pos_hits += sum(1 for w in POS_WORDS if w in low)
        neg_hits += sum(1 for w in NEG_WORDS if w in low)
    total = pos_hits + neg_hits
    sentiment = round(((pos_hits - neg_hits) / total) * 100) if total else 0
    return {
        "updatedKst": datetime.now(ZoneInfo("Asia/Seoul")).strftime("%Y-%m-%d %H:%M KST"),
        "sentiment": sentiment,
        "items": items[:5],
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
    tnx = fetch_series("^TNX", years=args.years)
    dxy = fetch_series("DX-Y.NYB", years=args.years)
    oil = fetch_series("CL=F", years=args.years)
    gold = fetch_series("GC=F", years=args.years)

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

    payload = {
        "KOSPI": build_kr(kospi, "KOSPI"),
        "KOSDAQ": build_kr(kosdaq, "KOSDAQ"),
        "NASDAQ": [[d, nasdaq[d][0], nasdaq[d][1]] for d in sorted(nasdaq)],
        "SOX": [[d, sox[d][0]] for d in sorted(sox)],
        "VIX": [[d, vix[d][0]] for d in sorted(vix)],
        "TNX": [[d, tnx[d][0]] for d in sorted(tnx)],
        "DXY": [[d, dxy[d][0]] for d in sorted(dxy)],
        "CL": [[d, oil[d][0]] for d in sorted(oil)],
        "GC": [[d, gold[d][0]] for d in sorted(gold)],
        "FUTURES": fetch_live_futures(),
        "NEWS": fetch_global_news(),
    }

    temp = data_path.with_suffix(".tmp")
    with temp.open("w", encoding="utf-8") as f:
        f.write("const markets = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n")
    temp.replace(data_path)
    print(f"Updated v3.2 data.js -> KOSPI:{len(payload['KOSPI'])}, CL:{len(payload['CL'])}, NEWS:{len(payload['NEWS']['items'])}")


if __name__ == "__main__":
    main()

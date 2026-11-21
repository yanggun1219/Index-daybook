"""
지수 관측소 v3.1 — 일간 시세·매크로·수급 자동 수집 및 알림 스크립트
- 실행: python3 update_data.py [--krx-days 30] [--backfill-kosdaq]
- 필요 패키지: pip install yfinance pandas pykrx requests
- 수집 항목:
  * 국내 지수·환율: KOSPI(^KS11), KOSDAQ(^KQ11), USD/KRW(KRW=X)
  * 미국 지수·매크로: NASDAQ(^IXIC), SOX(^SOX), VIX(^VIX), US 10Y(^TNX), DXY(DX-Y.NYB)
  * 국내 수급·시장폭(선택): pykrx 공개 조회 (기본 최근 30일 증분 수집으로 타임아웃 방지)
- 알림(선택): TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID 또는 DISCORD_WEBHOOK_URL 환경변수 설정 시 자동 발송
"""
import argparse
import json
import math
import os
import time
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


def fetch_kr_signals(market: str, dates, saved_map, recent_days: int = 30, backfill_kosdaq: bool = False):
    signals = {d: list(saved_map.get(d, [None, None])) for d in dates}
    try:
        from pykrx import stock
    except Exception as exc:
        print(f"{market}: pykrx 미설치 또는 로드 실패({exc}); 기존 저장값 유지")
        return signals

    sorted_dates = sorted(dates)
    if not sorted_dates:
        return signals

    # 외국인 현물 순매수 강도: 연도별 일괄 조회 (빠름)
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

    # 코스닥 상승 종목 비율: 기본은 최근 N거래일 미수록분만 증분 조회해 타임아웃 방지
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
                print(f"KOSDAQ {d_str} 상승 비율 조회 실패({exc}); 중단")
                break

    return signals


def send_notification(payload):
    msg_lines = ["[지수 관측소 v3.1] 일간 데이터 갱신 완료"]
    for key, label in [("KOSPI", "코스피"), ("KOSDAQ", "코스닥"), ("NASDAQ", "나스닥")]:
        rows = payload.get(key) or []
        if rows:
            last = rows[-1]
            sign = "+" if last[2] > 0 else ""
            msg_lines.append(f"- {label} ({last[0]}): {last[1]:,.2f} ({sign}{last[2]:.2f}%)")
    text = "\n".join(msg_lines)

    try:
        import requests
    except Exception:
        return

    tg_token = os.getenv("TELEGRAM_BOT_TOKEN")
    tg_chat = os.getenv("TELEGRAM_CHAT_ID")
    if tg_token and tg_chat:
        requests.post(
            f"https://api.telegram.org/bot{tg_token}/sendMessage",
            json={"chat_id": tg_chat, "text": text},
            timeout=10,
        )

    discord_url = os.getenv("DISCORD_WEBHOOK_URL")
    if discord_url:
        requests.post(discord_url, json={"content": text}, timeout=10)


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
    }

    temp = data_path.with_suffix(".tmp")
    with temp.open("w", encoding="utf-8") as f:
        f.write("const markets = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n")
    temp.replace(data_path)

    print(
        f"Updated data.js -> KOSPI:{len(payload['KOSPI'])}, KOSDAQ:{len(payload['KOSDAQ'])}, "
        f"NASDAQ:{len(payload['NASDAQ'])}, VIX:{len(payload['VIX'])}"
    )
    send_notification(payload)


if __name__ == "__main__":
    main()

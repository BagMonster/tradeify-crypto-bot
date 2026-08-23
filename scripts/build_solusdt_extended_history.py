#!/usr/bin/env python3
import csv
import hashlib
import io
import os
import sys
import time
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

SYMBOL = "SOLUSDT"
INTERVAL = "5m"
START_ISO = "2024-02-22T00:00:00Z"
END_EXCLUSIVE_ISO = "2025-08-22T00:00:00Z"
OUTPUT = Path("research-data/SOLUSDT_5m_2024-02-22_to_2025-08-21.csv")
SOURCE = "binance-spot"
EXPECTED_HEADER = ["timestamp_utc", "open", "high", "low", "close", "volume", "symbol", "source"]
FIVE_MINUTES_MS = 5 * 60 * 1000


def iso_to_ms(value: str) -> int:
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def archive_timestamp_to_ms(raw: str) -> int:
    value = int(raw)
    # Binance spot archives use milliseconds historically and microseconds for
    # newer files. Normalize both to milliseconds without changing OHLCV text.
    if value >= 10**15:
        return value // 1000
    return value


def ms_to_iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def months_between(start_ms: int, end_exclusive_ms: int):
    start = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc)
    end = datetime.fromtimestamp((end_exclusive_ms - 1) / 1000, tz=timezone.utc)
    year, month = start.year, start.month
    while (year, month) <= (end.year, end.month):
        yield year, month
        month += 1
        if month == 13:
            month = 1
            year += 1


def download(url: str, attempts: int = 4) -> bytes:
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "tradeify-crypto-bot-research/1.0"})
            with urllib.request.urlopen(request, timeout=90) as response:
                return response.read()
        except Exception as exc:
            last_error = exc
            if attempt == attempts:
                break
            time.sleep(attempt * 2)
    raise RuntimeError(f"Could not download {url}: {last_error}")


def validate_price_row(row, timestamp_ms):
    if len(row) < 6:
        raise ValueError(f"Malformed Binance row at {ms_to_iso(timestamp_ms)}")
    open_, high, low, close, volume = map(float, row[1:6])
    if min(open_, high, low, close) <= 0:
        raise ValueError(f"Non-positive OHLC at {ms_to_iso(timestamp_ms)}")
    if high < max(open_, low, close):
        raise ValueError(f"Invalid high at {ms_to_iso(timestamp_ms)}")
    if low > min(open_, high, close):
        raise ValueError(f"Invalid low at {ms_to_iso(timestamp_ms)}")
    if volume < 0:
        raise ValueError(f"Negative volume at {ms_to_iso(timestamp_ms)}")


def main():
    start_ms = iso_to_ms(START_ISO)
    end_exclusive_ms = iso_to_ms(END_EXCLUSIVE_ISO)
    expected_rows = (end_exclusive_ms - start_ms) // FIVE_MINUTES_MS
    if expected_rows <= 0:
        raise RuntimeError("Invalid requested date range")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temp_output = OUTPUT.with_suffix(OUTPUT.suffix + ".tmp")
    seen = set()
    count = 0
    previous_ms = None

    with temp_output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\r\n")
        writer.writerow(EXPECTED_HEADER)

        for year, month in months_between(start_ms, end_exclusive_ms):
            month_name = f"{year:04d}-{month:02d}"
            archive_name = f"{SYMBOL}-{INTERVAL}-{month_name}.zip"
            url = f"https://data.binance.vision/data/spot/monthly/klines/{SYMBOL}/{INTERVAL}/{archive_name}"
            print(f"Downloading {archive_name}", flush=True)
            payload = download(url)

            with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                csv_names = [name for name in archive.namelist() if name.lower().endswith(".csv")]
                if len(csv_names) != 1:
                    raise RuntimeError(f"Expected one CSV in {archive_name}, found {len(csv_names)}")
                with archive.open(csv_names[0], "r") as raw_file:
                    text_file = io.TextIOWrapper(raw_file, encoding="utf-8", newline="")
                    reader = csv.reader(text_file)
                    for row in reader:
                        if not row:
                            continue
                        if not row[0].strip().isdigit():
                            continue
                        timestamp_ms = archive_timestamp_to_ms(row[0].strip())
                        if timestamp_ms < start_ms or timestamp_ms >= end_exclusive_ms:
                            continue
                        if timestamp_ms % FIVE_MINUTES_MS != 0:
                            raise ValueError(f"Misaligned 5m candle at {ms_to_iso(timestamp_ms)}")
                        if timestamp_ms in seen:
                            raise ValueError(f"Duplicate 5m candle at {ms_to_iso(timestamp_ms)}")
                        if previous_ms is not None and timestamp_ms != previous_ms + FIVE_MINUTES_MS:
                            raise ValueError(
                                f"Missing or out-of-order candle between {ms_to_iso(previous_ms)} and {ms_to_iso(timestamp_ms)}"
                            )
                        validate_price_row(row, timestamp_ms)
                        seen.add(timestamp_ms)
                        previous_ms = timestamp_ms
                        writer.writerow([
                            ms_to_iso(timestamp_ms),
                            row[1], row[2], row[3], row[4], row[5],
                            SYMBOL,
                            SOURCE,
                        ])
                        count += 1

    if count != expected_rows:
        temp_output.unlink(missing_ok=True)
        raise RuntimeError(f"Expected {expected_rows} candles but wrote {count}")
    if previous_ms != end_exclusive_ms - FIVE_MINUTES_MS:
        temp_output.unlink(missing_ok=True)
        raise RuntimeError("Final candle does not end at the requested boundary")

    temp_output.replace(OUTPUT)
    digest = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
    sha_path = OUTPUT.with_suffix(OUTPUT.suffix + ".sha256")
    sha_path.write_text(f"{digest}  {OUTPUT.name}\n", encoding="utf-8")

    print(f"Created: {OUTPUT}")
    print(f"Candles: {count}")
    print(f"First: {ms_to_iso(start_ms)}")
    print(f"Last: {ms_to_iso(end_exclusive_ms - FIVE_MINUTES_MS)}")
    print(f"SHA-256: {digest}")


if __name__ == "__main__":
    main()

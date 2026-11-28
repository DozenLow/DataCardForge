#!/usr/bin/env python3
"""Rebuild the two small public-data examples from fixed upstream records.

Run from any directory with:

    python3 example/build_examples.py

Upstream downloads are cached under work/example-upstream, which is gitignored.
The script verifies the full upstream bytes before creating derived CSV samples.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "example"
CACHE = ROOT / "work" / "example-upstream"

BEARING_URL = (
    "https://data.mendeley.com/public-files/datasets/3fcrrdjjvk/files/"
    "46c4cf85-ba7d-47ec-a817-25ed6036df69/file_downloaded"
)
BEARING_ARCHIVE_SHA256 = (
    "70f5cbc7bbfd9ada244b91d92f50ecb2c12ca8eaf92a8e090be9d5ed98b30cca"
)
BEARING_ARCHIVE = CACHE / "engine-journal-bearings-2.zip"
BEARING_PREFIX = "Engine Journal Bearings Dataset 2/Engine Journal Bearings Dataset/"
BEARING_FILES = {
    "healthy": BEARING_PREFIX
    + "Healthy Bearings Dataset/1000 RPM/50% Humidity/15 deg Celsius/"
    + "3rd at 15c 2022May27-0338-0046.csv",
    "faulty": BEARING_PREFIX
    + "Faulty Bearings Dataset/1000 RPM/50% Humidity/15 deg Celsius/"
    + "3rd at 15c 2022May26-2336-0024.csv",
}
BEARING_SAMPLE_ROWS = 256

WEATHER_URL = (
    "https://www.ncei.noaa.gov/access/services/data/v1"
    "?dataset=local-climatological-data-v2"
    "&stations=USW00014739&startDate=2024-07-01&endDate=2024-07-07&format=csv"
)
WEATHER_RAW_SHA256 = (
    "38aee5de8ce165ddea7bd8f87c8b0086fd07832f1b44e7a6b06e3d8f1713dc84"
)
WEATHER_RAW = CACHE / "noaa-lcdv2-usw00014739-20240701-20240707.csv"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download_if_needed(url: str, path: Path, expected_sha256: str) -> None:
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(
            url, headers={"User-Agent": "DataCardForge example builder/1.0"}
        )
        with urllib.request.urlopen(request, timeout=120) as response:
            path.write_bytes(response.read())
    actual = sha256(path)
    if actual != expected_sha256:
        raise RuntimeError(
            f"Upstream hash mismatch for {path.name}: expected {expected_sha256}, got {actual}"
        )


def build_bearing() -> tuple[Path, dict[str, object]]:
    output = OUT / "industrial-engine-bearing.csv"
    with zipfile.ZipFile(BEARING_ARCHIVE) as archive:
        rows: list[list[str]] = []
        selected_rows: dict[str, int] = {}
        for state, member in BEARING_FILES.items():
            selected = 0
            with archive.open(member) as raw:
                reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
                for row in reader:
                    rows.append([row["Time"], row["Channel 3"], state])
                    selected += 1
                    if selected == BEARING_SAMPLE_ROWS:
                        break
            selected_rows[state] = selected
    with output.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["time_s", "bearing_housing_vibration_g", "bearing_state"])
        writer.writerows(rows)
    return output, {
        "rows": len(rows),
        "rows_per_state": BEARING_SAMPLE_ROWS,
        "source_rows_selected": selected_rows,
        "source_member": BEARING_FILES,
        "transformation": (
            "The first 256 records from each same-condition source file were retained; "
            "columns Time and Channel 3 were renamed, and bearing_state was added."
        ),
    }


def build_weather() -> tuple[Path, dict[str, object]]:
    output = OUT / "research-weather-boston-2024-07.csv"
    with WEATHER_RAW.open(encoding="utf-8-sig", newline="") as handle:
        records = [
            row for row in csv.DictReader(handle) if row["REPORT_TYPE"] == "FM-15"
        ]
    first = datetime.fromisoformat(records[0]["DATE"])
    rows = []
    for row in records:
        elapsed = (datetime.fromisoformat(row["DATE"]) - first).total_seconds() / 3600
        rows.append(
            [
                row["DATE"],
                f"{elapsed:g}",
                row["HourlyDryBulbTemperature"],
                row["HourlyRelativeHumidity"],
                row["HourlyWindSpeed"],
                row["HourlyStationPressure"],
            ]
        )
    with output.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(
            [
                "observed_at_LST",
                "elapsed_h",
                "temperature_C",
                "relative_humidity_percent",
                "wind_speed_m_s",
                "station_pressure_hPa",
            ]
        )
        writer.writerows(rows)
    return output, {
        "rows": len(rows),
        "report_type": "FM-15",
        "station": "USW00014739",
        "transformation": (
            "FM-15 hourly reports in the seven-day response were selected; six fields "
            "were retained and elapsed_h was added relative to the first observation."
        ),
    }


def main() -> None:
    download_if_needed(BEARING_URL, BEARING_ARCHIVE, BEARING_ARCHIVE_SHA256)
    download_if_needed(WEATHER_URL, WEATHER_RAW, WEATHER_RAW_SHA256)
    OUT.mkdir(parents=True, exist_ok=True)
    bearing_path, bearing = build_bearing()
    weather_path, weather = build_weather()
    manifest = {
        "generated_by": "python3 example/build_examples.py",
        "industrial": {
            "file": bearing_path.name,
            "source_title": (
                "Vibration dataset of main journal bearings in internal combustion engines "
                "under diverse climatic and varying operating conditions"
            ),
            "source_url": "https://doi.org/10.17632/3fcrrdjjvk.5",
            "data_article": "https://doi.org/10.1016/j.dib.2024.111214",
            "authors": [
                "Muhammad Noman Riaz",
                "Amir Hamza",
                "Hamid Jabbar",
                "Manzar Abbas",
                "Mohsin Islam Tiwana",
            ],
            "access_date": "2026-11-28",
            "archive_url": BEARING_URL,
            "archive_sha256": BEARING_ARCHIVE_SHA256,
            "derived_sha256": sha256(bearing_path),
            "license": "CC BY 4.0",
            **bearing,
        },
        "research": {
            "file": weather_path.name,
            "source_title": "Local Climatological Data (LCD), Version 2 (LCDv2)",
            "source_url": "https://doi.org/10.25921/96dw-mb77",
            "query_url": WEATHER_URL,
            "documentation_url": (
                "https://www.ncei.noaa.gov/products/land-based-station/"
                "local-climatological-data"
            ),
            "open_data_policy_url": (
                "https://www.ncei.noaa.gov/sites/g/files/anmtlf171/files/2023-12/"
                "NCEI%20PD-10-2-02%20-%20Open%20Data%20Policy%20Signed.pdf"
            ),
            "access_date": "2026-11-28",
            "source_sha256": WEATHER_RAW_SHA256,
            "derived_sha256": sha256(weather_path),
            "attribution": (
                "Kantor, Diana; Casey, Nancy W.; Menne, Matthew J.; Buddenberg, Andrew. "
                "2023. NOAA National Centers for Environmental Information."
            ),
            **weather,
        },
    }
    (OUT / "MANIFEST.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"Wrote {bearing_path.relative_to(ROOT)} ({bearing['rows']} rows)")
    print(f"Wrote {weather_path.relative_to(ROOT)} ({weather['rows']} rows)")
    print("Wrote example/MANIFEST.json")


if __name__ == "__main__":
    main()

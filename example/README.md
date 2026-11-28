# Public-data examples / 公开数据示例

These are small, real subsets for trying DataCardForge. They are not synthetic files and are
not intended to replace the complete datasets. The machine-readable record is
[`MANIFEST.json`](MANIFEST.json); [`build_examples.py`](build_examples.py) verifies upstream
file hashes before rebuilding the two CSV files.

## 1. Industrial — engine-bearing vibration / 工业轴承振动

File: [`industrial-engine-bearing.csv`](industrial-engine-bearing.csv)

- **Source record:** Riaz, M. N.; Hamza, A.; Jabbar, H.; Abbas, M.; Tiwana, M. I. (2024),
  *Vibration dataset of main journal bearings in internal combustion engines under diverse
  climatic and varying operating conditions*, Mendeley Data, v5.
- **Dataset DOI:** <https://doi.org/10.17632/3fcrrdjjvk.5>
- **Data article:** Riaz et al. (2025), *Data in Brief* 58, 111214,
  <https://doi.org/10.1016/j.dib.2024.111214>.
- **License:** [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/),
as stated by the source record. Attribution must be retained; the link does not imply that the
creators endorse DataCardForge.

This demo keeps the first 256 records from a healthy-bearing file and the first 256 from a
faulty-bearing file, both collected at **1000 RPM, 50% humidity and 15 °C**. It keeps source
columns `Time` and `Channel 3`, renames them `time_s` and
`bearing_housing_vibration_g`, and adds `bearing_state`. According to the source data article,
Channel 3 is the bearing-housing vibration channel and the displayed vibration unit is g; the
article reports a 3.2 kHz test frequency. The exported sample values and timestamps are kept
unchanged; the excerpt is not resampled or averaged.

Use it as a line plot with `time_s` on X and `bearing_housing_vibration_g` on Y, then map
`bearing_state` as a group or facet. These short excerpts demonstrate a workflow; they are
not large enough for a safety, condition-monitoring, or diagnostic conclusion.

The subset is a derivative work. The source was filtered to 512 rows, selected columns were
renamed, and a two-level state label was added. All changes are explicit in `MANIFEST.json`.

## 2. Research — surface weather observations / 科研气象观测

File: [`research-weather-boston-2024-07.csv`](research-weather-boston-2024-07.csv)

- **Source product:** Kantor, D.; Casey, N. W.; Menne, M. J.; Buddenberg, A. (2023),
  *Local Climatological Data (LCD), Version 2 (LCDv2)*, NOAA National Centers for
  Environmental Information.
- **Dataset DOI:** <https://doi.org/10.25921/96dw-mb77>
- **Official product page:** <https://www.ncei.noaa.gov/products/land-based-station/local-climatological-data>
- **Official NCEI request:** LCDv2 station `USW00014739` (MWRA Deer Island Treatment Plant,
  Boston area), 2024-07-01 through 2024-07-07, CSV.
- **Rights / use:** NOAA/NCEI's [Open Data Policy](https://www.ncei.noaa.gov/sites/g/files/anmtlf171/files/2023-12/NCEI%20PD-10-2-02%20-%20Open%20Data%20Policy%20Signed.pdf)
  describes NOAA federal environmental data as openly available and, absent an identified
  exception, in the public domain. The product metadata requires the attribution above and
  disclaims warranty for accuracy, fitness, completeness, or application results.

The file selects the 168 `FM-15` hourly reports from the seven-day response. It retains dry-bulb
temperature (°C), relative humidity (%), wind speed (m/s), and station pressure (hPa), and
adds `elapsed_h` so the data can be plotted without parsing a timestamp. NOAA provides LCDv2 CSV
files in SI/metric units; timestamps are Local Standard Time (LST), with no daylight-saving-time
shift. Missing values in the selected fields, if later present, remain blank rather than being
invented.

Try a line plot of `elapsed_h` versus `temperature_C`, or a scatter plot of `temperature_C`
versus `relative_humidity_percent`. The sample is observational data, not quality-controlled
research inferences.

## Rebuild / 复现

```bash
python3 example/build_examples.py
```

The builder downloads the 12 MB industrial archive and the official NOAA CSV query only when
its cache is absent, checks their SHA-256 values, writes the two CSV files, and regenerates the
manifest. It records the full source hashes and every row-selection or column operation. Full
upstream downloads stay in the ignored `work/example-upstream/` cache and are not committed.

## Important boundary / 使用边界

These excerpts are provided for software demonstrations and education. They are not complete
benchmark sets and must not be used to certify hardware, diagnose a real bearing, produce an
official weather product, or make a safety/engineering decision. Consult the complete source
records and their documentation for scientific reuse.

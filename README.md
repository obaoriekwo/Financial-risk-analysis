# GS Portfolio Risk Desk — Monte Carlo VaR / CVaR

An interactive portfolio risk dashboard built on a from-scratch Monte
Carlo simulation engine — quantifying downside risk (VaR, CVaR, drawdown,
Sharpe/Sortino) for a Goldman Sachs (GS) equity position, with a
Power BI-ready export pipeline for automated reporting.

**Live dashboard:** `index.html` (single self-contained file)
**Simulation engine:** `risk_engine.py` / `run_simulation.py`

---

## The Problem

A risk desk holding an equity position needs to answer a hard question
in concrete numbers: *"How much could we realistically lose over the
next day, week, month, or quarter — and how bad does it get in the
tail?"*

Simple historical stats (average return, standard deviation) don't
capture this well on their own. You need a forward-looking distribution
of outcomes that accounts for the asset's actual volatility and
autocorrelation structure, at multiple time horizons, with defensible
risk metrics that map to how risk desks actually report exposure —
Value at Risk (VaR), Conditional VaR / Expected Shortfall (CVaR),
volatility-adjusted returns, and drawdown risk.

This project builds that pipeline end-to-end: real price data in,
calibrated Monte Carlo simulation, executive-ready risk metrics and
visuals out — with a path to automated, scheduled Power BI reporting.

## The Data

Ten years of daily OHLCV price history for Goldman Sachs (GS), cross-
verified across four independent sources to catch data-vendor
discrepancies before they propagate into the model:

| File | Source |
|---|---|
| `gs_yahoo_finance.csv` | Yahoo Finance |
| `gs_investing_com.csv` | Investing.com |
| `gs_marketwatch.csv` | MarketWatch |
| `gs_nasdaq.csv` | Nasdaq |
| `gs_master_dataset.csv` | Reconciled master series used by the engine |
| `gs_barchart.csv` | Barchart (supplementary cross-check) |

The engine consumes `gs_master_dataset.csv` and derives daily log
returns, volatility, and the return distribution directly from it — no
numbers in the dashboard are hardcoded or illustrative.

## The Approach

**1. Calibration.** Daily log returns are computed from 10 years of
close prices. Drift (mean return) and volatility (standard deviation)
are estimated directly from this history, along with the full return
covariance structure — built to scale to a multi-asset portfolio, not
just a single position (see [Design Notes](#design-notes) below).

**2. Simulation.** A correlated Geometric Brownian Motion (GBM) Monte
Carlo simulation projects **20,000 possible future paths** per horizon
(1 day, 1 week, 1 month, 1 quarter), using Cholesky decomposition of the
covariance matrix to preserve realistic joint behavior across assets.
Each path tracks simulated portfolio value day-by-day over the horizon.

**3. Risk metrics.** From the simulated terminal outcomes, the engine
computes:
- **Monte Carlo VaR & CVaR** at 95% and 99% confidence — the empirical
  loss quantile and the average loss beyond it
- **Parametric (Gaussian) VaR & CVaR** as a closed-form cross-check
  against the simulation
- **Sharpe & Sortino ratios** (4% annual risk-free rate)
- **Maximum drawdown**, sampled across simulated paths rather than just
  historical data, plus skew and kurtosis of the return distribution

**4. Historical calibration view.** Alongside the forward-looking
simulation, the dashboard shows the actual inputs that feed it: 10-year
daily close price, rolling 30-day annualized volatility, rolling
250-day historical 95% VaR, and running drawdown from peak — so the
simulation's assumptions are visible and auditable, not a black box.

## The Dashboard

A single-file interactive HTML dashboard (`index.html`), built with
Chart.js and hand-rolled SVG, covering:

- **Simulated fan chart** — 250 sampled Monte Carlo paths plotted
  against the median outcome and the 95% VaR / 99% CVaR thresholds,
  switchable across all four horizons
- **Headline risk metrics** — VaR, CVaR, Sharpe, Sortino, and prob-of-loss
  at a glance for the selected horizon
- **Price, volatility & drawdown** — the historical calibration inputs
  described above
- **Return distribution & risk table** — daily log-return histogram vs.
  the fitted Gaussian, plus the full VaR/CVaR table across every
  horizon and confidence level, Monte Carlo vs. parametric side by side
- **Integration & automation** — how this engine is designed to run
  headless and feed a live Power BI report (see below)

## Power BI & Automation Pipeline

The engine is built to run unattended and refresh a live report, not
just produce a one-off notebook output:

- **Flat fact tables** — every run exports `powerbi_risk_metrics.csv`,
  `powerbi_price_history.csv`, and `powerbi_simulated_paths.csv`,
  structured as star-schema-ready tables for direct Power BI import or
  a Dataflow (sample exports included in this repo)
- **Scheduled refresh** — `risk_engine.py` is designed to run inside an
  Azure Function on a daily timer, dropping fresh CSVs into Blob
  Storage for Power BI to pick up automatically
- **Threshold alerting** — a Logic App can compare each new 95% VaR
  against the prior run and trigger an automated Power BI email report
  to risk officers when a breach exceeds a configurable tolerance

## Design Notes

The dataset here holds a single GS position, so this build demonstrates
a single-asset portfolio — but **the engine itself is multi-asset by
design**. `risk_engine.py`'s `build_portfolio_stats()` and
`run_monte_carlo()` take a list of arbitrarily many weighted holdings
and derive the correlation matrix and Cholesky-factorized joint
simulation automatically. Adding more tickers to the portfolio requires
no structural changes to the engine — only more `Holding` entries.

## Tech Stack

- **Simulation & analysis:** Python — NumPy, SciPy, Pandas
- **Dashboard:** vanilla HTML/CSS/JS, [Chart.js](https://www.chartjs.org/)
  for line/bar/histogram charts, hand-rolled SVG for the Monte Carlo fan
  chart — no build step, no framework
- **Reporting:** Power BI, with an Azure Functions + Blob Storage +
  Logic Apps pipeline for scheduled, automated refresh

## Repository Contents

| File | Purpose |
|---|---|
| `index.html` | The full interactive dashboard (self-contained) |
| `risk_engine.py` | Core engine — data loading, portfolio stats, Monte Carlo simulation, risk metrics |
| `run_simulation.py` | Driver script — runs the full pipeline and exports dashboard JSON + Power BI CSVs |
| `gs_master_dataset.csv` | Reconciled 10-year daily OHLCV price history used by the engine |
| `gs_yahoo_finance.csv`, `gs_investing_com.csv`, `gs_marketwatch.csv`, `gs_nasdaq.csv`, `gs_barchart.csv` | Source price data cross-checked to build the master dataset |
| `powerbi_risk_metrics.csv`, `powerbi_price_history.csv`, `powerbi_simulated_paths.csv` | Sample Power BI-ready exports from `run_simulation.py` |

## Running It

- **Dashboard:** open `index.html` directly in a browser, or deploy it
  as a static site (e.g. Render, GitHub Pages, Netlify) — no build
  command needed.
- **Simulation pipeline:** run `python run_simulation.py` with
  `gs_master_dataset.csv` on the expected relative path — it prints a
  summary of the calibration window and VaR/CVaR per horizon, then
  writes `dashboard_data.json` and the three Power BI CSVs to an
  `outputs/` folder.

  Author: Oba Oriekwo

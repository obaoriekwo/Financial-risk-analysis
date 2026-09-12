"""
Driver script — runs the full risk-assessment pipeline on the Goldman
Sachs (GS) dataset and exports:

  outputs/dashboard_data.json   -> consumed by the interactive HTML dashboard
  outputs/powerbi_risk_metrics.csv     -> flat fact table for Power BI
  outputs/powerbi_price_history.csv    -> daily price / return history for Power BI
  outputs/powerbi_simulated_paths.csv  -> sampled MC paths for Power BI fan chart
"""
import sys, json
sys.path.insert(0, "engine")
import numpy as np
import pandas as pd
from risk_engine import (
    load_price_series, log_returns, Holding, build_portfolio_stats,
    run_monte_carlo, compute_full_report, max_drawdown, TRADING_DAYS
)

DATA = "data/gs_master_dataset.csv"
OUT = "outputs"
import os
os.makedirs(OUT, exist_ok=True)

INITIAL_VALUE = 5_000_000.0   # illustrative $5M single-name position
N_SIMS = 20000
HORIZONS = [1, 5, 21, 63]      # 1 day, 1 week, 1 month, 1 quarter
PRIMARY_HORIZON = 21
LOOKBACK_YEARS = 10

# ---------------------------------------------------------------- load
prices = load_price_series(DATA, "GS")
lookback_days = LOOKBACK_YEARS * TRADING_DAYS
holding = Holding(ticker="GS", weight=1.0, prices=prices)
stats_, ret_df = build_portfolio_stats([holding], lookback_days=lookback_days)

print(f"History window: {ret_df.index.min().date()} -> {ret_df.index.max().date()} "
      f"({len(ret_df)} trading days)")
print(f"Daily mean return: {stats_.port_mu_daily:.5f}  Daily vol: {stats_.port_sigma_daily:.5f}")

# ---------------------------------------------------------------- MC per horizon
horizon_reports = {}
sample_paths_primary = None
for h in HORIZONS:
    mc = run_monte_carlo(stats_, n_sims=N_SIMS, horizon_days=h, initial_value=INITIAL_VALUE, seed=42)
    report = compute_full_report(stats_, ret_df, mc, confidences=(0.95, 0.99))
    horizon_reports[h] = report
    if h == PRIMARY_HORIZON:
        # keep a manageable sample of simulated paths for the fan chart
        idx = np.random.default_rng(7).choice(N_SIMS, size=250, replace=False)
        sample_paths_primary = mc["port_paths_full"][idx]
        terminal_dist = mc["terminal_values"]
    print(f"Horizon {h}d -> 95% VaR: ${report['risk_table'][0]['mc_var']:,.0f} "
          f"CVaR: ${report['risk_table'][0]['mc_cvar']:,.0f}")

# ---------------------------------------------------------------- historical rolling series (for charts)
close = prices["Close"].iloc[-lookback_days:]
daily_ret = log_returns(close)
roll_vol_30 = daily_ret.rolling(30).std() * np.sqrt(TRADING_DAYS)
roll_var95 = daily_ret.rolling(250).apply(lambda x: -np.quantile(x, 0.05), raw=True)
cum_price = close
running_max = cum_price.cummax()
drawdown_series = (cum_price - running_max) / running_max

hist_df = pd.DataFrame({
    "date": close.index,
    "close": close.values,
    "daily_return": daily_ret.reindex(close.index).values,
    "rolling_vol_30d_annualized": roll_vol_30.reindex(close.index).values,
    "rolling_var95_250d": roll_var95.reindex(close.index).values,
    "drawdown": drawdown_series.values,
}).dropna(subset=["daily_return"])

# Downsample for a lighter JSON payload (keep last 8y daily + monthly before that)
hist_df["date"] = pd.to_datetime(hist_df["date"])
recent_cut = hist_df["date"].max() - pd.Timedelta(days=8 * 365)
recent = hist_df[hist_df["date"] >= recent_cut]
older = hist_df[hist_df["date"] < recent_cut].set_index("date").resample("W").last().dropna().reset_index()
hist_light = pd.concat([older, recent]).sort_values("date")

# ---------------------------------------------------------------- assemble dashboard JSON
def fmt_paths(arr):
    # arr: (n_paths, n_days+1) -> list of lists, rounded
    return [[round(float(v), 2) for v in row] for row in arr]

dashboard_payload = {
    "generated_for": "Goldman Sachs (GS) — Single-Position Portfolio",
    "data_window": {
        "start": str(ret_df.index.min().date()),
        "end": str(ret_df.index.max().date()),
        "trading_days": int(len(ret_df)),
    },
    "position": {
        "ticker": "GS",
        "last_price": float(stats_.last_prices[0]),
        "initial_value": INITIAL_VALUE,
        "shares": float(INITIAL_VALUE / stats_.last_prices[0]),
    },
    "horizons": {str(h): horizon_reports[h] for h in HORIZONS},
    "primary_horizon": PRIMARY_HORIZON,
    "price_history": {
        "dates": hist_light["date"].dt.strftime("%Y-%m-%d").tolist(),
        "close": [round(float(v), 2) for v in hist_light["close"]],
        "drawdown": [round(float(v), 4) for v in hist_light["drawdown"]],
        "rolling_vol_30d": [None if pd.isna(v) else round(float(v), 4) for v in hist_light["rolling_vol_30d_annualized"]],
        "rolling_var95": [None if pd.isna(v) else round(float(v), 4) for v in hist_light["rolling_var95_250d"]],
    },
    "simulated_paths_sample": fmt_paths(sample_paths_primary),
    "terminal_distribution_sample": [round(float(v), 2) for v in
                                      np.random.default_rng(11).choice(terminal_dist, size=4000, replace=False)],
    "return_histogram": {
        "daily_returns_sample": [round(float(v), 5) for v in daily_ret.dropna().values[-1500:]],
    },
}

with open(f"{OUT}/dashboard_data.json", "w") as f:
    json.dump(dashboard_payload, f)
print(f"\nWrote {OUT}/dashboard_data.json ({os.path.getsize(f'{OUT}/dashboard_data.json')/1024:.0f} KB)")

# ---------------------------------------------------------------- Power BI exports
# 1) risk metrics fact table (one row per horizon x confidence)
rows = []
for h in HORIZONS:
    rep = horizon_reports[h]
    for rt in rep["risk_table"]:
        rows.append({
            "Ticker": "GS",
            "HorizonDays": h,
            "Confidence": rt["confidence"],
            "MonteCarloVaR": rt["mc_var"],
            "MonteCarloCVaR": rt["mc_cvar"],
            "MonteCarloVaRPct": rt["mc_var_pct"],
            "MonteCarloCVaRPct": rt["mc_cvar_pct"],
            "ParametricVaR": rt["parametric_var"],
            "ParametricCVaR": rt["parametric_cvar"],
            "AnnualizedReturn": rep["distribution"]["annualized_return"],
            "AnnualizedVolatility": rep["distribution"]["annualized_volatility"],
            "SharpeRatio": rep["distribution"]["sharpe_ratio"],
            "SortinoRatio": rep["distribution"]["sortino_ratio"],
            "Skew": rep["distribution"]["skew"],
            "Kurtosis": rep["distribution"]["kurtosis"],
            "ProbOfLoss": rep["simulation_summary"]["prob_of_loss"],
            "MedianTerminalValue": rep["simulation_summary"]["median_terminal_value"],
            "P5TerminalValue": rep["simulation_summary"]["p5_terminal_value"],
            "P95TerminalValue": rep["simulation_summary"]["p95_terminal_value"],
            "WorstSimulatedDrawdown": rep["drawdown"]["worst"],
        })
pd.DataFrame(rows).to_csv(f"{OUT}/powerbi_risk_metrics.csv", index=False)

# 2) price / return history
hist_df.rename(columns={
    "date": "Date", "close": "Close", "daily_return": "DailyLogReturn",
    "rolling_vol_30d_annualized": "RollingVol30dAnnualized",
    "rolling_var95_250d": "RollingVaR95_250d", "drawdown": "Drawdown",
}).to_csv(f"{OUT}/powerbi_price_history.csv", index=False)

# 3) sampled simulated paths (long format: SimId, Day, Value)
sample_idx = np.random.default_rng(3).choice(N_SIMS, size=100, replace=False)
mc_primary = run_monte_carlo(stats_, n_sims=N_SIMS, horizon_days=PRIMARY_HORIZON, initial_value=INITIAL_VALUE, seed=42)
paths = mc_primary["port_paths_full"][sample_idx]
long_rows = []
for sim_id, row in enumerate(paths):
    for day, val in enumerate(row):
        long_rows.append({"SimId": sim_id, "Day": day, "PortfolioValue": round(float(val), 2)})
pd.DataFrame(long_rows).to_csv(f"{OUT}/powerbi_simulated_paths.csv", index=False)

print("Wrote powerbi_risk_metrics.csv, powerbi_price_history.csv, powerbi_simulated_paths.csv")
print("\nDone.")
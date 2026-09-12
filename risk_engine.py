"""
Monte Carlo Portfolio Risk Engine
==================================
A general-purpose (multi-asset-ready) risk engine that:
  1. Loads historical OHLCV price series for one or more holdings
  2. Estimates drift / volatility / correlation from log returns
  3. Runs a correlated Geometric Brownian Motion Monte Carlo simulation
  4. Derives VaR, CVaR (Expected Shortfall), volatility, Sharpe, Sortino,
     max drawdown, and other executive risk metrics
  5. Exports a clean JSON payload for the dashboard and a flat CSV table
     shaped for Power BI import.

Although the attached dataset contains a single position (Goldman Sachs,
GS), the engine is written for an arbitrary number of weighted holdings —
add more (ticker -> DataFrame) entries to `price_frames` and the
correlation / Cholesky machinery below scales automatically.

Author: Generated for portfolio risk assessment project
"""

from __future__ import annotations
import json
import numpy as np
import pandas as pd
from scipy import stats
from dataclasses import dataclass, field
from pathlib import Path


TRADING_DAYS = 252


# ----------------------------------------------------------------------
# Data loading
# ----------------------------------------------------------------------

def load_price_series(csv_path: str, ticker: str) -> pd.DataFrame:
    """Load a single-ticker OHLCV CSV (Yahoo/Barchart/Investing.com schema)
    into a clean daily-indexed DataFrame with a `Close` column."""
    df = pd.read_csv(csv_path)
    df["Date"] = pd.to_datetime(df["Date"], utc=True).dt.tz_localize(None)
    df = df.sort_values("Date").drop_duplicates(subset="Date")
    df = df.set_index("Date")[["Open", "High", "Low", "Close", "Volume"]]
    df["ticker"] = ticker
    return df


def log_returns(close: pd.Series) -> pd.Series:
    return np.log(close / close.shift(1)).dropna()


# ----------------------------------------------------------------------
# Portfolio construction
# ----------------------------------------------------------------------

@dataclass
class Holding:
    ticker: str
    weight: float
    prices: pd.DataFrame  # must contain 'Close'


@dataclass
class PortfolioStats:
    tickers: list
    weights: np.ndarray
    mu_daily: np.ndarray          # per-asset mean daily log return
    sigma_daily: np.ndarray       # per-asset daily volatility
    corr: np.ndarray              # correlation matrix
    cov_daily: np.ndarray         # daily covariance matrix
    port_mu_daily: float
    port_sigma_daily: float
    last_prices: np.ndarray


def build_portfolio_stats(holdings: list[Holding], lookback_days: int | None = None) -> PortfolioStats:
    tickers = [h.ticker for h in holdings]
    weights = np.array([h.weight for h in holdings], dtype=float)
    weights = weights / weights.sum()

    rets = {}
    lasts = {}
    for h in holdings:
        close = h.prices["Close"]
        if lookback_days:
            close = close.iloc[-lookback_days:]
        r = log_returns(close)
        rets[h.ticker] = r
        lasts[h.ticker] = close.iloc[-1]

    ret_df = pd.DataFrame(rets).dropna()
    mu_daily = ret_df.mean().values
    sigma_daily = ret_df.std(ddof=1).values
    corr = ret_df.corr().values
    cov_daily = ret_df.cov().values

    port_mu_daily = float(weights @ mu_daily)
    port_sigma_daily = float(np.sqrt(weights @ cov_daily @ weights.T))

    return PortfolioStats(
        tickers=tickers,
        weights=weights,
        mu_daily=mu_daily,
        sigma_daily=sigma_daily,
        corr=corr,
        cov_daily=cov_daily,
        port_mu_daily=port_mu_daily,
        port_sigma_daily=port_sigma_daily,
        last_prices=np.array([lasts[t] for t in tickers]),
    ), ret_df


# ----------------------------------------------------------------------
# Monte Carlo simulation (correlated GBM via Cholesky decomposition)
# ----------------------------------------------------------------------

def run_monte_carlo(
    stats_: PortfolioStats,
    n_sims: int = 20000,
    horizon_days: int = 21,
    initial_value: float = 1_000_000.0,
    seed: int = 42,
) -> dict:
    rng = np.random.default_rng(seed)
    n_assets = len(stats_.tickers)

    # Cholesky of covariance matrix (adds tiny jitter for numerical stability)
    cov = stats_.cov_daily + np.eye(n_assets) * 1e-12
    L = np.linalg.cholesky(cov)

    # shares held per asset given weights & initial value
    dollar_alloc = stats_.weights * initial_value
    shares = dollar_alloc / stats_.last_prices

    # simulate correlated daily log returns: (n_sims, horizon_days, n_assets)
    z = rng.standard_normal((n_sims, horizon_days, n_assets))
    correlated = z @ L.T
    daily_log_rets = stats_.mu_daily + correlated  # broadcast mean per asset

    # cumulative price paths per asset
    cum_log = np.cumsum(daily_log_rets, axis=1)
    price_paths = stats_.last_prices[None, None, :] * np.exp(cum_log)  # (sims, days, assets)

    # portfolio value path = sum(shares * price)
    port_paths = np.einsum("sda,a->sd", price_paths, shares)

    # prepend day-0 (initial value)
    port_paths_full = np.concatenate(
        [np.full((n_sims, 1), initial_value), port_paths], axis=1
    )

    terminal_values = port_paths_full[:, -1]
    terminal_returns = terminal_values / initial_value - 1.0
    pnl = terminal_values - initial_value

    return {
        "port_paths_full": port_paths_full,
        "terminal_values": terminal_values,
        "terminal_returns": terminal_returns,
        "pnl": pnl,
        "shares": shares,
        "n_sims": n_sims,
        "horizon_days": horizon_days,
        "initial_value": initial_value,
    }


# ----------------------------------------------------------------------
# Risk metrics
# ----------------------------------------------------------------------

def historical_var_cvar(pnl: np.ndarray, confidence: float) -> tuple[float, float]:
    """VaR/CVaR expressed as POSITIVE loss numbers."""
    alpha = 1 - confidence
    var = -np.quantile(pnl, alpha)
    tail = pnl[pnl <= -var]
    cvar = -tail.mean() if len(tail) > 0 else var
    return float(var), float(cvar)


def parametric_var_cvar(mu: float, sigma: float, initial_value: float, confidence: float) -> tuple[float, float]:
    """Analytic (Gaussian) VaR/CVaR for the terminal P&L distribution."""
    z = stats.norm.ppf(1 - confidence)
    var = -(mu + sigma * z) * initial_value
    phi_z = stats.norm.pdf(z)
    cvar = -(mu - sigma * phi_z / (1 - confidence)) * initial_value
    return float(var), float(cvar)


def max_drawdown(path: np.ndarray) -> float:
    running_max = np.maximum.accumulate(path)
    dd = (path - running_max) / running_max
    return float(dd.min())


def sharpe_ratio(mean_daily_ret: float, daily_vol: float, rf_annual: float = 0.04) -> float:
    rf_daily = rf_annual / TRADING_DAYS
    if daily_vol == 0:
        return 0.0
    return float((mean_daily_ret - rf_daily) / daily_vol * np.sqrt(TRADING_DAYS))


def sortino_ratio(daily_rets: pd.Series, rf_annual: float = 0.04) -> float:
    rf_daily = rf_annual / TRADING_DAYS
    downside = daily_rets[daily_rets < rf_daily]
    downside_std = downside.std(ddof=1) if len(downside) > 1 else np.nan
    if not downside_std or np.isnan(downside_std) or downside_std == 0:
        return 0.0
    return float((daily_rets.mean() - rf_daily) / downside_std * np.sqrt(TRADING_DAYS))


def compute_full_report(
    stats_: PortfolioStats,
    ret_df: pd.DataFrame,
    mc: dict,
    confidences=(0.95, 0.99),
) -> dict:
    initial_value = mc["initial_value"]
    pnl = mc["pnl"]
    term_vals = mc["terminal_values"]
    port_paths = mc["port_paths_full"]

    risk_table = []
    for c in confidences:
        h_var, h_cvar = historical_var_cvar(pnl, c)
        p_var, p_cvar = parametric_var_cvar(
            stats_.port_mu_daily * mc["horizon_days"],
            stats_.port_sigma_daily * np.sqrt(mc["horizon_days"]),
            initial_value,
            c,
        )
        risk_table.append({
            "confidence": c,
            "mc_var": h_var,
            "mc_cvar": h_cvar,
            "mc_var_pct": h_var / initial_value,
            "mc_cvar_pct": h_cvar / initial_value,
            "parametric_var": p_var,
            "parametric_cvar": p_cvar,
        })

    # drawdown distribution across simulated paths
    drawdowns = np.array([max_drawdown(p) for p in port_paths[:: max(1, mc["n_sims"] // 2000)]])

    ann_vol = stats_.port_sigma_daily * np.sqrt(TRADING_DAYS)
    ann_ret = stats_.port_mu_daily * TRADING_DAYS
    port_daily_rets = (ret_df.values @ stats_.weights)

    report = {
        "meta": {
            "tickers": stats_.tickers,
            "weights": stats_.weights.tolist(),
            "initial_value": initial_value,
            "n_sims": mc["n_sims"],
            "horizon_days": mc["horizon_days"],
            "history_days_used": int(len(ret_df)),
        },
        "distribution": {
            "annualized_return": float(ann_ret),
            "annualized_volatility": float(ann_vol),
            "daily_mean_return": float(stats_.port_mu_daily),
            "daily_volatility": float(stats_.port_sigma_daily),
            "skew": float(stats.skew(pnl)),
            "kurtosis": float(stats.kurtosis(pnl)),
            "sharpe_ratio": sharpe_ratio(stats_.port_mu_daily, stats_.port_sigma_daily),
            "sortino_ratio": sortino_ratio(pd.Series(port_daily_rets)),
        },
        "risk_table": risk_table,
        "drawdown": {
            "mean": float(drawdowns.mean()),
            "worst": float(drawdowns.min()),
            "p5": float(np.quantile(drawdowns, 0.05)),
        },
        "simulation_summary": {
            "median_terminal_value": float(np.median(term_vals)),
            "p5_terminal_value": float(np.quantile(term_vals, 0.05)),
            "p95_terminal_value": float(np.quantile(term_vals, 0.95)),
            "prob_of_loss": float((term_vals < initial_value).mean()),
        },
    }
    return report
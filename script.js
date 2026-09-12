/* ============================================================
   GS Risk Desk — dashboard rendering
   Reads the injected DATA payload and renders every widget.
   ============================================================ */
(function () {
  const fmtUSD = (v, dec = 0) => "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: dec, minimumFractionDigits: dec });
  const fmtUSDCompact = (v) => {
    const abs = Math.abs(v);
    if (abs >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return (v / 1e3).toFixed(0) + "K";
    return v.toFixed(0);
  };
  const fmtPct = (v, dec = 2) => (v * 100).toFixed(dec) + "%";
  const HORIZON_LABELS = { "1": "1-Day", "5": "1-Week", "21": "1-Month", "63": "1-Quarter" };

  let state = { horizon: String(DATA.primary_horizon), confidence: 0.95 };

  const CHART_FONT = { family: "'IBM Plex Mono', monospace", size: 11 };
  Chart.defaults.color = "#8A93A3";
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.borderColor = "#29334280";

  // ---------------------------------------------------------- masthead
  function renderMasthead() {
    document.getElementById("mm-window").textContent = `${DATA.data_window.start} → ${DATA.data_window.end}`;
    document.getElementById("mm-days").textContent = DATA.data_window.trading_days.toLocaleString();
    document.getElementById("mm-sims").textContent = "20,000";

    const rep = DATA.horizons[state.horizon];
    const rt = rep.risk_table.find(r => r.confidence === state.confidence);
    const strip = document.getElementById("ticker-strip");
    strip.innerHTML = `
      <div class="tstat">
        <div class="label">GS — Position Value</div>
        <div class="value">${fmtUSD(DATA.position.initial_value)}</div>
        <div class="sub">${DATA.position.shares.toLocaleString(undefined,{maximumFractionDigits:0})} sh @ ${fmtUSD(DATA.position.last_price,2)}</div>
      </div>
      <div class="tstat">
        <div class="label">Ann. Return</div>
        <div class="value mono ${rep.distribution.annualized_return>=0?'up':'down'}" style="color:${rep.distribution.annualized_return>=0?'var(--teal)':'var(--red)'}">${fmtPct(rep.distribution.annualized_return)}</div>
        <div class="sub">10y calibration</div>
      </div>
      <div class="tstat">
        <div class="label">Ann. Volatility</div>
        <div class="value mono">${fmtPct(rep.distribution.annualized_volatility)}</div>
        <div class="sub">σ daily ${fmtPct(rep.distribution.daily_volatility,3)}</div>
      </div>
      <div class="tstat">
        <div class="label">95% VaR (21d)</div>
        <div class="value mono" style="color:var(--amber)">${fmtUSDCompact(DATA.horizons["21"].risk_table[0].mc_var)}</div>
        <div class="sub">${fmtPct(DATA.horizons["21"].risk_table[0].mc_var_pct)} of position</div>
      </div>
      <div class="tstat">
        <div class="label">95% CVaR (21d)</div>
        <div class="value mono" style="color:var(--red)">${fmtUSDCompact(DATA.horizons["21"].risk_table[0].mc_cvar)}</div>
        <div class="sub">${fmtPct(DATA.horizons["21"].risk_table[0].mc_cvar_pct)} of position</div>
      </div>
      <div class="tstat">
        <div class="label">Sharpe / Sortino</div>
        <div class="value mono">${rep.distribution.sharpe_ratio.toFixed(2)} <small>/ ${rep.distribution.sortino_ratio.toFixed(2)}</small></div>
        <div class="sub">rf = 4.0% ann.</div>
      </div>
    `;
    document.getElementById("pos-value-inline").textContent = DATA.position.initial_value.toLocaleString();
  }

  // ---------------------------------------------------------- confidence pills (hero)
  function renderHeroPills() {
    const group = document.getElementById("horizon-pills");
    const confs = [0.95, 0.99];
    group.innerHTML = confs.map(c =>
      `<button class="pill ${c === state.confidence ? "active" : ""}" data-conf="${c}">${(c*100).toFixed(0)}% CONF</button>`
    ).join("");
    group.querySelectorAll(".pill").forEach(btn => {
      btn.addEventListener("click", () => {
        state.confidence = parseFloat(btn.dataset.conf);
        renderAll();
      });
    });
  }

  // ---------------------------------------------------------- fan chart (signature SVG)
  function renderFanChart() {
    document.getElementById("hero-horizon-label").textContent = `${DATA.primary_horizon}-day`;
    const svg = document.getElementById("fan-svg");
    svg.innerHTML = "";
    const W = 1200, H = 420;
    const marginL = 46, marginR = 210, marginT = 20, marginB = 34;
    const plotW = W - marginL - marginR, plotH = H - marginT - marginB;

    const paths = DATA.simulated_paths_sample; // 250 x (days+1)
    const nDays = paths[0].length - 1;
    const allVals = paths.flat();
    const yMin = Math.min(...allVals) * 0.98;
    const yMax = Math.max(...allVals) * 1.02;

    const x = (d) => marginL + (d / nDays) * plotW;
    const y = (v) => marginT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

    const ns = "http://www.w3.org/2000/svg";
    const mk = (tag, attrs) => {
      const el = document.createElementNS(ns, tag);
      Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
      return el;
    };

    // gridlines (y)
    const gridSteps = 5;
    for (let i = 0; i <= gridSteps; i++) {
      const v = yMin + (i / gridSteps) * (yMax - yMin);
      const yy = y(v);
      svg.appendChild(mk("line", { x1: marginL, x2: W - marginR, y1: yy, y2: yy, stroke: "#29334255", "stroke-width": 1 }));
      const t = mk("text", { x: 6, y: yy + 4, fill: "#8A93A3", "font-size": 11, "font-family": "IBM Plex Mono, monospace" });
      t.textContent = fmtUSDCompact(v);
      svg.appendChild(t);
    }
    // x axis labels
    const dayTicks = nDays <= 21 ? [0, Math.round(nDays/2), nDays] : [0, Math.round(nDays/3), Math.round(2*nDays/3), nDays];
    dayTicks.forEach(d => {
      const t = mk("text", { x: x(d), y: H - 8, fill: "#8A93A3", "font-size": 11, "font-family": "IBM Plex Mono, monospace", "text-anchor": "middle" });
      t.textContent = "D+" + d;
      svg.appendChild(t);
    });

    // simulated paths
    const lineFor = (arr) => arr.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    paths.forEach((p, idx) => {
      const finalUp = p[p.length - 1] >= p[0];
      const el = mk("path", {
        d: lineFor(p), fill: "none",
        stroke: finalUp ? "#3FBFA6" : "#8A93A3",
        "stroke-width": 1, "stroke-opacity": finalUp ? 0.16 : 0.10,
      });
      svg.appendChild(el);
      const len = el.getTotalLength();
      el.style.strokeDasharray = len;
      el.style.strokeDashoffset = len;
      el.style.transition = `stroke-dashoffset 1.1s cubic-bezier(.2,.7,.2,1) ${(idx % 60) * 9}ms`;
      requestAnimationFrame(() => requestAnimationFrame(() => { el.style.strokeDashoffset = 0; }));
    });

    // median path
    const median = [];
    for (let d = 0; d <= nDays; d++) {
      const vals = paths.map(p => p[d]).sort((a, b) => a - b);
      median.push(vals[Math.floor(vals.length / 2)]);
    }
    const medEl = mk("path", { d: lineFor(median), fill: "none", stroke: "#3FBFA6", "stroke-width": 2.4 });
    svg.appendChild(medEl);
    const mlen = medEl.getTotalLength();
    medEl.style.strokeDasharray = mlen; medEl.style.strokeDashoffset = mlen;
    medEl.style.transition = "stroke-dashoffset 1.4s cubic-bezier(.2,.7,.2,1) .1s";
    requestAnimationFrame(() => requestAnimationFrame(() => { medEl.style.strokeDashoffset = 0; }));

    // VaR / CVaR threshold lines at selected confidence, primary horizon
    const rep21 = DATA.horizons[String(DATA.primary_horizon)];
    const rt = rep21.risk_table.find(r => r.confidence === state.confidence);
    const varLevel = DATA.position.initial_value - rt.mc_var;
    const cvarLevel = DATA.position.initial_value - rt.mc_cvar;
    [{ v: varLevel, color: "#E0A458", label: `${(state.confidence*100).toFixed(0)}% VaR  ${fmtUSDCompact(varLevel)}` },
     { v: cvarLevel, color: "#D1554A", label: `CVaR  ${fmtUSDCompact(cvarLevel)}` }].forEach(t => {
      const yy = y(t.v);
      svg.appendChild(mk("line", { x1: marginL, x2: W - marginR + 8, y1: yy, y2: yy, stroke: t.color, "stroke-width": 1.3, "stroke-dasharray": "5,4", opacity: 0.85 }));
      const txt = mk("text", { x: W - marginR + 14, y: yy + 4, fill: t.color, "font-size": 11.5, "font-family": "IBM Plex Mono, monospace", "font-weight": 600 });
      txt.textContent = t.label;
      svg.appendChild(txt);
    });

    // sideways terminal-value distribution histogram on the right
    const term = DATA.terminal_distribution_sample;
    const bins = 26;
    const hMin = yMin, hMax = yMax;
    const counts = new Array(bins).fill(0);
    term.forEach(v => {
      let b = Math.floor(((v - hMin) / (hMax - hMin)) * bins);
      b = Math.max(0, Math.min(bins - 1, b));
      counts[b]++;
    });
    const maxCount = Math.max(...counts);
    const histX0 = W - marginR + 90;
    const histMaxW = 96;
    counts.forEach((c, i) => {
      const vLo = hMin + (i / bins) * (hMax - hMin);
      const vHi = hMin + ((i + 1) / bins) * (hMax - hMin);
      const yTop = y(vHi), yBot = y(vLo);
      const w = (c / maxCount) * histMaxW;
      const mid = (vLo + vHi) / 2;
      const color = mid < DATA.position.initial_value ? "#D1554A" : "#3FBFA6";
      const rect = mk("rect", { x: histX0, y: Math.min(yTop,yBot), width: 0, height: Math.max(1, Math.abs(yBot - yTop) - 1), fill: color, opacity: 0.55 });
      svg.appendChild(rect);
      rect.style.transition = `width .9s cubic-bezier(.2,.8,.2,1) ${300 + i * 18}ms`;
      requestAnimationFrame(() => requestAnimationFrame(() => { rect.setAttribute("width", w); }));
    });
    const histLabel = mk("text", { x: histX0, y: marginT - 4, fill: "#8A93A3", "font-size": 10, "font-family": "IBM Plex Mono, monospace" });
    histLabel.textContent = "TERMINAL VALUE DIST.";
    svg.appendChild(histLabel);

    // baseline (initial value) marker
    const baseY = y(DATA.position.initial_value);
    svg.appendChild(mk("line", { x1: marginL, x2: W - marginR, y1: baseY, y2: baseY, stroke: "#EDEAE066", "stroke-width": 1, "stroke-dasharray": "2,3" }));
  }

  // ---------------------------------------------------------- metric grid
  function renderMetricGrid() {
    const rep = DATA.horizons[state.horizon];
    const rt = rep.risk_table.find(r => r.confidence === state.confidence);
    const grid = document.getElementById("metric-grid");
    const cards = [
      { cls: "amber", label: `Value at Risk (${(state.confidence*100)|0}%)`, value: fmtUSD(rt.mc_var), sub: `${fmtPct(rt.mc_var_pct)} of position · ${HORIZON_LABELS[state.horizon]} horizon` },
      { cls: "red", label: `Cond. VaR / Expected Shortfall`, value: fmtUSD(rt.mc_cvar), sub: `${fmtPct(rt.mc_cvar_pct)} of position · avg. loss beyond VaR` },
      { cls: "teal", label: "Annualized Volatility", value: fmtPct(rep.distribution.annualized_volatility), sub: `Daily σ ${fmtPct(rep.distribution.daily_volatility,3)}` },
      { cls: "steel", label: "Probability of Loss", value: fmtPct(rep.simulation_summary.prob_of_loss,1), sub: `Over ${HORIZON_LABELS[state.horizon].toLowerCase()} horizon` },
      { cls: "teal", label: "Sharpe Ratio", value: rep.distribution.sharpe_ratio.toFixed(2), sub: "Risk-free rate 4.0% annual" },
      { cls: "steel", label: "Sortino Ratio", value: rep.distribution.sortino_ratio.toFixed(2), sub: "Downside-deviation adjusted" },
      { cls: "red", label: "Worst Simulated Drawdown", value: fmtPct(rep.drawdown.worst), sub: `Median across paths: ${fmtPct(rep.drawdown.mean)}` },
      { cls: "amber", label: "Skew / Kurtosis", value: `${rep.distribution.skew.toFixed(2)} / ${rep.distribution.kurtosis.toFixed(2)}`, sub: "Terminal P&L distribution shape" },
    ];
    grid.innerHTML = cards.map(c => `
      <div class="mcard ${c.cls}">
        <div class="bar"></div>
        <div class="label">${c.label}</div>
        <div class="value">${c.value}</div>
        <div class="foot">${c.sub}</div>
      </div>
    `).join("");
  }

  // ---------------------------------------------------------- horizon pills (metric section) -- injected into sec-note area via sec-head
  function renderHorizonPills() {
    let host = document.getElementById("horizon-pill-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "horizon-pill-host";
      host.className = "pill-group";
      host.style.marginTop = "10px";
      document.querySelector("#metric-grid").parentElement.querySelector(".sec-head > div:first-child").appendChild(host);
    }
    const horizons = Object.keys(DATA.horizons);
    host.innerHTML = horizons.map(h => `<button class="pill ${h===state.horizon?'active':''}" data-h="${h}">${HORIZON_LABELS[h]}</button>`).join("");
    host.querySelectorAll(".pill").forEach(btn => {
      btn.addEventListener("click", () => { state.horizon = btn.dataset.h; renderAll(); });
    });
  }

  // ---------------------------------------------------------- price + drawdown chart
  let priceChart, rollingChart, histChart;
  function renderPriceChart() {
    const ctx = document.getElementById("chart-price");
    const ph = DATA.price_history;
    if (priceChart) priceChart.destroy();
    priceChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: ph.dates,
        datasets: [
          {
            label: "GS Close", data: ph.close, borderColor: "#EDEAE0", borderWidth: 1.6,
            pointRadius: 0, yAxisID: "y", tension: 0.1,
          },
          {
            label: "Drawdown", data: ph.drawdown.map(v => v * 100), borderColor: "#D1554A55",
            backgroundColor: "#D1554A22", borderWidth: 1, pointRadius: 0, fill: true, yAxisID: "y1", tension: 0.1,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 900, easing: "easeOutQuart" },
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: { titleFont: CHART_FONT, bodyFont: CHART_FONT } },
        scales: {
          x: { ticks: { maxTicksLimit: 8, font: CHART_FONT }, grid: { display: false } },
          y: { position: "left", ticks: { callback: v => "$" + v, font: CHART_FONT }, grid: { color: "#29334240" } },
          y1: { position: "right", min: -60, max: 5, ticks: { callback: v => v + "%", font: CHART_FONT }, grid: { display: false } },
        },
      },
    });
  }

  function renderRollingChart() {
    const ctx = document.getElementById("chart-rolling");
    const ph = DATA.price_history;
    if (rollingChart) rollingChart.destroy();
    rollingChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: ph.dates,
        datasets: [
          { label: "30d Ann. Volatility", data: ph.rolling_vol_30d.map(v => v==null?null:v*100), borderColor: "#3FBFA6", borderWidth: 1.6, pointRadius: 0, tension: 0.15 },
          { label: "250d Hist. 95% VaR (daily)", data: ph.rolling_var95.map(v => v==null?null:v*100), borderColor: "#E0A458", borderWidth: 1.6, pointRadius: 0, tension: 0.15 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 900, easing: "easeOutQuart" },
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { family: "Inter", size: 11 } } }, tooltip: { titleFont: CHART_FONT, bodyFont: CHART_FONT } },
        scales: {
          x: { ticks: { maxTicksLimit: 8, font: CHART_FONT }, grid: { display: false } },
          y: { ticks: { callback: v => v + "%", font: CHART_FONT }, grid: { color: "#29334240" } },
        },
      },
    });
  }

  function renderHistChart() {
    const ctx = document.getElementById("chart-hist");
    const rets = DATA.return_histogram.daily_returns_sample;
    const bins = 40;
    const min = Math.min(...rets), max = Math.max(...rets);
    const width = (max - min) / bins;
    const counts = new Array(bins).fill(0);
    rets.forEach(r => { let b = Math.floor((r - min) / width); b = Math.max(0, Math.min(bins - 1, b)); counts[b]++; });
    const labels = counts.map((_, i) => ((min + (i + 0.5) * width) * 100).toFixed(1) + "%");
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
    const gauss = counts.map((_, i) => {
      const xv = min + (i + 0.5) * width;
      const density = (1 / (sd * Math.sqrt(2 * Math.PI))) * Math.exp(-((xv - mean) ** 2) / (2 * sd * sd));
      return density * rets.length * width;
    });
    if (histChart) histChart.destroy();
    histChart = new Chart(ctx, {
      data: {
        labels,
        datasets: [
          { type: "bar", label: "Observed", data: counts, backgroundColor: "#3FBFA655", borderWidth: 0, borderRadius: 2 },
          { type: "line", label: "Fitted normal", data: gauss, borderColor: "#E0A458", borderWidth: 2, pointRadius: 0, tension: 0.35 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 900, easing: "easeOutQuart" },
        plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { family: "Inter", size: 11 } } } },
        scales: {
          x: { ticks: { maxTicksLimit: 10, font: CHART_FONT }, grid: { display: false } },
          y: { ticks: { font: CHART_FONT }, grid: { color: "#29334240" } },
        },
      },
    });
  }

  // ---------------------------------------------------------- risk table
  function renderRiskTable() {
    const thead = document.querySelector("#risk-table thead");
    const tbody = document.querySelector("#risk-table tbody");
    thead.innerHTML = `<tr><th>Horizon</th><th>Conf.</th><th>MC VaR</th><th>MC CVaR</th><th>Parametric VaR</th></tr>`;
    let rows = "";
    Object.keys(DATA.horizons).forEach(h => {
      DATA.horizons[h].risk_table.forEach(rt => {
        const isSel = h === state.horizon && rt.confidence === state.confidence;
        rows += `<tr style="${isSel ? "background:#1A2230" : ""}">
          <td class="tkr">${HORIZON_LABELS[h]}</td>
          <td>${(rt.confidence*100)|0}%</td>
          <td class="hl">${fmtUSDCompact(rt.mc_var)}</td>
          <td class="hl2">${fmtUSDCompact(rt.mc_cvar)}</td>
          <td>${fmtUSDCompact(rt.parametric_var)}</td>
        </tr>`;
      });
    });
    tbody.innerHTML = rows;
  }

  // ---------------------------------------------------------- reveal-on-scroll
  function initReveal() {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { threshold: 0.12 });
    document.querySelectorAll(".reveal").forEach(el => io.observe(el));
  }

  function renderAll() {
    renderMasthead();
    renderHeroPills();
    renderFanChart();
    renderHorizonPills();
    renderMetricGrid();
    renderRiskTable();
  }

  document.addEventListener("DOMContentLoaded", () => {
    renderAll();
    renderPriceChart();
    renderRollingChart();
    renderHistChart();
    initReveal();
    window.addEventListener("resize", () => { renderFanChart(); });
  });
})();

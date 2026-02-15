import { useState, useRef, useCallback, useEffect } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ScatterChart, Scatter, Cell,
  LineChart, Line, Legend, ReferenceLine
} from "recharts";

/* ═══════════════════════════════════════════════════════
   YAHOO FINANCE OPTIONS DATA FETCHER
   Real market prices — no Black-Scholes needed.
   ═══════════════════════════════════════════════════════ */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const proxyBuilders = [
  (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  (u) => `https://thingproxy.freeboard.io/fetch/${u}`,
  (u) => u,
];

const fetchWithProxies = async (url, onStatus, label, maxAttempts = 3) => {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    for (let p = 0; p < proxyBuilders.length; p++) {
      const proxyUrl = proxyBuilders[(attempt + p) % proxyBuilders.length](url);
      try {
        if (onStatus) onStatus(`${label} (attempt ${attempt + 1}, proxy ${p + 1}/${proxyBuilders.length})`);
        const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
        if (!resp.ok) continue;
        const text = await resp.text();
        if (!text || text.length < 30) continue;
        let data;
        try { data = JSON.parse(text); } catch { continue; }
        return data;
      } catch (e) { lastErr = e; }
    }
    if (attempt < maxAttempts - 1) await sleep(1500 * (attempt + 1));
  }
  throw new Error(`${label} failed: ${lastErr?.message || "All proxies failed"}`);
};

// Fetch spot price
const fetchSpotPrice = async (ticker, onStatus) => {
  const now = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${now - 5 * 86400}&period2=${now}&interval=1d`;
  const data = await fetchWithProxies(url, onStatus, `Fetching ${ticker} spot price`);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No data returned for ${ticker}`);
  const meta = result.meta;
  const price = meta?.regularMarketPrice;
  if (price) return { price, name: meta.shortName || meta.symbol || ticker };
  const closes = result.indicators?.adjclose?.[0]?.adjclose || result.indicators?.quote?.[0]?.close;
  if (closes) {
    const valid = closes.filter(c => c != null);
    if (valid.length > 0) return { price: valid[valid.length - 1], name: ticker };
  }
  throw new Error(`Could not extract price for ${ticker}`);
};

// Fetch option chain — returns available expiry dates + calls/puts
const fetchOptionChain = async (ticker, expiryTimestamp, onStatus) => {
  let url = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}`;
  if (expiryTimestamp) url += `?date=${expiryTimestamp}`;
  const data = await fetchWithProxies(url, onStatus, `Fetching ${ticker} options chain`);
  const oc = data?.optionChain?.result?.[0];
  if (!oc) throw new Error(`No options data for ${ticker}`);
  return {
    expirationDates: oc.expirationDates || [],
    calls: oc.options?.[0]?.calls || [],
    puts: oc.options?.[0]?.puts || [],
    quote: oc.quote || {},
  };
};


/* ═══════════════════════════════════════════════════════
   OPTION ANALYSIS — Real prices, real Greeks from Yahoo
   ═══════════════════════════════════════════════════════ */

function daysUntilExpiry(expiryTs) {
  return Math.max(1, Math.ceil((expiryTs - Date.now() / 1000) / 86400));
}

function analyzeCallOptions(calls, spotPrice, expiryTs, numStrikes) {
  const dte = daysUntilExpiry(expiryTs);
  const sorted = [...calls].sort((a, b) => a.strike - b.strike);

  // Find ATM
  let atmIdx = 0, minDist = Infinity;
  sorted.forEach((c, i) => {
    const dist = Math.abs(c.strike - spotPrice);
    if (dist < minDist) { minDist = dist; atmIdx = i; }
  });

  // Determine strike increment from ATM area
  let increment = 1;
  if (sorted.length > 1) {
    const nearby = sorted.slice(Math.max(0, atmIdx - 1), Math.min(sorted.length, atmIdx + 2));
    if (nearby.length >= 2) increment = nearby[1].strike - nearby[0].strike;
  }

  const startIdx = Math.max(0, atmIdx - numStrikes);
  const endIdx = Math.min(sorted.length, atmIdx + numStrikes + 1);
  const selected = sorted.slice(startIdx, endIdx);

  return selected.map(c => {
    const strike = c.strike;
    // Use mid price from real bid/ask
    const bid = c.bid || 0;
    const ask = c.ask || 0;
    const mid = (bid > 0 && ask > 0) ? (bid + ask) / 2 : c.lastPrice || 0;
    const last = c.lastPrice || 0;
    const volume = c.volume || 0;
    const openInterest = c.openInterest || 0;
    const impliedVol = c.impliedVolatility || 0;

    // THE KEY: extrinsic from real market prices, no model
    const intrinsic = Math.max(0, spotPrice - strike);
    const extrinsic = Math.max(0, mid - intrinsic);

    // Greeks directly from Yahoo
    const delta = typeof c.delta === "number" ? c.delta : null;
    const gamma = typeof c.gamma === "number" ? c.gamma : null;
    const theta = typeof c.theta === "number" ? c.theta : null;
    const vega = typeof c.vega === "number" ? c.vega : null;
    const rho = typeof c.rho === "number" ? c.rho : null;

    const extrinsicPerDTE = extrinsic / dte;
    const absDelta = delta != null ? Math.abs(delta) : null;

    // Primary ranking metric
    const efficiencyScore = (absDelta != null && absDelta > 0.01)
      ? extrinsicPerDTE / absDelta
      : null;

    // Fallback ranking if no Greeks: pure extrinsic/DTE
    const fallbackScore = extrinsicPerDTE;

    const annualizedYield = (extrinsic / strike) * (365 / dte) * 100;

    const isITM = strike < spotPrice;
    const isATM = Math.abs(strike - spotPrice) <= increment * 0.6;
    const moneyness = isATM ? "ATM" : isITM ? "ITM" : "OTM";

    return {
      strike, mid, bid, ask, last, volume, openInterest, impliedVol,
      intrinsic, extrinsic, extrinsicPerDTE,
      efficiencyScore, fallbackScore, annualizedYield,
      delta, gamma, theta, vega, rho,
      dte, moneyness, inTheMoney: c.inTheMoney || false,
      contractSymbol: c.contractSymbol || "",
    };
  });
}

function rankByEfficiency(options) {
  const hasGreeks = options.some(o => o.efficiencyScore != null);
  const rankable = options.filter(o => o.extrinsic > 0.01);

  if (hasGreeks) {
    // Split: options with Greeks get ranked by efficiency, others appended at end
    const withGreeks = rankable.filter(o => o.efficiencyScore != null && o.efficiencyScore > 0);
    const noGreeks = rankable.filter(o => o.efficiencyScore == null || o.efficiencyScore <= 0);
    withGreeks.sort((a, b) => b.efficiencyScore - a.efficiencyScore);
    noGreeks.sort((a, b) => b.fallbackScore - a.fallbackScore);
    return [...withGreeks, ...noGreeks].map((o, i) => ({ ...o, rank: i + 1 }));
  } else {
    // No Greeks at all: rank by extrinsic/DTE
    rankable.sort((a, b) => b.fallbackScore - a.fallbackScore);
    return rankable.map((o, i) => ({ ...o, rank: i + 1 }));
  }
}


/* ═══════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════ */

function getNextFridays(count = 12) {
  const fridays = [];
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const diff = (5 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  for (let i = 0; i < count; i++) { fridays.push(new Date(d)); d.setDate(d.getDate() + 7); }
  return fridays;
}

function tsToLabel(ts) {
  return new Date(ts * 1000).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
function tsToDTE(ts) { return Math.max(1, Math.ceil((ts - Date.now() / 1000) / 86400)); }

function findClosestExpiry(available, targetDateStr) {
  const target = new Date(targetDateStr + "T16:00:00").getTime() / 1000;
  return available.reduce((best, ts) => Math.abs(ts - target) < Math.abs(best - target) ? ts : best, available[0]);
}

function fmtDate(d) { return d.toISOString().split("T")[0]; }
function fmtLabel(d) { return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); }


/* ═══════════════════════════════════════════════════════
   THEME
   ═══════════════════════════════════════════════════════ */

const ACCENT = "#00d4aa";
const ACCENT2 = "#6366f1";
const ACCENT3 = "#f59e0b";
const BG_DARK = "#070b14";
const BG_CARD = "#0d1321";
const BG_CARD2 = "#131b2e";
const BG_INPUT = "#0f1729";
const BORDER = "#1b2540";
const TEXT = "#e0e7f1";
const TEXT_DIM = "#6b7a99";
const GREEN = "#00d4aa";
const RED = "#ef4444";
const AMBER = "#f59e0b";
const CYAN = "#22d3ee";

const mono = "'JetBrains Mono', 'Fira Code', monospace";
const head = "'Space Grotesk', 'DM Sans', sans-serif";


/* ═══════════════════════════════════════════════════════
   UI COMPONENTS
   ═══════════════════════════════════════════════════════ */

const StatCard = ({ label, value, sub, accent }) => (
  <div style={{
    background: BG_CARD2, border: `1px solid ${BORDER}`, borderRadius: 10,
    padding: "14px 18px", flex: "1 1 150px", minWidth: 150,
    borderLeft: accent ? `3px solid ${accent}` : `3px solid ${BORDER}`,
  }}>
    <div style={{ fontSize: 10, color: TEXT_DIM, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 4, fontFamily: mono }}>{label}</div>
    <div style={{ fontSize: 20, fontWeight: 700, color: TEXT, fontFamily: mono }}>{value}</div>
    {sub && <div style={{ fontSize: 10, color: TEXT_DIM, marginTop: 2, fontFamily: mono }}>{sub}</div>}
  </div>
);

const SectionTitle = ({ num, title, subtitle }) => (
  <div style={{ marginBottom: 20 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span style={{
        background: `linear-gradient(135deg, ${ACCENT}, ${ACCENT2})`, color: "#fff",
        fontWeight: 800, fontSize: 13, width: 30, height: 30, borderRadius: 8,
        display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: mono,
      }}>{num}</span>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: TEXT, fontFamily: head }}>{title}</h2>
    </div>
    {subtitle && <p style={{ margin: "6px 0 0 42px", color: TEXT_DIM, fontSize: 13, fontFamily: mono }}>{subtitle}</p>}
  </div>
);

const ttStyle = {
  background: "#080d18", border: `1px solid ${BORDER}`, borderRadius: 8,
  padding: "10px 14px", fontSize: 12, fontFamily: mono, boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
};

const RankBadge = ({ rank, total }) => {
  const pct = rank / total;
  const c = pct <= 0.2 ? GREEN : pct <= 0.5 ? AMBER : RED;
  return (<span style={{
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: 28, height: 28, borderRadius: 6, fontWeight: 800, fontSize: 13,
    fontFamily: mono, color: "#fff", background: `${c}22`, border: `1px solid ${c}66`,
  }}>{rank}</span>);
};

const MoneyBadge = ({ type }) => {
  const c = { ITM: CYAN, ATM: ACCENT3, OTM: TEXT_DIM }[type] || TEXT_DIM;
  return (<span style={{
    fontSize: 9, fontWeight: 700, letterSpacing: 1, padding: "2px 6px",
    borderRadius: 4, background: `${c}18`, color: c, fontFamily: mono,
  }}>{type}</span>);
};


/* ═══════════════════════════════════════════════════════
   MAIN APP
   ═══════════════════════════════════════════════════════ */

export default function OptionsAnalyzer() {
  const [ticker, setTicker] = useState("AAPL");
  const [targetExpiry, setTargetExpiry] = useState("");
  const [numStrikes, setNumStrikes] = useState("10");

  const [spotPrice, setSpotPrice] = useState(null);
  const [stockName, setStockName] = useState("");
  const [matchedExpiry, setMatchedExpiry] = useState(null);
  const [optionChain, setOptionChain] = useState(null);
  const [rankedOptions, setRankedOptions] = useState(null);

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState(null);
  const resultsRef = useRef(null);
  const fridays = getNextFridays(12);

  useEffect(() => { if (!targetExpiry && fridays.length) setTargetExpiry(fmtDate(fridays[0])); }, []);

  const nStrikes = Math.min(20, Math.max(3, parseInt(numStrikes) || 10));

  const runAnalysis = useCallback(async () => {
    setLoading(true); setError(null); setProgress("Initializing…");
    setSpotPrice(null); setStockName(""); setMatchedExpiry(null);
    setOptionChain(null); setRankedOptions(null);

    try {
      const tkr = ticker.toUpperCase().trim();

      // 1. Spot price
      const spot = await fetchSpotPrice(tkr, setProgress);
      setSpotPrice(spot.price); setStockName(spot.name);

      // 2. Get available expiries
      setProgress(`Loading ${tkr} available expirations…`);
      const initial = await fetchOptionChain(tkr, null, setProgress);
      if (!initial.expirationDates?.length) throw new Error(`No options available for ${tkr}`);

      // 3. Match to selected Friday
      const best = findClosestExpiry(initial.expirationDates, targetExpiry);
      setMatchedExpiry(best);

      // 4. Fetch chain for that expiry
      setProgress(`Loading calls for ${tsToLabel(best)} (${tsToDTE(best)} DTE)…`);
      const chain = await fetchOptionChain(tkr, best, setProgress);
      if (!chain.calls?.length) throw new Error(`No call options found for this expiry`);

      // 5. Analyze from real market prices
      setProgress("Computing extrinsic values from market prices…");
      await sleep(80);
      const analyzed = analyzeCallOptions(chain.calls, spot.price, best, nStrikes);
      setOptionChain(analyzed);

      // 6. Rank
      setProgress("Ranking by efficiency…");
      await sleep(80);
      setRankedOptions(rankByEfficiency(analyzed));
      setProgress("Done!");

      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }, [ticker, targetExpiry, nStrikes]);

  // Chart data
  const extrinsicByStrike = optionChain?.map(o => ({ strike: o.strike.toFixed(1), intrinsic: o.intrinsic, extrinsic: o.extrinsic, total: o.mid, moneyness: o.moneyness })) || [];
  const efficiencyChart = rankedOptions?.slice(0, 20).map(o => ({ strike: o.strike.toFixed(1), efficiency: o.efficiencyScore ?? o.fallbackScore, delta: o.delta, extrinsicPerDTE: o.extrinsicPerDTE, rank: o.rank })) || [];
  const deltaVsExtrinsic = optionChain?.filter(o => o.delta != null && Math.abs(o.delta) > 0.01 && Math.abs(o.delta) < 0.99).map(o => ({ delta: Math.abs(o.delta), extrinsicPerDTE: o.extrinsicPerDTE, strike: o.strike, moneyness: o.moneyness })) || [];
  const greeksProfile = optionChain?.filter(o => o.delta != null).map(o => ({ strike: o.strike.toFixed(1), delta: o.delta, gamma: (o.gamma || 0) * 100, theta: o.theta || 0, vega: o.vega || 0 })) || [];

  const hasGreeks = optionChain?.some(o => o.delta != null);

  const inputStyle = { background: BG_INPUT, border: `1px solid ${BORDER}`, borderRadius: 8, color: TEXT, padding: "10px 14px", fontSize: 14, fontFamily: mono, outline: "none", width: "100%", boxSizing: "border-box" };
  const labelStyle = { fontSize: 10, color: TEXT_DIM, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 6, display: "block", fontFamily: mono };
  const selectStyle = { ...inputStyle, cursor: "pointer", appearance: "none", backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7a99' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`, backgroundRepeat: "no-repeat", backgroundPosition: "right 12px center", paddingRight: 36 };

  return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(180deg, ${BG_DARK} 0%, #0a1020 100%)`, color: TEXT, fontFamily: "'DM Sans', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700;800&family=DM+Sans:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        *::-webkit-scrollbar { width: 6px; height: 6px; }
        *::-webkit-scrollbar-track { background: ${BG_DARK}; }
        *::-webkit-scrollbar-thumb { background: ${BORDER}; border-radius: 3px; }
        input:focus, select:focus { border-color: ${ACCENT} !important; }
        .hover-row:hover { background: ${BG_CARD2} !important; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
        @keyframes slideUp { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
        .slide-up { animation: slideUp .4s ease-out; }
      `}</style>

      <div style={{ maxWidth: 1160, margin: "0 auto", padding: "0 20px" }}>

        {/* HEADER */}
        <div style={{ padding: "40px 0 32px", borderBottom: `1px solid ${BORDER}`, marginBottom: 32 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 44, height: 44, borderRadius: 10, background: `linear-gradient(135deg, ${ACCENT}, ${ACCENT2})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, fontWeight: 800, color: "#fff", fontFamily: mono }}>Θ</div>
            <div>
              <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, fontFamily: head, color: TEXT }}>Options Extrinsic Value Analyzer</h1>
              <p style={{ margin: 0, fontSize: 13, color: TEXT_DIM, fontFamily: mono }}>Real Yahoo Finance prices · Rank strikes by premium-selling efficiency</p>
            </div>
          </div>
        </div>

        {/* INPUT */}
        <div style={{ background: BG_CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28, marginBottom: 28 }}>
          <SectionTitle num="1" title="Configuration" subtitle="Enter ticker and select target expiration week" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 20, marginBottom: 24 }}>
            <div>
              <label style={labelStyle}>Stock Ticker</label>
              <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} placeholder="AAPL, TSLA, SPY…" style={inputStyle} onKeyDown={e => e.key === "Enter" && runAnalysis()} />
            </div>
            <div>
              <label style={labelStyle}>Target Expiration (Friday)</label>
              <select value={targetExpiry} onChange={e => setTargetExpiry(e.target.value)} style={selectStyle}>
                {fridays.map(f => { const d = fmtDate(f); const dte = Math.ceil((f - new Date()) / 864e5); return <option key={d} value={d}>{fmtLabel(f)} — {dte} DTE</option>; })}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Strikes ITM / OTM</label>
              <input value={numStrikes} onChange={e => setNumStrikes(e.target.value)} placeholder="10" style={inputStyle} />
            </div>
          </div>

          <button onClick={runAnalysis} disabled={loading || !ticker.trim()} style={{
            background: loading ? BORDER : `linear-gradient(135deg, ${ACCENT}, ${ACCENT2})`,
            color: "#fff", border: "none", borderRadius: 10, padding: "14px 40px", fontSize: 15, fontWeight: 700, fontFamily: head,
            cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1, boxShadow: loading ? "none" : `0 4px 20px ${ACCENT}33`,
          }}>{loading ? "Analyzing…" : "Analyze Options Chain"}</button>

          {loading && <div style={{ marginTop: 16, padding: "10px 16px", borderRadius: 8, background: `${ACCENT}0a`, border: `1px solid ${ACCENT}22`, fontSize: 13, color: ACCENT, fontFamily: mono, animation: "pulse 1.5s infinite" }}>⟳ {progress}</div>}
          {error && <div style={{ marginTop: 16, padding: "12px 16px", borderRadius: 8, background: `${RED}0a`, border: `1px solid ${RED}33`, fontSize: 13, color: RED, fontFamily: mono }}>✗ {error}</div>}
        </div>

        {/* ═══ RESULTS ═══ */}
        <div ref={resultsRef}>

          {/* Summary */}
          {spotPrice && matchedExpiry && (
            <div className="slide-up" style={{ background: BG_CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28, marginBottom: 28 }}>
              <SectionTitle num="2" title={`${ticker.toUpperCase()} — ${stockName}`} subtitle="Live data from Yahoo Finance" />
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                <StatCard label="Spot Price" value={`$${spotPrice.toFixed(2)}`} accent={ACCENT} />
                <StatCard label="Matched Expiry" value={tsToLabel(matchedExpiry)} accent={ACCENT2} />
                <StatCard label="Days to Expiry" value={tsToDTE(matchedExpiry)} accent={ACCENT3} />
                <StatCard label="Calls Loaded" value={optionChain?.length || "—"} accent={CYAN} />
                <StatCard label="Rankable" value={rankedOptions?.length || "—"} />
              </div>
              <div style={{ marginTop: 14, padding: "8px 14px", borderRadius: 8, fontSize: 12, color: TEXT_DIM, fontFamily: mono, background: BG_CARD2 }}>
                Target: {targetExpiry} → Nearest available: {tsToLabel(matchedExpiry)}
              </div>
            </div>
          )}

          {/* RANKING */}
          {rankedOptions?.length > 0 && (
            <div className="slide-up" style={{ background: BG_CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28, marginBottom: 28 }}>
              <SectionTitle num="3" title="Extrinsic Value Efficiency Ranking"
                subtitle={hasGreeks ? "Ranked: Extrinsic ÷ DTE ÷ |Delta| — best premium-selling strikes first" : "Ranked: Extrinsic ÷ DTE (Greeks unavailable)"} />

              <div style={{ padding: "10px 16px", borderRadius: 8, marginBottom: 20, fontSize: 13, background: `${GREEN}08`, border: `1px solid ${GREEN}22`, color: GREEN, fontFamily: mono }}>
                {hasGreeks ? "✦ Efficiency = Extrinsic ÷ DTE ÷ |Δ| — Higher = more premium per directional risk per day" : "✦ Ranking by Extrinsic ÷ DTE — Yahoo did not return Greeks for this chain"}
              </div>

              {/* Top 3 cards */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14, marginBottom: 24 }}>
                {rankedOptions.slice(0, 3).map((o, i) => {
                  const colors = [ACCENT, ACCENT2, ACCENT3];
                  return (
                    <div key={o.strike} style={{ background: BG_CARD2, border: `1px solid ${colors[i]}33`, borderRadius: 12, padding: "18px 20px", borderTop: `3px solid ${colors[i]}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                        <span style={{ fontSize: 11, color: TEXT_DIM, fontFamily: mono }}>#{i + 1} BEST</span>
                        <MoneyBadge type={o.moneyness} />
                      </div>
                      <div style={{ fontSize: 28, fontWeight: 800, color: TEXT, fontFamily: mono, marginBottom: 6 }}>${o.strike.toFixed(2)}</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, fontSize: 12, fontFamily: mono }}>
                        <div><span style={{ color: TEXT_DIM }}>Mid: </span><span style={{ color: TEXT }}>${o.mid.toFixed(2)}</span></div>
                        <div><span style={{ color: TEXT_DIM }}>Bid/Ask: </span><span style={{ color: TEXT }}>{o.bid.toFixed(2)}/{o.ask.toFixed(2)}</span></div>
                        <div><span style={{ color: TEXT_DIM }}>Intrinsic: </span><span style={{ color: CYAN }}>${o.intrinsic.toFixed(2)}</span></div>
                        <div><span style={{ color: TEXT_DIM }}>Extrinsic: </span><span style={{ color: GREEN, fontWeight: 700 }}>${o.extrinsic.toFixed(2)}</span></div>
                        {o.delta != null && <div><span style={{ color: TEXT_DIM }}>Delta: </span><span style={{ color: CYAN }}>{o.delta.toFixed(3)}</span></div>}
                        {o.theta != null && <div><span style={{ color: TEXT_DIM }}>Theta: </span><span style={{ color: RED }}>{o.theta.toFixed(4)}</span></div>}
                        <div><span style={{ color: TEXT_DIM }}>OI: </span><span style={{ color: TEXT }}>{o.openInterest.toLocaleString()}</span></div>
                        <div><span style={{ color: TEXT_DIM }}>IV: </span><span style={{ color: TEXT }}>{(o.impliedVol * 100).toFixed(1)}%</span></div>
                        <div style={{ gridColumn: "1/3" }}>
                          <span style={{ color: TEXT_DIM }}>Efficiency: </span>
                          <span style={{ color: colors[i], fontWeight: 700, fontSize: 14 }}>{(o.efficiencyScore ?? o.fallbackScore).toFixed(4)}</span>
                        </div>
                        <div style={{ gridColumn: "1/3" }}>
                          <span style={{ color: TEXT_DIM }}>Ann. Yield: </span><span style={{ color: ACCENT3 }}>{o.annualizedYield.toFixed(1)}%</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Full table */}
              <div style={{ overflowX: "auto", borderRadius: 10, border: `1px solid ${BORDER}` }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: mono }}>
                  <thead>
                    <tr style={{ background: BG_CARD2 }}>
                      {["Rank", "Strike", "Bid", "Ask", "Mid", "Intrinsic", "Extrinsic",
                        ...(hasGreeks ? ["Delta", "Gamma", "Theta", "Vega"] : []),
                        "IV", "OI", "Ext/DTE", "Efficiency", "Ann.Yld"
                      ].map(h => (
                        <th key={h} style={{ padding: "10px 8px", textAlign: h === "Rank" ? "center" : "right", color: TEXT_DIM, fontWeight: 600, fontSize: 9, letterSpacing: .8, textTransform: "uppercase", borderBottom: `1px solid ${BORDER}`, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rankedOptions.map(o => (
                      <tr key={o.strike} className="hover-row" style={{ borderBottom: `1px solid ${BORDER}22` }}>
                        <td style={{ padding: "7px 8px", textAlign: "center" }}><RankBadge rank={o.rank} total={rankedOptions.length} /></td>
                        <td style={{ padding: "7px 8px", textAlign: "right", fontWeight: 700, color: TEXT }}>${o.strike.toFixed(2)} <MoneyBadge type={o.moneyness} /></td>
                        <td style={{ padding: "7px 8px", textAlign: "right", color: TEXT_DIM }}>{o.bid.toFixed(2)}</td>
                        <td style={{ padding: "7px 8px", textAlign: "right", color: TEXT_DIM }}>{o.ask.toFixed(2)}</td>
                        <td style={{ padding: "7px 8px", textAlign: "right", color: TEXT }}>{o.mid.toFixed(2)}</td>
                        <td style={{ padding: "7px 8px", textAlign: "right", color: o.intrinsic > 0 ? CYAN : TEXT_DIM }}>{o.intrinsic.toFixed(2)}</td>
                        <td style={{ padding: "7px 8px", textAlign: "right", color: GREEN, fontWeight: 600 }}>{o.extrinsic.toFixed(2)}</td>
                        {hasGreeks && <>
                          <td style={{ padding: "7px 8px", textAlign: "right", color: CYAN }}>{o.delta != null ? o.delta.toFixed(4) : "—"}</td>
                          <td style={{ padding: "7px 8px", textAlign: "right", color: ACCENT2 }}>{o.gamma != null ? o.gamma.toFixed(5) : "—"}</td>
                          <td style={{ padding: "7px 8px", textAlign: "right", color: RED }}>{o.theta != null ? o.theta.toFixed(4) : "—"}</td>
                          <td style={{ padding: "7px 8px", textAlign: "right", color: ACCENT3 }}>{o.vega != null ? o.vega.toFixed(4) : "—"}</td>
                        </>}
                        <td style={{ padding: "7px 8px", textAlign: "right", color: TEXT_DIM }}>{(o.impliedVol * 100).toFixed(1)}%</td>
                        <td style={{ padding: "7px 8px", textAlign: "right", color: TEXT_DIM }}>{o.openInterest.toLocaleString()}</td>
                        <td style={{ padding: "7px 8px", textAlign: "right", color: TEXT }}>{o.extrinsicPerDTE.toFixed(4)}</td>
                        <td style={{ padding: "7px 8px", textAlign: "right", fontWeight: 700, color: o.rank <= 3 ? GREEN : o.rank <= rankedOptions.length * .4 ? ACCENT3 : TEXT_DIM }}>
                          {(o.efficiencyScore ?? o.fallbackScore).toFixed(4)}
                        </td>
                        <td style={{ padding: "7px 8px", textAlign: "right", color: ACCENT3 }}>{o.annualizedYield.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* CHARTS */}
          {optionChain?.length > 0 && (
            <div className="slide-up" style={{ background: BG_CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28, marginBottom: 28 }}>
              <SectionTitle num="4" title="Visual Analysis" subtitle="Charts from live market data" />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))", gap: 20 }}>

                {/* Premium breakdown */}
                <div style={{ background: BG_CARD2, borderRadius: 10, padding: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: TEXT_DIM, marginBottom: 12, fontFamily: mono }}>Premium Breakdown (Intrinsic vs Extrinsic)</div>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={extrinsicByStrike}>
                      <CartesianGrid strokeDasharray="3 3" stroke={BORDER} />
                      <XAxis dataKey="strike" tick={{ fontSize: 9, fill: TEXT_DIM }} angle={-45} textAnchor="end" height={50} />
                      <YAxis tick={{ fontSize: 10, fill: TEXT_DIM }} tickFormatter={v => `$${v.toFixed(0)}`} />
                      <Tooltip content={({ active, payload }) => { if (!active || !payload?.length) return null; const d = payload[0]?.payload || {}; return (<div style={ttStyle}><div style={{ color: TEXT, fontWeight: 700, marginBottom: 6 }}>Strike ${d.strike}</div><div style={{ color: CYAN }}>Intrinsic: ${(d.intrinsic || 0).toFixed(2)}</div><div style={{ color: GREEN }}>Extrinsic: ${(d.extrinsic || 0).toFixed(2)}</div><div style={{ color: TEXT_DIM }}>Mid: ${(d.total || 0).toFixed(2)}</div></div>); }} />
                      <Bar dataKey="intrinsic" stackId="a" fill={CYAN} fillOpacity={0.6} name="Intrinsic" />
                      <Bar dataKey="extrinsic" stackId="a" fill={GREEN} fillOpacity={0.85} name="Extrinsic" radius={[3, 3, 0, 0]} />
                      <Legend wrapperStyle={{ fontSize: 11, fontFamily: mono }} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Efficiency */}
                {efficiencyChart.length > 0 && (
                  <div style={{ background: BG_CARD2, borderRadius: 10, padding: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: TEXT_DIM, marginBottom: 12, fontFamily: mono }}>Efficiency Score — Top Strikes</div>
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart data={efficiencyChart} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" stroke={BORDER} />
                        <XAxis type="number" tick={{ fontSize: 10, fill: TEXT_DIM }} />
                        <YAxis dataKey="strike" type="category" tick={{ fontSize: 10, fill: TEXT_DIM }} width={55} />
                        <Tooltip content={({ active, payload }) => { if (!active || !payload?.length) return null; const d = payload[0]?.payload || {}; return (<div style={ttStyle}><div style={{ color: TEXT, fontWeight: 700, marginBottom: 6 }}>Strike ${d.strike} · #{d.rank}</div><div style={{ color: GREEN }}>Efficiency: {(d.efficiency || 0).toFixed(4)}</div>{d.delta != null && <div style={{ color: CYAN }}>Delta: {d.delta.toFixed(3)}</div>}<div style={{ color: ACCENT3 }}>Ext/DTE: ${(d.extrinsicPerDTE || 0).toFixed(4)}</div></div>); }} />
                        <Bar dataKey="efficiency" radius={[0, 4, 4, 0]}>
                          {efficiencyChart.map((_, i) => <Cell key={i} fill={i < 3 ? ACCENT : i < 7 ? ACCENT2 : TEXT_DIM} fillOpacity={Math.max(0.3, 1 - i * 0.04)} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Delta scatter */}
                {hasGreeks && deltaVsExtrinsic.length > 0 && (
                  <div style={{ background: BG_CARD2, borderRadius: 10, padding: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: TEXT_DIM, marginBottom: 12, fontFamily: mono }}>Delta vs Extrinsic per DTE</div>
                    <ResponsiveContainer width="100%" height={280}>
                      <ScatterChart>
                        <CartesianGrid strokeDasharray="3 3" stroke={BORDER} />
                        <XAxis dataKey="delta" name="Delta" tick={{ fontSize: 10, fill: TEXT_DIM }} label={{ value: "Delta", position: "insideBottom", offset: -5, fill: TEXT_DIM, fontSize: 11 }} />
                        <YAxis dataKey="extrinsicPerDTE" name="Ext/DTE" tick={{ fontSize: 10, fill: TEXT_DIM }} label={{ value: "$/DTE", angle: -90, position: "insideLeft", fill: TEXT_DIM, fontSize: 11 }} />
                        <Tooltip content={({ active, payload }) => { if (!active || !payload?.length) return null; const d = payload[0]?.payload || {}; return (<div style={ttStyle}><div style={{ color: TEXT, fontWeight: 700, marginBottom: 6 }}>Strike ${(d.strike || 0).toFixed(1)}</div><div style={{ color: CYAN }}>Delta: {(d.delta || 0).toFixed(3)}</div><div style={{ color: GREEN }}>Ext/DTE: ${(d.extrinsicPerDTE || 0).toFixed(4)}</div></div>); }} />
                        <Scatter data={deltaVsExtrinsic}>{deltaVsExtrinsic.map((d, i) => <Cell key={i} fill={d.moneyness === "ITM" ? CYAN : d.moneyness === "ATM" ? ACCENT3 : ACCENT} fillOpacity={0.8} />)}</Scatter>
                      </ScatterChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Greeks */}
                {hasGreeks && greeksProfile.length > 0 && (
                  <div style={{ background: BG_CARD2, borderRadius: 10, padding: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: TEXT_DIM, marginBottom: 12, fontFamily: mono }}>Greeks Profile</div>
                    <ResponsiveContainer width="100%" height={280}>
                      <LineChart data={greeksProfile}>
                        <CartesianGrid strokeDasharray="3 3" stroke={BORDER} />
                        <XAxis dataKey="strike" tick={{ fontSize: 9, fill: TEXT_DIM }} angle={-45} textAnchor="end" height={50} />
                        <YAxis tick={{ fontSize: 10, fill: TEXT_DIM }} />
                        <Tooltip content={({ active, payload }) => { if (!active || !payload?.length) return null; const d = payload[0]?.payload || {}; return (<div style={ttStyle}><div style={{ color: TEXT, fontWeight: 700, marginBottom: 6 }}>Strike ${d.strike}</div><div style={{ color: CYAN }}>Delta: {(d.delta || 0).toFixed(4)}</div><div style={{ color: ACCENT2 }}>Gamma×100: {(d.gamma || 0).toFixed(4)}</div><div style={{ color: RED }}>Theta: {(d.theta || 0).toFixed(4)}</div><div style={{ color: ACCENT3 }}>Vega: {(d.vega || 0).toFixed(4)}</div></div>); }} />
                        <Line type="monotone" dataKey="delta" stroke={CYAN} strokeWidth={2} dot={false} name="Delta" />
                        <Line type="monotone" dataKey="gamma" stroke={ACCENT2} strokeWidth={1.5} dot={false} name="Gamma×100" />
                        <Line type="monotone" dataKey="theta" stroke={RED} strokeWidth={1.5} dot={false} name="Theta" />
                        <Line type="monotone" dataKey="vega" stroke={ACCENT3} strokeWidth={1.5} dot={false} name="Vega" />
                        <Legend wrapperStyle={{ fontSize: 11, fontFamily: mono }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* METHODOLOGY */}
          {rankedOptions && (
            <div className="slide-up" style={{ background: BG_CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28, marginBottom: 28 }}>
              <SectionTitle num="5" title="Methodology" subtitle="No model assumptions — pure market data" />
              <div style={{ fontSize: 14, color: TEXT_DIM, lineHeight: 1.8, maxWidth: 820 }}>
                <p style={{ margin: "0 0 14px" }}>
                  <strong style={{ color: TEXT }}>Prices are real market data</strong> from Yahoo Finance. Bid, ask, last price, volume, open interest, IV, and Greeks all come directly from the exchange — no Black-Scholes modeling.
                </p>
                <p style={{ margin: "0 0 14px" }}>
                  <strong style={{ color: TEXT }}>Extrinsic = Mid Price − max(0, Spot − Strike)</strong> — the pure time premium a seller captures if the option expires at current spot.
                </p>
                <div style={{ background: BG_CARD2, borderRadius: 8, padding: "16px 20px", fontFamily: mono, fontSize: 16, color: ACCENT, marginBottom: 16, textAlign: "center", border: `1px solid ${BORDER}` }}>
                  Efficiency = Extrinsic ÷ DTE ÷ |Delta|
                </div>
                <p style={{ margin: "0 0 14px" }}>
                  <strong style={{ color: TEXT }}>Why?</strong> For sellers, the ideal strike maximizes daily time decay relative to directional risk. Deep ITM has high extrinsic but near-1 delta. Far OTM has tiny delta but almost no premium. This score finds the sweet spot.
                </p>
                <p style={{ margin: 0 }}>
                  <strong style={{ color: TEXT }}>Annualized yield</strong> = (Extrinsic ÷ Strike) × (365 ÷ DTE) — the return rate if you sold this strike repeatedly at current prices.
                </p>
              </div>
            </div>
          )}
        </div>

        <div style={{ textAlign: "center", padding: "24px 0 48px", color: TEXT_DIM, fontSize: 11, fontFamily: mono }}>
          Options Extrinsic Value Analyzer · Real Yahoo Finance data · No model assumptions · Client-side
        </div>
      </div>
    </div>
  );
}

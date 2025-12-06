// renderer.js — HUD (Windows copy) with LLM one-liner + [1][2][3] refs + rich tooltips
console.log(">>> HUD renderer loaded from src/renderer/renderer.js");

// ---------- helpers ----------
function $(id) { return document.getElementById(id); }
function signClass(n) { if (n > 0) return "pos"; if (n < 0) return "neg"; return "neu"; }
function escapeHtml(s) {
  return String(s)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;");
}
function fmtPct(x, dp = 2) {
  return `${(x * 100).toFixed(dp)}%`;
}

// Remove "<CLASS>:" prefix & "Conf XX%" then tidy spacing
function stripClassAndConf(text, klass) {
  if (!text) return "—";
  let t = String(text);
  if (klass) {
    const rePrefix = new RegExp(
      "^\\s*" + klass.replace(/[-/\\^$*+?.()|[\\]{}]/g, "\\$&") + "\\s*:\\s*",
      "i"
    );
    t = t.replace(rePrefix, "");
  }
  t = t.replace(/\bConf\s+\d{1,3}%\.?/i, "");
  t = t.replace(/\s{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  return t || "—";
}
function capitalizeFirstWord(s) {
  if (!s) return s;
  const i = s.search(/[A-Za-z]/);
  if (i < 0) return s;
  return s.slice(0, i) + s.charAt(i).toUpperCase() + s.slice(i + 1);
}

// Clamp span/anchor text at a word boundary to fit `maxPx`
function truncateAtWord(el, fullText, maxPx) {
  el.textContent = fullText;
  if (el.scrollWidth <= maxPx) return;

  let lo = 0, hi = fullText.length, best = "…";
  while (lo < hi) {
    const mid   = (lo + hi) >> 1;
    const slice = fullText.slice(0, mid);
    const cut   = slice.lastIndexOf(" ");
    const cand  = (cut > 0 ? slice.slice(0, cut) : slice).trimEnd() + "…";
    el.textContent = cand;
    if (el.scrollWidth <= maxPx) {
      best = cand;
      lo   = mid + 1;
    } else {
      hi = mid;
    }
  }
  el.textContent = best;
}

// Re-clamp only the HEADLINE (now the LLM text span) based on available width
function clampHeadline() {
  const line = el.one;
  if (!line) return;

  const prefix   = line.querySelector(".one-prefix");
  const headline = line.querySelector(".one-headline"); // span
  if (!headline) return;

  const boxW  = line.clientWidth || 0;
  const prefW = prefix ? prefix.getBoundingClientRect().width : 0;
  const gap   = 0;

  const maxPx = Math.max(0, Math.floor(boxW - prefW - gap));
  if (maxPx <= 0) return;

  const full = headline.getAttribute("data-full") || headline.textContent || "";
  truncateAtWord(headline, full, maxPx);
}

// small helper for tooltips
function setTooltip(elm, html) {
  if (!elm) return;
  if (html == null || html === "") {
    elm.removeAttribute("data-tooltip");
  } else {
    elm.setAttribute("data-tooltip", html);
  }
}

// ---------- DOM refs (containers) ----------
const el = {
  ticker: $("ticker"),
  last: $("last"),
  ba: $("ba"),
  m1: $("m1"),
  m5: $("m5"),
  sma: $("sma"),
  sent: $("sentWrap") || $("sent"), // container that holds Sent/σ
  sigma: $("sigmaVal") || $("sigma"), // support both ids
  strat: $("strat"),
  bar: $("bar"),
  conf: $("conf"),
  one: $("one"),
  cache: $("cache"),
  hudInfo: $("hud-info"),
  validationPrompt: $("validationPrompt"),
};

// ---------- value spans (actual text nodes) ----------
const elVals = {
  // these ids come directly from your index.html
  last: $("last"),
  ba: $("ba"),
  m1: $("m1"),
  m5: $("m5"),
  sma: $("sma"),
  sent: $("sent"),
  sigma: $("sigma"),
  oneBox: $("one"),
  cache: $("cache"),
};

// ---------- config ----------
const GATEWAY_URL = "http://127.0.0.1:8015";
let currentTicker = null;
let isFetching = false;
let cacheTimer = null;
let cacheBaseAge = 0;
let caseStartMS = 0;

const STRAT_TOOLTIPS = {
  NO_ACTION:
    "<strong>No Action</strong><br>Model sees no clear edge. News and price action are mixed or weak; sitting out may be safest.",
  IRON_CONDOR:
    "<strong>Iron Condor</strong><br>Range-bound / IV watch. Model thinks price is likely to chop sideways; sell premium around the current level.",
  DEBIT_CALL:
    "<strong>Debit Call</strong><br>Directional bullish. Model sees upward edge with limited risk via a call or call spread.",
  DEBIT_PUT:
    "<strong>Debit Put</strong><br>Directional bearish. Model sees downward edge with limited risk via a put or put spread.",
  COVERED_CALL:
    "<strong>Covered Call</strong><br>Moderately bullish / income. Own shares and sell calls to harvest premium while expecting mild upside or flat price."
};

// ---------- validation ----------
function formatAndValidateTicker(raw) {
  const t = (raw || "").trim().toUpperCase();
  if (!t) return { ok: false, msg: "Please enter a ticker" };
  if (!/^[A-Z]{1,5}$/.test(t)) {
    return {
      ok: false,
      msg: "*Invalid ticker format. Use letters only (1-5 characters, e.g., AAPL).",
    };
  }
  return { ok: true, ticker: t };
}
function showValidationMessage(message, isError = true) {
  el.validationPrompt.textContent = message;
  el.validationPrompt.classList.remove("neutral");
  el.validationPrompt.style.color = isError ? "#FF5F57" : "#AAA";
  el.validationPrompt.classList.remove("hidden");
}
function clearValidationMessage() {
  el.validationPrompt.textContent = "";
  el.validationPrompt.classList.remove("neutral");
  el.validationPrompt.classList.add("hidden");
}

// ---------- networking ----------
async function fetchRun(ticker) {
  const res = await fetch(
    `${GATEWAY_URL}/api/run?ticker=${encodeURIComponent(ticker)}`,
    { cache: "no-store" }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------- HUD helpers ----------
function clearHud() {
  elVals.last.textContent   = "—";
  elVals.ba.textContent     = "B/A";
  elVals.m1.textContent     = "—";
  elVals.m5.textContent     = "—";
  elVals.sma.textContent    = "SMA20";
  elVals.sent.textContent   = "—";
  elVals.sigma.textContent  = "σ—";
  elVals.oneBox.textContent = "Loading…";
  elVals.cache.textContent  = "⟳—s";

  if (el.bar) el.bar.style.width = "0px";
  el.hudInfo.classList.remove("active");
  el.hudInfo.classList.add("hidden");
}

function render(payload) {
  const f    = payload?.features || {};
  const rec  = payload?.recommendation || {};
  const one  = payload?.one_liner || {};
  const q    = payload?.quote || null;
  const age  = payload?.cache_age_seconds;

  // Last / B&A
  if (q && typeof q.last === "number" && isFinite(q.last) && q.last > 0) {
    elVals.last.textContent = q.last.toFixed(2);
  } else {
    elVals.last.textContent = "—";
  }

  if (
    q &&
    q.bid != null &&
    q.ask != null &&
    isFinite(q.bid) &&
    isFinite(q.ask) &&
    q.ask > q.bid
  ) {
    elVals.ba.textContent = `${Number(q.bid).toFixed(2)}/${Number(q.ask).toFixed(2)}`;
  } else {
    elVals.ba.textContent = "B/A";
  }

  // Returns
  const r1 = typeof f.r_1m === "number" ? f.r_1m : null;
  const r5 = typeof f.r_5m === "number" ? f.r_5m : null;
  elVals.m1.textContent =
    r1 == null ? "—" : `1m ${(r1 >= 0 ? "+" : "")}${fmtPct(r1)}`;
  elVals.m5.textContent =
    r5 == null ? "—" : `5m ${(r5 >= 0 ? "+" : "")}${fmtPct(r5)}`;
  el.m1.className = `sec num ${signClass(r1 ?? 0)}`;
  el.m5.className = `sec num ${signClass(r5 ?? 0)}`;

  // SMA20
  const above = !!f.above_sma20;
  elVals.sma.textContent = above ? "↑" : "↓";
  $("sma").className = `sec muted ${above ? "pos" : "neg"}`;

  // Sentiment
  const sMean = typeof f.sent_mean === "number" ? f.sent_mean : null;
  const sStd  = typeof f.sent_std  === "number" ? f.sent_std  : null;
  elVals.sent.textContent  =
    sMean == null ? "—" : `${sMean >= 0 ? "+" : ""}${sMean.toFixed(2)}`;
  elVals.sigma.textContent =
    sStd == null ? "σ—" : `σ${sStd.toFixed(2)}`;

  // Sentiment tooltips
  const sentTip =
    "<strong>Sentiment</strong><br>" +
    "Mean news tone from recent headlines. Positive = bullish, negative = bearish. " +
    "Computed from FinBERT-style scores on top stories.";
  const sigmaTip =
    "<strong>Sentiment σ</strong><br>" +
    "Spread of news tone scores. High σ = disagreement across headlines; low σ = consensus. " +
    "Large σ often pushes the model toward NO_ACTION or range-bound stances.";
  setTooltip(el.sent, sentTip);
  setTooltip(el.sigma, sigmaTip);

  // Strategy badge + confidence
  const klass   = rec.class || "NA";
  const confPct = Math.round((rec.confidence ?? 0) * 100);
  el.strat.textContent = klass; // badge text
  el.bar.style.width   = `${Math.max(0, Math.min(100, confPct)) * 0.8}px`;
  el.conf.textContent  = Number.isFinite(confPct) ? `${confPct}%` : "—";

  // Strategy tooltips
  const stratBody = STRAT_TOOLTIPS[klass] ||
    "<strong>Strategy</strong><br>Model’s recommended posture based on short-term price action, trend, volatility, liquidity, and news tone.";
  setTooltip(el.strat, stratBody);

  const confBody = Number.isFinite(confPct)
    ? "<strong>Confidence</strong><br>" +
      `Calibrated probability for the chosen strategy (~${confPct}%). ` +
      "For example, 70% means about 7 of 10 similar setups historically matched this outcome."
    : "<strong>Confidence</strong><br>Calibration not available for this prediction.";
  setTooltip(el.conf, confBody);

  // ----- One-liner pieces (LLM text only + [1][2][3]) -----
  const rawLine   = one.text || "—";
  // Strip trailing "([1][2][3])" cluster if present
  const noRefsRaw = rawLine.replace(/\s*\(\[\d\]\[\d\]\[\d\]\)\s*$/, "");
  let cleaned     = stripClassAndConf(noRefsRaw, klass);
  cleaned         = capitalizeFirstWord(cleaned);
  const display   = cleaned || "—";

  // Build prefix + LLM line into #oneBox (prefix kept empty for clampHeadline)
  elVals.oneBox.innerHTML =
    `<span class="one-prefix"></span>` +
    `<span class="one-headline" data-full="${escapeHtml(display)}">` +
    `${escapeHtml(display)}</span>`;

  // Append [1][2][3] indices from one_liner.refs_numbers
  const refsNums = Array.isArray(one.refs_numbers) ? one.refs_numbers : [];
  if (refsNums.length) {
    const refsSpan = document.createElement("span");
    refsSpan.className = "one-refs";
    refsSpan.style.marginLeft = "4px";

    refsNums.forEach((ref, idx) => {
      if (!ref || !ref.n) return;
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = `[${ref.n}]`;
      a.className = "src-link";
      if (ref.url) {
        a.setAttribute("data-external", ref.url);
      }

      if (idx === 0) {
        refsSpan.appendChild(document.createTextNode(" "));
      } else {
        refsSpan.appendChild(document.createTextNode(", "));
      }
      refsSpan.appendChild(a);
    });

    refsSpan.appendChild(document.createTextNode(""));
    elVals.oneBox.appendChild(refsSpan);
  }

  // One-liner tooltip
  const oneTip =
    "<strong>One-line summary</strong><br>" +
    "Compact LLM summary of price action, volatility, trend, sentiment and risk posture. " +
    "Indices [1][2][3] jump to the specific headlines that informed this view.";
  setTooltip(el.one, oneTip);

  // Click-through for index links (any anchor with data-external)
  if (!el.one._wired) {
    el.one.addEventListener("click", (ev) => {
      const a = ev.target.closest("a[data-external]");
      if (!a) return;
      ev.preventDefault();
      const href = a.getAttribute("data-external");
      if (href) {
        if (window.electronAPI?.openExternal) {
          window.electronAPI.openExternal(href);
        } else {
          window.open(href, "_blank");
        }
      }
    });
    el.one._wired = true;
  }

  // Cache age: live "data staleness" counter
  if (typeof age === "number" && age >= 0) {
    cacheBaseAge = age;
    cacheStartMs = Date.now();

    if (cacheTimer) clearInterval(cacheTimer);

    const updateCache = () => {
      const dt = Math.floor((Date.now() - cacheStartMs) / 1000);
      const val = Math.max(0, cacheBaseAge + dt);
      elVals.cache.textContent = `⟳${val}s`;
    };

    updateCache();
    cacheTimer = setInterval(updateCache, 1000);
  } else {
    if (cacheTimer) { clearInterval(cacheTimer); cacheTimer = null; }
    cacheBaseAge = 0;
    cacheStartMs = 0;
    elVals.cache.textContent = "⟳—s";
  }

  setTooltip(
    el.cache,
    "<strong>Refresh Age</strong><br>" +
    "Approximate time since this snapshot was computed on the backend. " +
    "Counts up until you refresh the ticker."
  );
  
  // Show HUD row then clamp HEADLINE only
  el.hudInfo.classList.remove("hidden");
  el.hudInfo.classList.add("active");
  requestAnimationFrame(clampHeadline);
}

// ---------- main handler ----------
async function handleEnter() {
  const v = formatAndValidateTicker(el.ticker.textContent);

  if (!v.ok) {
    showValidationMessage(v.msg, true);
    el.ticker.classList.add("invalid");
    clearHud();
    currentTicker = null;
    return;
  }

  clearValidationMessage();
  el.ticker.classList.remove("invalid");

  if (isFetching) return;
  if (currentTicker === v.ticker) return;
  currentTicker = v.ticker;

  try {
    isFetching = true;
    const payload = await fetchRun(currentTicker);
    render(payload);
  } catch (err) {
    console.error(err);
    showValidationMessage(
      "*Unable to fetch data. Is the gateway running on 8015?",
      true
    );
    clearHud();
    currentTicker = null;
  } finally {
    isFetching = false;
  }
}

// ---------- boot ----------
document.addEventListener("DOMContentLoaded", () => {
  el.validationPrompt.textContent =
    "Welcome to MIDAS! Enter a ticker symbol to begin.";
  el.validationPrompt.classList.add("neutral");

  el.ticker.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      handleEnter();
    }
  });

  // Re-clamp headline when window width changes
  window.addEventListener("resize", () =>
    requestAnimationFrame(clampHeadline)
  );
});

// ---------- Tooltip hover handler ----------
const tooltip = $("tooltip");
let tooltipTimer = null;

document.body.addEventListener("mouseover", (ev) => {
  if (!tooltip) return;  // guard for missing tooltip element
  const target = ev.target.closest("[data-tooltip]");
  if (!target) return;
  const text = target.getAttribute("data-tooltip");
  if (!text) return;

  tooltipTimer = setTimeout(() => {
    tooltip.innerHTML = text;
    tooltip.style.opacity = "1";
    tooltip.style.transform = "translateY(0)";
  }, 2000);
});

document.body.addEventListener("mousemove", (ev) => {
  if (!tooltip) return;  // guard

  const hud = document.getElementById("hud");
  if (!hud) return;
  const hudRect = hud.getBoundingClientRect();

  // Desired position relative to HUD
  let x = ev.pageX - hudRect.left + 12;
  let y = ev.pageY - hudRect.top + 12;

  // Clamp horizontally so tooltip stays inside HUD width
  const tooltipWidth = tooltip.offsetWidth || 200; // fallback if not measured yet
  const maxX = hudRect.width - tooltipWidth - 8;
  if (x > maxX) x = Math.max(8, maxX);
  if (x < 8) x = 8;

  tooltip.style.left = x + "px";
  tooltip.style.top  = y + "px";
});


document.body.addEventListener("mouseout", () => {
  if (!tooltip) return;  // guard
  clearTimeout(tooltipTimer);
  tooltip.style.opacity  = "0";
  tooltip.style.transform = "translateY(4px)";
});

// ================================================================
// LIVE DATA PIPELINE — reads the 5 source tabs directly from the
// "MustClose2026_DataSource_for Claude" Google Sheet through the
// viewer's own Google Sheets/Drive connector (window.claude.mcp),
// authenticated as whoever has the artifact open. No Apps Script
// relay, no JSONP, no client-side API keys.
// ================================================================
const REFRESH_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours, matching the sheet's own refresh cadence

// ---------------- CSV-style row parsing (shared with 2D arrays returned by the connector) ----------------
function rowsToObjects(rows) {
  if (!rows || !rows.length) return [];
  const header = rows[0].map(h => (h || "").trim());
  return rows.slice(1).map(r => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : ""; });
    return obj;
  });
}


// ---------------- Shared helpers (mirrors build_data.py) ----------------
const TODAY = new Date();
TODAY.setHours(0, 0, 0, 0);
const YEAR_END_2026 = new Date(2026, 11, 31);
const RAMP_DAYS = 60;
const AVG_DAYS_PER_MONTH = 365.25 / 12;
const TRADING_PRODUCTS_NORM = ["trading spot (hold)", "trading spot (a1)", "trading derivatives (a1)", "trading margin (a1)"];
const ACTIVE_CASE_STATUSES = new Set(["Pending", "Open", "On Hold", "In Progress", "New"]);
const CONTRACT_ACTIVE_THRESHOLD = 21;
const RAMP_WINDOW_DAYS = 180; // rep ramp signal -- see note on repMap below

function norm(s) {
  return (s || "").trim().replace(/\s*\(Parent Account\)\s*$/i, "").toLowerCase().trim();
}
function parseDate(s) {
  s = (s || "").trim();
  if (!s) return null;
  s = s.split(" ")[0];
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(+m[3], +m[1] - 1, +m[2]);
  return isNaN(d.getTime()) ? null : d;
}
function parseDateTime(s) {
  s = (s || "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM))?$/i);
  if (!m) return parseDate(s);
  let hour = m[4] ? parseInt(m[4], 10) : 0;
  const minute = m[5] ? parseInt(m[5], 10) : 0;
  if (m[6]) {
    const ampm = m[6].toUpperCase();
    if (ampm === "PM" && hour !== 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;
  }
  const d = new Date(+m[3], +m[1] - 1, +m[2], hour, minute);
  return isNaN(d.getTime()) ? null : d;
}
function daysBetween(a, b) {
  return Math.floor((a - b) / 86400000);
}
function money(s) {
  if (s === null || s === undefined) return 0;
  s = String(s).replace(/\$/g, "").replace(/,/g, "").trim();
  if (!s || s === "N/A" || s === "-") return 0;
  const neg = s.startsWith("-");
  s = s.replace(/^-/, "");
  const v = parseFloat(s);
  if (isNaN(v)) return 0;
  return neg ? -v : v;
}
function normalizeProductToken(s) {
  return (s || "").toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ").trim();
}
function parseProductLine(raw) {
  // Handles both formats seen across exports: a semicolon-separated string
  // (older exports) and a JSON-array-literal string like '["Custody","Trading  Spot (A1)"]'
  // (note the double space, not a dash -- current export format).
  raw = (raw || "").trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(p => String(p).trim()).filter(Boolean);
    } catch (e) {
      // fall through to manual split
      return raw.replace(/^\[|\]$/g, "").split(",").map(p => p.replace(/^"|"$/g, "").trim()).filter(Boolean);
    }
  }
  return raw.split(";").map(p => p.trim()).filter(Boolean);
}
function isTrading(productLineRaw) {
  const parts = parseProductLine(productLineRaw);
  return parts.some(p => TRADING_PRODUCTS_NORM.includes(normalizeProductToken(p)));
}
function recencyScore(days) {
  if (days === null || days === undefined) return 0;
  if (days <= 14) return 100;
  if (days <= 30) return 80;
  if (days <= 60) return 60;
  if (days <= 90) return 40;
  if (days <= 180) return 20;
  return 5;
}
function likelihoodBucket(prob, daysSinceTouch, hasOpp, hasIronclad, daysSinceWorkflowModified,
                           hasCase, isCaseActive, caseStatus, daysSinceCaseModified) {
  if (hasCase && isCaseActive) {
    if (caseStatus === "On Hold") return "Onboarding - Stalled";
    if (daysSinceCaseModified !== null && daysSinceCaseModified <= CONTRACT_ACTIVE_THRESHOLD) return "Onboarding - Active";
    return "Onboarding - Stalled";
  }
  if (hasIronclad && daysSinceWorkflowModified !== null) {
    return daysSinceWorkflowModified <= CONTRACT_ACTIVE_THRESHOLD ? "Contract Negotiation - Active" : "Contract Negotiation - Stalled";
  }
  if (!hasOpp) return "No Opportunity";
  if (daysSinceTouch === null || daysSinceTouch > 120) return "Stalled";
  if (prob >= 50 && daysSinceTouch <= 30) return "Hot";
  if (prob >= 25 || daysSinceTouch <= 60) return "Warm";
  return "Cold";
}
function realizable2026Revenue(y1Revenue, probability, closeDateStr) {
  const closeDt = parseDate(closeDateStr);
  if (!closeDt || !y1Revenue || !probability) return [0, 0];
  const rampEnd = new Date(closeDt.getTime() + RAMP_DAYS * 86400000);
  const daysRemaining = daysBetween(YEAR_END_2026, rampEnd);
  let proRationMonths = daysRemaining / AVG_DAYS_PER_MONTH;
  proRationMonths = Math.max(0, Math.min(12, proRationMonths));
  const monthlyRate = y1Revenue / 12.0;
  const realizable = monthlyRate * (probability / 100.0) * proRationMonths;
  return [realizable, proRationMonths];
}

// ---------------- Opportunity origin classification (mirrors build_data.py classify_origin) ----------------
// Combines Lead Source, Type, and Discovery Meeting Booked By (the BDR who sourced the
// discovery call) into the four buckets RevOps actually cares about: BDR-sourced outbound,
// inbound, event, referral, or existing-client expansion. "Discovery Meeting Booked Date"
// exists as a column but is blank across the export, so Created Date is used instead for
// cycle-start (see cycleMaturity below), not this classification.
function classifyOrigin(leadSource, oppType, discoveryBookedBy) {
  leadSource = (leadSource || "").trim();
  oppType = (oppType || "").trim();
  discoveryBookedBy = (discoveryBookedBy || "").trim();
  if (oppType === "Add-On Business" || oppType === "Renewal (Porto)" || leadSource === "Existing Client") return "Existing Client / Expansion";
  if (leadSource === "Event") return "Event";
  if (["Referral - Employee", "Referral - Customer", "Referral - Partner"].includes(leadSource)) return "Referral";
  if (leadSource === "Website - Contact Us Form") return "Inbound";
  if (["Sales Prospected", "Outbound - Cross Sell"].includes(leadSource)) return "BDR Outbound";
  if (["AdvizorPro", "LinkedIn Sales Navigator", "Purchased List"].includes(leadSource)) return "Prospecting List";
  if (discoveryBookedBy) return "BDR Outbound";
  return "Not Logged";
}

// ---------------- Cohort / cycle-maturity model (mirrors build_data.py cycle_maturity) ----------------
// Rather than assume a single universal cycle length for every deal, this uses each
// opportunity's OWN forecasted Close Date as its planned cycle boundary: cycle_day = how
// long it's actually been open (Created Date to today); cycle_total = how long the rep's
// own forecast said it would take (Created Date to Close Date). Every deal is judged
// against its own plan, not an arbitrary universal benchmark.
function cycleMaturity(createdDateStr, closeDateStr) {
  const created = parseDate(createdDateStr);
  const close = parseDate(closeDateStr);
  if (!created || !close) return [null, null, "Unknown"];
  const cycleDay = daysBetween(TODAY, created) * -1; // (TODAY - created) in days
  const cycleTotal = daysBetween(close, created) * -1; // (close - created) in days
  if (cycleTotal <= 0) return [cycleDay, cycleTotal, "Unknown"];
  const status = cycleDay <= cycleTotal ? "Maturing" : "Past Window";
  return [cycleDay, cycleTotal, status];
}

// ---------------- Real Slack findings (static — from live research run in-session) ----------------
const SLACK_FINDINGS = {
  "Uphold": { found: true, summary: "Chris Hunt Slack update (6/15): catching up with the client contact on the lending piece. Separately, the company-wide biweekly pipeline review flagged this $105M opportunity as the single biggest red flag in the pipeline, due to a vague \"WIP\" next-steps note — a stakeholder-alignment problem, not a data or activity gap.", effective_last_touch_date: "6/15/2026", blocker_flag: true, checked_date: "2026-07-28" },
  "Capital Group": { found: false, summary: "No account-specific mentions found in searchable Slack history — the only matches were for an unrelated company (\"Ault Capital Group\"). Consistent with the Stalled status already shown from Salesforce.", checked_date: "2026-07-28" },
  "Stellar": { found: false, summary: "No sales/deal-specific mentions found. All matches were engineering chatter about the Stellar blockchain protocol integration, unrelated to this account relationship.", checked_date: "2026-07-28" },
  "Internet Computer": { found: true, summary: "Confirms a ~$4M opportunity value from an internal accountability KPI tracking thread (3/13). No deal-specific Slack activity found since then — about 4.5 months stale, consistent with the Onboarding-Stalled status shown.", checked_date: "2026-07-28" },
  "ReserveOne": { found: true, summary: "Possible active legal redline activity today (7/28) in the Ironclad negotiations channel — detailed contract comments on custody/control-agreement terms. The message didn't explicitly name the account, so treat this as a lead to confirm manually rather than a certain match.", effective_last_touch_date: "7/28/2026", tentative: true, checked_date: "2026-07-28" },
  "Itau Unibanco S.A": { found: true, summary: "Real bottleneck found: Ops flagged (6/9) that this account has multiple duplicate custody opportunities, including one owned by Manuel Andreani with no Product Line populated at all. Daniel Marques acknowledged the same day; no confirmation in Slack that it was ever cleaned up.", blocker_flag: true, data_quality_flag: true, checked_date: "2026-07-28" },
  "Banking Circle S.A.": { found: false, summary: "No account-specific mentions found — matches were about \"Banking Circle\" as a third-party exchange/counterparty referenced in trading infrastructure, not this sales relationship.", checked_date: "2026-07-28" },
  "BTG Pactual": { found: true, summary: "Real ownership mismatch: assigned to Danny Marques in the must-close list, but Salesforce's Account Owner and Opportunity Owner are both Monica Ramirez de Arellano (flagged internally 7/10, unresolved as of this check) — same dual-coverage pattern as Bradesco (Stablecoin + Direct Custody both targeting it). On the positive side, Danny noted (6/9) Monica was actively \"working thru DDQs,\" and the account was shortlisted (7/23) for a Global Markets client dinner on Aug 12 — real relationship investment despite the ownership confusion.", effective_last_touch_date: "7/23/2026", blocker_flag: true, checked_date: "2026-07-29" },
  "Monarq Asset Managment": { found: true, summary: "Genuinely active, just not logged in Salesforce: Xochitl Ivory's biweekly Slack pipeline updates show continuous real engagement — proposal sent (6/1), IRL meeting awaiting a QC update (6/15), \"navigating org changes\" (7/2), and most recently (7/17) \"still working through changes on their end; coordinating an in-person meeting to move this forward.\" This is a Salesforce-logging gap, not a stalled deal.", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-29" },
  "Digital Farm GmbH (RockawayX)": { found: true, summary: "Real named blocker (7/19, Nicolas Bucspun): lost a ~$2mm notional XRP short-straddle trade because Anchorage's initial margin requirement was higher than competitors' terms — a pricing/competitiveness issue, not a lack of engagement. Separate relationship-building activity (indicative pricing on alt call spreads) is ongoing via the RockawayX/Solmate VC channel.", effective_last_touch_date: "7/19/2026", blocker_flag: true, checked_date: "2026-07-29" },
  "Republic Labs": { found: true, summary: "Likely data-quality issue rather than a stalled deal: internal ops flagged (7/10) that \"Republic digital\" — presumably this account — doesn't match any existing Account ID in Salesforce under Danny Marques, and asked him to confirm the exact name or create the account. No further resolution found in Slack.", blocker_flag: true, data_quality_flag: true, checked_date: "2026-07-29" },
  "Symbiotic": { found: false, summary: "No recent sales-specific mentions found. The only relevant thread is from May 2025 (~14 months ago) about restaking-vault integration discussions — confirms this is genuinely stale, not a Salesforce blind spot.", checked_date: "2026-07-29" },
  "CoinShares": { found: false, summary: "No account-specific mentions found in searchable Slack history for this relationship.", checked_date: "2026-07-29" },
  "Single Family Office (Digital Wealth Partners)": { found: true, summary: "Probable match, not certain: Xochitl Ivory's pipeline updates reference a \"Digital Wealth Group\" SFO opportunity with real recent activity (met with CEO and President in person, drafting a commercial proposal, most recently 7/17 \"still working through first potential SFO opportunity\") — likely the same relationship as this account given the name overlap and shared owner, but the naming doesn't match exactly so treat as a lead to confirm.", effective_last_touch_date: "7/17/2026", tentative: true, checked_date: "2026-07-29" },
  "APEX Group": { found: true, summary: "Found in #always-be-closing biweekly update from Michael Pennella (2026-07-16): Progress: WisdomTree — meetings on Atlas Settlement and KYC, commercial proposal sent. ProShares — intro'd to Stables team, will trade Q4 with swaps dealer license. Apex Group — signed NDA, exploring QC. A&M — multiple meetings on Custody and stables. Ava Labs — exploring distribution for tokenized assets. Ondo — initial intro call. Spherepay — intro meeting next week for USDT trading.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Altitude Development Partners": { found: true, summary: "Found in #always-be-closing biweekly update from Bryan Chong (2026-07-16): Onboarding: Altitude Development Partners — PSA countersigned July 14. Angelo Latassa (HNWI) — kicked off A1 OTC onboarding.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Alvarez & Marsal": { found: true, summary: "Found in #always-be-closing biweekly update from Michael Pennella (2026-07-02): WisdomTree — negotiating commercials. Portal VC — agreed Porto + QC + Fiat Banking. APEX Group — building crypto business, NDA signed. Ondo — connected with head of institutional. Alvarez & Marsal — custody + stables sessions. ProShares — follow up set. Hilgard — met founder, wants to allocate to custody. Tplus — Tri party discussion.", effective_last_touch_date: "7/2/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "AtomicVest": { found: true, summary: "Found in #always-be-closing biweekly update from Kyle Clark (2026-07-17): Frank Seitz: Verbal Commit: AtomicVest; Doc Signed: Baxter Capital", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Avalanche Foundation": { found: true, summary: "Found in #always-be-closing biweekly update from Ryan Brown (2026-07-17): Verbal Commits: Ripple came back offering $500k to cut scope down to first token standard (IOU tokens, 4-6 weeks). Pearl (Bitcoin-like L1) interested. Movement onboarding new Labs entity. Aztec interested in Anchorage supporting their chain w/ Ethena stablecoin. Cardano governance vote passed for Critical Integrations Budget. Blockstream interested in Anchorage supporting Liquid. Re Foundation amending contract +$5k/month ", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "BRD Capital": { found: true, summary: "Found in #always-be-closing biweekly update from Danny Marques (2026-07-16): Signed: BRD Capital - MSA signed, PSA pending.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Bank of America": { found: true, summary: "Found in #always-be-closing biweekly update from Britton Wyckoff (2026-07-15): Western Union — quarterly USDPT compliance checks. Wells Fargo — cross functional presentation. State Street — SWEEP/ETF flows. Bank of America — deep dive on whitepaper. JPM — sandbox testing alignment. Blackrock — A1 onboarding to iShares.", effective_last_touch_date: "7/15/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Blockstream": { found: true, summary: "Found in #always-be-closing biweekly update from Ryan Brown (2026-07-17): Verbal Commits: Ripple came back offering $500k to cut scope down to first token standard (IOU tokens, 4-6 weeks). Pearl (Bitcoin-like L1) interested. Movement onboarding new Labs entity. Aztec interested in Anchorage supporting their chain w/ Ethena stablecoin. Cardano governance vote passed for Critical Integrations Budget. Blockstream interested in Anchorage supporting Liquid. Re Foundation amending contract +$5k/month ", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Blue Bank International": { found: true, summary: "Found in #always-be-closing biweekly update from Noah Goebel (2026-07-17): PSA/Docs: Blue Bank International — PSA signed July 8.", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Bradesco": { found: true, summary: "Found in #always-be-closing biweekly update from Chris Hunt (2026-07-17): Bradesco - ISDA being reviewed by our team, should have comments by end of next week", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Cardano": { found: true, summary: "Found in #always-be-closing biweekly update from Ryan Brown (2026-07-17): Verbal Commits: Ripple came back offering $500k to cut scope down to first token standard (IOU tokens, 4-6 weeks). Pearl (Bitcoin-like L1) interested. Movement onboarding new Labs entity. Aztec interested in Anchorage supporting their chain w/ Ethena stablecoin. Cardano governance vote passed for Critical Integrations Budget. Blockstream interested in Anchorage supporting Liquid. Re Foundation amending contract +$5k/month ", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "CargoBill": { found: true, summary: "Found in #always-be-closing biweekly update from Kyle Clark (2026-07-02): Kyle Clark: Verbal Commit Platform-D, CargoBill, SolidusLink. Doc Signed: Quantfury, Petra Strata, Tetra Trust, XFX Capital. Deposits: $200M+ BTC (3iQ), $100M+ SWEEP mint.", effective_last_touch_date: "7/2/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Chain Reaction Capital": { found: true, summary: "Found in #always-be-closing biweekly update from Tucker Piner (2026-07-16): Verbal: Nordark (Birka BVI) — $150M ACA opp. Chain Reaction Capital — $12M USD deposit. BitHedge — $40M BTC only fund. Erebor — $20M lending opp.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Coin Re": { found: true, summary: "Found in #always-be-closing biweekly update from Sara Finnegan (2026-07-16): Verbal: Coin Re — $350M BTC yield product, docs being prepped, inquiring about Tri-Party. Arkonix — ACA discussions ~$50M triparty. TPG Payments — sent for signature. DoubleZero — verbal commitment, starting KYC.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Comma Partners": { found: true, summary: "Found in #always-be-closing biweekly update from Chris Hunt (2026-07-02): Verbal: SOL Foundation ISDA received. Lauvar 500 BTC AUC yield opp. Ornn compute trading firm. Bradesco ISDA in our court. Archimedes onboarded, XLM whale. Pave Bank, Bitso, Bitrus A1 follow ups. Comma Partners OTC options/spot call set up.", effective_last_touch_date: "7/2/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Deploy Finance": { found: true, summary: "Found in #always-be-closing biweekly update from Chris Wilson (2026-07-16): Onboarding/KYC: Drivvy, Rift, Umbra, Deploy finance, Onrail, Resolvr finance, Midl BTC, Hinkal, Bondl Finance, Eikeden protocol, Ault Capital (~$2.5m/yr), Bmax rwa, Salomon Brothers ($10k monthly mins), Resolv protocol, Squid protocol, Hello Trade, Fish Network", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Drivvy": { found: true, summary: "Found in #always-be-closing biweekly update from Chris Wilson (2026-07-16): Onboarding/KYC: Drivvy, Rift, Umbra, Deploy finance, Onrail, Resolvr finance, Midl BTC, Hinkal, Bondl Finance, Eikeden protocol, Ault Capital (~$2.5m/yr), Bmax rwa, Salomon Brothers ($10k monthly mins), Resolv protocol, Squid protocol, Hello Trade, Fish Network", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Ethena Labs": { found: true, summary: "Found in #always-be-closing biweekly update from Ryan Brown (2026-07-17): Onboarding/KYC: Ethena Labs USD custody (~$10m), eOracle, Chainopera, Morph Foundation, Olivetree", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Etherealize": { found: true, summary: "Found in #always-be-closing biweekly update from Xochitl Ivory (2026-07-17): Progressing: Canary Capital (~$200M custody opp) — caught up with CEO Steve at Injective Summit. Monarq Asset Management ($200M custody) + Katana ($50M custody) — still working through changes on their end, coordinating in-person meeting. Digital Wealth Group ($100M ETH custody/staking) — still working through first potential SFO opportunity. Halo Capital ($24M ZEC custody) — shared ZEC support timeline. W. Diamond (HNW", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Ethereum Enterprise Alliance": { found: true, summary: "Found in #always-be-closing biweekly update from Xochitl Ivory (2026-07-02): Signed: Tradable — $2M Stellar trade. Ethereum Enterprise Alliance — MSA signed.", effective_last_touch_date: "7/2/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Ethereum Institutional": { found: true, summary: "Found in #always-be-closing biweekly update from Ryan Porter (2026-07-16): Verbal: Marex — pending pricing negotiation. Barclays — new hires, opened custody/trading/tokenized repo discussion. Field Digital — PubCo, positive convo on PIPE contributions custody/trading. Kazahkstan National Investment Fund — positive convo on AM allocation. WealthSimple — exploring custody/trading counterparty. Itau — completed institutional DDQ, pending review. Ethereum Institutional — verbal agreement on commerci", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Fish Network": { found: true, summary: "Found in #always-be-closing biweekly update from Chris Wilson (2026-07-16): Onboarding/KYC: Drivvy, Rift, Umbra, Deploy finance, Onrail, Resolvr finance, Midl BTC, Hinkal, Bondl Finance, Eikeden protocol, Ault Capital (~$2.5m/yr), Bmax rwa, Salomon Brothers ($10k monthly mins), Resolv protocol, Squid protocol, Hello Trade, Fish Network", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Fractal Protocol": { found: true, summary: "Found in #always-be-closing biweekly update from Chris Wilson (2026-06-30): Doc Signed: Fractal protocol.", effective_last_touch_date: "6/30/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Halo Capital": { found: true, summary: "Found in #always-be-closing biweekly update from Xochitl Ivory (2026-07-17): Progressing: Canary Capital (~$200M custody opp) — caught up with CEO Steve at Injective Summit. Monarq Asset Management ($200M custody) + Katana ($50M custody) — still working through changes on their end, coordinating in-person meeting. Digital Wealth Group ($100M ETH custody/staking) — still working through first potential SFO opportunity. Halo Capital ($24M ZEC custody) — shared ZEC support timeline. W. Diamond (HNW", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Hard Yaka": { found: true, summary: "Found in #always-be-closing biweekly update from Ryan Porter (2026-07-01): Verbal: Paradigm — HYPE Linking. American Bitcoin — auto-liquidation setup. Marex — OES follow up w/ Binance. SharpLink — $200m Lido wstETH. VANA — ADB account setup. USBC — re-opened options trading conversations. Hard Yaka — custody for Venture Fund. Ethereum Institutional — verbal commit. Avalanche Treasury Company — second ACA w/ Galaxy.", effective_last_touch_date: "7/1/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Hashdex": { found: true, summary: "Found in #always-be-closing biweekly update from Danny Marques (2026-07-16): Progressing: Sentient Capital - back off vs BITGO. Hashdex - negotiating pricing. Republic Digital - custody of venture and tokenized RWA, vault integration w/ Hamilton Lane. Weekend fund - SYND TGE deal.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Hashkey Cloud": { found: true, summary: "Found in #always-be-closing biweekly update from Eric Ln (2026-07-16): Verbal Commit: HashKey Cloud staking partnership (Solana, Near, Aptos), ~$300K/3yr. HCTI (largest Chinese-backed securities broker HK) - Atlas TRS. Competing for Binance United Stablecoin custody vs BitGo.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Helix": { found: true, summary: "Found in #always-be-closing biweekly update from Michael Pennella (2026-07-16): Verbal: Helix — In KYC, needs 2 weeks. SwapGlobal — going through KYC. Portal Ventures — trial ends 7/26.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "HyperLend": { found: true, summary: "Found in #always-be-closing biweekly update from Jack Rosenthal (2026-07-16): Docs Signed: Primedelta ($15k/month, 3yr, $435K min). LLLTans signed MSA. AlphaEV x Hyperlend ACA, $2.5M HYPE deposited. CMBT (Ezra Chairez) MSA signed. Lockbox Foundation (Ezra Chairez) MSA signed.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Indodax": { found: true, summary: "Found in #always-be-closing biweekly update from Aaron Thian (2026-07-16): Verbal: Binance Fiat account (w/ Jack Rosenthal) - 3 entities KYC done. Gopae Holdings (FO of Libertus Capital) - onboarding ADB fiat, ~5m deposit. Indodax - structured product discovery.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Janus Henderson": { found: true, summary: "Found in #always-be-closing biweekly update from Kyle Clark (2026-07-17): Kyle Clark: Verbal Commit: Janus Henderson, Satstreet; Doc Signed: Truist, YSC Digital Assets; Blocker: Union Bank & Trust (product, pricing)", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Katana": { found: true, summary: "Found in #always-be-closing biweekly update from Xochitl Ivory (2026-07-17): Progressing: Canary Capital (~$200M custody opp) — caught up with CEO Steve at Injective Summit. Monarq Asset Management ($200M custody) + Katana ($50M custody) — still working through changes on their end, coordinating in-person meeting. Digital Wealth Group ($100M ETH custody/staking) — still working through first potential SFO opportunity. Halo Capital ($24M ZEC custody) — shared ZEC support timeline. W. Diamond (HNW", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Lockbox Foundation": { found: true, summary: "Found in #always-be-closing biweekly update from Jack Rosenthal (2026-07-16): Docs Signed: Primedelta ($15k/month, 3yr, $435K min). LLLTans signed MSA. AlphaEV x Hyperlend ACA, $2.5M HYPE deposited. CMBT (Ezra Chairez) MSA signed. Lockbox Foundation (Ezra Chairez) MSA signed.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Marex": { found: true, summary: "Found in #always-be-closing biweekly update from Ryan Porter (2026-07-16): Verbal: Marex — pending pricing negotiation. Barclays — new hires, opened custody/trading/tokenized repo discussion. Field Digital — PubCo, positive convo on PIPE contributions custody/trading. Kazahkstan National Investment Fund — positive convo on AM allocation. WealthSimple — exploring custody/trading counterparty. Itau — completed institutional DDQ, pending review. Ethereum Institutional — verbal agreement on commerci", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Mercado Bitcoin": { found: true, summary: "Found in #always-be-closing biweekly update from Noah Goebel (2026-07-17): Actively working: Eigen — derivatives onboarding, ~$2M/month covered call flow. AAVE — engaged OTC desk for Spot and Forwards, ~$5.5M exotic AVAX trigger forward. Mercado Bitcoin — KYC apps submitted, DDQ initiated, pipeline value ~$1.032M. Trillion Digital — $500K margin/lending opp in Discovery. Twinstake — Proposal & Negotiation, ISDA/PSA drafting. ParaFi — onboarding entities to A1.", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "OAC Capital Advisors": { found: true, summary: "Found in #always-be-closing biweekly update from Kyle Clark (2026-07-02): Frank Seitz: Verbal Commit AsterisQ, NX Treasury, Outwing Wealth, Baxter Capital, OAC Capital Advisors, Octogone Advisors. Doc Signed: Solitude Wealth Management.", effective_last_touch_date: "7/2/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Olowolafe Family": { found: true, summary: "Found in #always-be-closing biweekly update from Xochitl Ivory (2026-07-17): Progressing: Canary Capital (~$200M custody opp) — caught up with CEO Steve at Injective Summit. Monarq Asset Management ($200M custody) + Katana ($50M custody) — still working through changes on their end, coordinating in-person meeting. Digital Wealth Group ($100M ETH custody/staking) — still working through first potential SFO opportunity. Halo Capital ($24M ZEC custody) — shared ZEC support timeline. W. Diamond (HNW", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Onrail": { found: true, summary: "Found in #always-be-closing biweekly update from Chris Wilson (2026-07-16): Onboarding/KYC: Drivvy, Rift, Umbra, Deploy finance, Onrail, Resolvr finance, Midl BTC, Hinkal, Bondl Finance, Eikeden protocol, Ault Capital (~$2.5m/yr), Bmax rwa, Salomon Brothers ($10k monthly mins), Resolv protocol, Squid protocol, Hello Trade, Fish Network", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "OpenFX": { found: true, summary: "Found in #always-be-closing biweekly update from Chris Hunt (2026-07-17): OpenFX - met with Head of Americas on Wednesday - PSA is out to them. Danny Marques working custody/banking angle, $12k month committed.", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Paimon Fund LP": { found: true, summary: "Found in #always-be-closing biweekly update from Ryan Brown (2026-07-01): Negotiating with Near Intents team on native Porto integration. Onboarding: Lightblocks, eOracle, Olivetree. Doc Signed: Stellar $45m deposit, Paimon Fund LP, Raise protocol, Re protocol ($300m deposit, Hedgey).", effective_last_touch_date: "7/1/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Pave Bank": { found: true, summary: "Found in #always-be-closing biweekly update from Chris Hunt (2026-07-17): Pave Bank - PSA out to them waiting for comments", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Pearl": { found: true, summary: "Found in #always-be-closing biweekly update from Ryan Brown (2026-07-17): Verbal Commits: Ripple came back offering $500k to cut scope down to first token standard (IOU tokens, 4-6 weeks). Pearl (Bitcoin-like L1) interested. Movement onboarding new Labs entity. Aztec interested in Anchorage supporting their chain w/ Ethena stablecoin. Cardano governance vote passed for Critical Integrations Budget. Blockstream interested in Anchorage supporting Liquid. Re Foundation amending contract +$5k/month ", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Pharos": { found: true, summary: "Found in #always-be-closing biweekly update from Ryan Brown (2026-07-17): Verbal Commits: Ripple came back offering $500k to cut scope down to first token standard (IOU tokens, 4-6 weeks). Pearl (Bitcoin-like L1) interested. Movement onboarding new Labs entity. Aztec interested in Anchorage supporting their chain w/ Ethena stablecoin. Cardano governance vote passed for Critical Integrations Budget. Blockstream interested in Anchorage supporting Liquid. Re Foundation amending contract +$5k/month ", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Polymarket": { found: true, summary: "Found in #always-be-closing biweekly update from Chris Hunt (2026-07-17): Pred Markets - SGB DD is still underway. Call with Polymarket this week to be margin finance partner through A1.", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Portal Ventures": { found: true, summary: "Found in #always-be-closing biweekly update from Michael Pennella (2026-07-16): Verbal: Helix — In KYC, needs 2 weeks. SwapGlobal — going through KYC. Portal Ventures — trial ends 7/26.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "ProShares": { found: true, summary: "Found in #always-be-closing biweekly update from Michael Pennella (2026-07-16): Progress: WisdomTree — meetings on Atlas Settlement and KYC, commercial proposal sent. ProShares — intro'd to Stables team, will trade Q4 with swaps dealer license. Apex Group — signed NDA, exploring QC. A&M — multiple meetings on Custody and stables. Ava Labs — exploring distribution for tokenized assets. Ondo — initial intro call. Spherepay — intro meeting next week for USDT trading.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Psalion VC": { found: true, summary: "Found in #always-be-closing biweekly update from Sara Finnegan (2026-06-30): Verbal: web3.com onboarding altcoin custody. Psalion VC — Morpho lending fit. DoubleZero — sending more investors, testing Hedgey. Lauvar Family Office — BTC yield strategy 500 BTC. 7 Percent — counterparty DD starting.", effective_last_touch_date: "6/30/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Pulse SV": { found: true, summary: "Found in #always-be-closing biweekly update from Noah Goebel (2026-07-02): Blocker: Pulse SV — compliance flagged CNAD DASP license issue.", effective_last_touch_date: "7/2/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Quantfury": { found: true, summary: "Found in #always-be-closing biweekly update from Kyle Clark (2026-07-02): Kyle Clark: Verbal Commit Platform-D, CargoBill, SolidusLink. Doc Signed: Quantfury, Petra Strata, Tetra Trust, XFX Capital. Deposits: $200M+ BTC (3iQ), $100M+ SWEEP mint.", effective_last_touch_date: "7/2/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Republic digital": { found: true, summary: "Found in #always-be-closing biweekly update from Danny Marques (2026-07-16): Progressing: Sentient Capital - back off vs BITGO. Hashdex - negotiating pricing. Republic Digital - custody of venture and tokenized RWA, vault integration w/ Hamilton Lane. Weekend fund - SYND TGE deal.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Resolv": { found: true, summary: "Found in #always-be-closing biweekly update from Chris Wilson (2026-07-16): Onboarding/KYC: Drivvy, Rift, Umbra, Deploy finance, Onrail, Resolvr finance, Midl BTC, Hinkal, Bondl Finance, Eikeden protocol, Ault Capital (~$2.5m/yr), Bmax rwa, Salomon Brothers ($10k monthly mins), Resolv protocol, Squid protocol, Hello Trade, Fish Network", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Ripple": { found: true, summary: "Found in #always-be-closing biweekly update from Ryan Brown (2026-07-17): Verbal Commits: Ripple came back offering $500k to cut scope down to first token standard (IOU tokens, 4-6 weeks). Pearl (Bitcoin-like L1) interested. Movement onboarding new Labs entity. Aztec interested in Anchorage supporting their chain w/ Ethena stablecoin. Cardano governance vote passed for Critical Integrations Budget. Blockstream interested in Anchorage supporting Liquid. Re Foundation amending contract +$5k/month ", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Rubik VC": { found: true, summary: "Found in #always-be-closing biweekly update from Tucker Piner (2026-07-16): Progressing: Welara, Exante ($100-200M Prime Broker), Birch Hill Strategies, Maestro, Rubik VC.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Salomon Brothers": { found: true, summary: "Found in #always-be-closing biweekly update from Chris Wilson (2026-07-16): Onboarding/KYC: Drivvy, Rift, Umbra, Deploy finance, Onrail, Resolvr finance, Midl BTC, Hinkal, Bondl Finance, Eikeden protocol, Ault Capital (~$2.5m/yr), Bmax rwa, Salomon Brothers ($10k monthly mins), Resolv protocol, Squid protocol, Hello Trade, Fish Network", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "SaphETH": { found: true, summary: "Found in #always-be-closing biweekly update from Jack Rosenthal (2026-07-16): Progressing: Tradeweb — very interested in CMS. Binance (Aaron Thian) — 3/5 entities approved, aiming to sign by end of week. Viamericas (Kyle Clark) — should be signing any day. Harmonic — MSA negotiation. Texas Capital Bank (Kyle Clark) — sent proposal. SaphETH (Chris Nabboud) — ~$80M ETH dat, demo set for last week of July. Schellink Family Trust — onboarding, KYC. Solidus Capital — onboarding two entities. Pow.re —", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "SharpLink": { found: true, summary: "Found in #always-be-closing biweekly update from Chris Hunt (2026-07-17): Sharplink - Seeing sharplink team at their office on the 29th for ETH ecosystem breakfast.", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Solidus Capital": { found: true, summary: "Found in #always-be-closing biweekly update from Jack Rosenthal (2026-07-16): Progressing: Tradeweb — very interested in CMS. Binance (Aaron Thian) — 3/5 entities approved, aiming to sign by end of week. Viamericas (Kyle Clark) — should be signing any day. Harmonic — MSA negotiation. Texas Capital Bank (Kyle Clark) — sent proposal. SaphETH (Chris Nabboud) — ~$80M ETH dat, demo set for last week of July. Schellink Family Trust — onboarding, KYC. Solidus Capital — onboarding two entities. Pow.re —", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Squid": { found: true, summary: "Found in #always-be-closing biweekly update from Chris Wilson (2026-07-16): Onboarding/KYC: Drivvy, Rift, Umbra, Deploy finance, Onrail, Resolvr finance, Midl BTC, Hinkal, Bondl Finance, Eikeden protocol, Ault Capital (~$2.5m/yr), Bmax rwa, Salomon Brothers ($10k monthly mins), Resolv protocol, Squid protocol, Hello Trade, Fish Network", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Strike": { found: true, summary: "Found in #always-be-closing biweekly update from Bryan Chong (2026-07-01): Purpose Investments — meeting Purpose & Ether.Fi on derivatives. Cosmos Foundation — met CEO re: liquidations. Strike — revisit late July. Sigil Funds — 2 liquid funds $250M+. Satstreet — clear path to onboarding.", effective_last_touch_date: "7/1/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Supranova": { found: true, summary: "Found in #always-be-closing biweekly update from Ezra Chairez (2026-07-16): Onboarding: Cicada Partners - RFI, ~$20m+ USD flows. Lombard - kicking off A1 flows. Valantis - onboarding for TGE. Topology - referral from Autonomous. Amber Capital - KYC, closing soon. Supranova - KYC, closing soon. Spout - KYC, closing soon, good TGE opp Q3.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "SwapGlobal": { found: true, summary: "Found in #always-be-closing biweekly update from Michael Pennella (2026-07-16): Verbal: Helix — In KYC, needs 2 weeks. SwapGlobal — going through KYC. Portal Ventures — trial ends 7/26.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Trace Finance": { found: true, summary: "Found in #always-be-closing biweekly update from Danny Marques (2026-07-16): Verbal Commits/KYC: OpenFX - ADB, A1, Porto, $12k/month min. Mercado Bitcoin - tagging with Noah. Rainbow International/Angelakos Family office - $5-15 ticket. Banco Genial - STAB deal, $10k/month min. Trace Finance - back in the mix, RFI in process.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Tradeweb": { found: true, summary: "Found in #always-be-closing biweekly update from Jack Rosenthal (2026-07-16): Progressing: Tradeweb — very interested in CMS. Binance (Aaron Thian) — 3/5 entities approved, aiming to sign by end of week. Viamericas (Kyle Clark) — should be signing any day. Harmonic — MSA negotiation. Texas Capital Bank (Kyle Clark) — sent proposal. SaphETH (Chris Nabboud) — ~$80M ETH dat, demo set for last week of July. Schellink Family Trust — onboarding, KYC. Solidus Capital — onboarding two entities. Pow.re —", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Trillion Digital": { found: true, summary: "Found in #always-be-closing biweekly update from Kyle Clark (2026-07-17): Frank Reiman: Verbal Commit: Axexo (stablecoin coverage), Avestix, Teton Trust; Doc Signed: None (close on Amerity, Mangrove, Trillion Digital Capital Market AG); Deposits: Trillion Digital ($4k); Blocker: PulseSV (compliance), CoinDepo (compliance), Bull Bitcoin (product)", effective_last_touch_date: "7/17/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "UBTCCO": { found: true, summary: "Found in #always-be-closing biweekly update from Julian Pierce (2026-07-01): Closed Won: UBTCCO custody account. Hyperion DeFi/Hyperliquid Strategies (HSI/HYPD) using A1. Arena Holdings HYPE spot. NFX ventures liquidating alts. Tiger Global first trade. Hyperlend collateral mgmt deal w/ Atlas.", effective_last_touch_date: "7/1/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Valantis": { found: true, summary: "Found in #always-be-closing biweekly update from Ezra Chairez (2026-07-16): Onboarding: Cicada Partners - RFI, ~$20m+ USD flows. Lombard - kicking off A1 flows. Valantis - onboarding for TGE. Topology - referral from Autonomous. Amber Capital - KYC, closing soon. Supranova - KYC, closing soon. Spout - KYC, closing soon, good TGE opp Q3.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Wealthsimple": { found: true, summary: "Found in #always-be-closing biweekly update from Bryan Chong (2026-07-16): Progressing: Standard Crypto (Flagship + Venture I + Venture III) — derivatives onboarding, sDDQs/LEIs collected. Lombard — Legal accepted ISDA redlines. Purpose Investments — 2 meetings held, PSA sent covering 6 ETFs. Wealthsimple — meeting for Ryan Porter with Head of Crypto July 7, follow-up custody+trading meeting booked July 17.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "Welara": { found: true, summary: "Found in #always-be-closing biweekly update from Tucker Piner (2026-07-16): Progressing: Welara, Exante ($100-200M Prime Broker), Birch Hill Strategies, Maestro, Rubik VC.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
  "WisdomTree": { found: true, summary: "Found in #always-be-closing biweekly update from Michael Pennella (2026-07-16): Progress: WisdomTree — meetings on Atlas Settlement and KYC, commercial proposal sent. ProShares — intro'd to Stables team, will trade Q4 with swaps dealer license. Apex Group — signed NDA, exploring QC. A&M — multiple meetings on Custody and stables. Ava Labs — exploring distribution for tokenized assets. Ondo — initial intro call. Spherepay — intro meeting next week for USDT trading.", effective_last_touch_date: "7/16/2026", checked_date: "2026-07-30", source: "always-be-closing channel bulk scan" },
};
const SLACK_CHECKED_DATE = "2026-07-28";

// ---------------- Real Google Calendar findings (mirrors build_data.py CALENDAR_FINDINGS) ----------------
// SCOPE NOTE: only Sung's own primary calendar (plus a few shared team calendars) is
// accessible via this connection -- there is no access to the other 40 reps' individual
// calendars. Scanned Sung's calendar (~250 events, Jun-Jul 2026) against all 502 must-close
// account names; exactly one real match was found.
const CALENDAR_FINDINGS = {
  "Uphold": {
    found: true,
    summary: "Live meeting confirmed on Sung's own calendar: \"Matt / Sung - catch up\" with Matthew Murray (matthew.murray@uphold.com) on 6/3/2026. This is a real, dated touchpoint, but only reflects Sung's personal calendar -- it doesn't indicate whether Naghma Sadeque (the assigned rep) has met with Uphold separately.",
    effective_last_meeting_date: "6/3/2026",
  },
};

// ---------------- Stablecoin GTM collision set (mirrors build_data.py) ----------------
// Requested collision set: Ripple, Morgan Stanley, Robinhood, ByBit against the Stablecoins
// GTM tracker. Only "Ripple" actually exists in our current account universe (owned by Ryan
// Brown, Protocol motion) -- the other three aren't present in either the must-close list or
// the revenue ledger, so they're surfaced separately in app.js's GM tab rather than tagged here.
const STABLECOIN_COLLISION_SET = new Set(["Ripple"]);

// ---------------- Main merge/scoring pipeline ----------------
function buildDashboardData(mcRows, oppRows, caseRows, rlRows, nsRows) {
  const oppsByAccount = {};
  oppRows.forEach(o => {
    const k = norm(o["Account Name"]);
    (oppsByAccount[k] = oppsByAccount[k] || []).push(o);
  });

  const rlByAccount = {};
  const rlDataRows = rlRows.slice(4).filter(r => (r[1] || "").trim());
  rlDataRows.forEach(r => {
    rlByAccount[norm(r[1])] = {
      team: r[0], parent_account_owner: r[2], global_markets_owner: r[3],
      primary_client_type: r[4], biz_line: r[5], cohort: r[8], client_tier: r[9],
      fy26_total_revenue: money(r[67]), fy2526_jan_june_revenue: r.length > 68 ? money(r[68]) : 0,
    };
  });

  const casesById = {}, casesByName = {};
  caseRows.forEach(c => {
    const cid = (c["Account Id 18-char"] || "").trim();
    if (cid) (casesById[cid] = casesById[cid] || []).push(c);
    const k = norm(c["Account Name"]);
    (casesByName[k] = casesByName[k] || []).push(c);
  });
  function bestCaseForAccount(accountId, nameKey) {
    let all = accountId ? (casesById[accountId] || []) : [];
    const matchedViaId = all.length > 0;
    if (!all.length) all = casesByName[nameKey] || [];
    if (!all.length) return null;
    const active = all.filter(c => ACTIVE_CASE_STATUSES.has(c["Status"]));
    const pool = active.length ? active : all;
    let best = null, bestDt = null;
    pool.forEach(c => {
      const dt = parseDateTime(c["Case Date/Time Last Modified"]) || parseDateTime(c["Opened Date"]);
      if (dt && (!bestDt || dt > bestDt)) { bestDt = dt; best = c; }
    });
    if (!best) best = pool[0];
    return { best, total: all.length, active: active.length, matchedViaId };
  }

  const nsByOpp = {};
  nsRows.forEach(h => {
    const k = h["Opportunity Name"];
    (nsByOpp[k] = nsByOpp[k] || []).push(h);
  });
  function latestNextStepsEdit(oppName) {
    const rows = nsByOpp[oppName];
    if (!rows || !rows.length) return [null, null];
    let bestDt = null, bestVal = null;
    rows.forEach(h => {
      const dt = parseDateTime(h["Edit Date"]);
      if (dt && (!bestDt || dt > bestDt)) { bestDt = dt; bestVal = h["New Value"]; }
    });
    return [bestDt, bestVal];
  }

  // ---- Assigned-Owner-column fallback (mirrors build_data.py assigned_owner_col_present) ----
  // If the "Assigned Owner" column is missing entirely from this export, fall back to Account
  // Owner for every row. Split-coverage detection (Assigned Owner != Account Owner) cannot be
  // reconstructed from a file missing this column, so it reads as no-split until it's restored.
  const assignedOwnerColPresent = mcRows.length > 0 && Object.prototype.hasOwnProperty.call(mcRows[0], "Assigned Owner");

  const records = [];

  mcRows.forEach(m => {
    const acctName = (m["Account Name"] || "").trim();
    if (!acctName) return; // trailing blank rows
    const key = norm(acctName);
    const campaign = (m["Campaign Name"] || "").trim();
    const accountOwner = (m["Account Owner"] || "").trim();
    const assignedOwner = assignedOwnerColPresent ? (m["Assigned Owner"] || "").trim() : accountOwner;
    const isGmMotion = campaign === "Global Market - 2026 Must Close";
    const splitCoverage = accountOwner !== assignedOwner;
    const ironcladWorkflowName = (m["Ironclad Workflow"] || "").trim();
    const hasIronclad = !!ironcladWorkflowName;

    const openOpps = oppsByAccount[key] || [];
    let totalY1 = 0, weightedY1 = 0, tradingY1 = 0, realizable2026 = 0;
    const oppLines = [];
    openOpps.forEach(o => {
      const y1 = money(o["Y1 Expected Revenue"]);
      const prob = parseFloat(o["Probability (%)"] || 0) || 0;
      totalY1 += y1;
      weightedY1 += y1 * prob / 100.0;
      const tradingFlag = isTrading(o["Product Line"]);
      if (tradingFlag) tradingY1 += y1;
      const la = parseDate(o["Last Activity Date"]);
      const days = la ? daysBetween(TODAY, la) : null;
      const [nsEditDt, nsEditVal] = latestNextStepsEdit(o["Opportunity Name"]);
      const daysSinceNsEdit = nsEditDt ? daysBetween(TODAY, nsEditDt) : null;
      let effectiveDays, effectiveSource;
      if (daysSinceNsEdit !== null && (days === null || daysSinceNsEdit < days)) {
        effectiveDays = daysSinceNsEdit; effectiveSource = "next_steps_edit";
      } else {
        effectiveDays = days; effectiveSource = days !== null ? "last_activity" : null;
      }
      const [oppRealizable, oppProRationMonths] = realizable2026Revenue(y1, prob, o["Close Date"]);
      realizable2026 += oppRealizable;
      const origin = classifyOrigin(o["Lead Source"], o["Type"], o["Discovery Meeting Booked By"]);
      const [cycleDay, cycleTotal, cycleStatus] = cycleMaturity(o["Created Date"], o["Close Date"]);
      oppLines.push({
        name: o["Opportunity Name"], stage: o["Stage"], product_line: o["Product Line"], trading: tradingFlag,
        y1_rev: round2(y1), probability: prob, close_date: o["Close Date"], last_activity_date: o["Last Activity Date"],
        days_since_activity: days,
        next_steps_edit_date: nsEditDt ? fmtDate(nsEditDt) : "",
        days_since_next_steps_edit: daysSinceNsEdit,
        next_steps_edit_value: (nsEditVal || "").trim().slice(0, 300),
        effective_days_since_touch: effectiveDays, effective_touch_source: effectiveSource,
        created_date: o["Created Date"], last_modified_date: o["Last Modified Date"],
        next_steps: (o["Next Steps"] || "").trim().slice(0, 300),
        owner: o["Opportunity Owner"], bdr: o["BDR"] || "",
        realizable_2026_revenue: round2(oppRealizable), pro_ration_months: round2(oppProRationMonths),
        origin, discovery_meeting_booked_by: (o["Discovery Meeting Booked By"] || "").trim(),
        lead_source: (o["Lead Source"] || "").trim(),
        cycle_day: cycleDay, cycle_total: cycleTotal, cycle_status: cycleStatus,
      });
    });

    const hasOpp = openOpps.length > 0;

    let representativePool = oppLines;
    let usedTradingScope = false;
    if (isGmMotion) {
      const tradingPool = oppLines.filter(o => o.trading);
      if (tradingPool.length) { representativePool = tradingPool; usedTradingScope = true; }
    }
    const ownerPool = representativePool.filter(o => (o.owner || "").trim() === assignedOwner);
    if (ownerPool.length) representativePool = ownerPool;

    let bestDaysSinceActivity = null, bestNextSteps = "", bestStage = "", bestProb = 0, bestCloseDate = "", bestTouchSource = null;
    let bestOrigin = "Not Logged", bestDiscoveryBookedBy = "", bestCycleDay = null, bestCycleTotal = null, bestCycleStatus = "Unknown";
    const statusScopeMismatch = isGmMotion && !usedTradingScope && oppLines.some(o => !o.trading);
    representativePool.forEach(o => {
      const days = o.effective_days_since_touch;
      if (days !== null && (bestDaysSinceActivity === null || days < bestDaysSinceActivity)) {
        bestDaysSinceActivity = days;
        bestTouchSource = o.effective_touch_source;
        bestNextSteps = o.effective_touch_source === "next_steps_edit" ? o.next_steps_edit_value : o.next_steps;
        bestStage = o.stage; bestProb = o.probability; bestCloseDate = o.close_date;
        bestOrigin = o.origin; bestDiscoveryBookedBy = o.discovery_meeting_booked_by;
        bestCycleDay = o.cycle_day; bestCycleTotal = o.cycle_total; bestCycleStatus = o.cycle_status;
      }
    });
    if (bestDaysSinceActivity === null && representativePool.length) {
      const o = representativePool[0];
      bestNextSteps = o.next_steps; bestStage = o.stage; bestProb = o.probability; bestCloseDate = o.close_date;
      bestOrigin = o.origin; bestDiscoveryBookedBy = o.discovery_meeting_booked_by;
      bestCycleDay = o.cycle_day; bestCycleTotal = o.cycle_total; bestCycleStatus = o.cycle_status;
    }

    let workflowCreatedDate = null, workflowModifiedDate = null, daysSinceWorkflowLaunch = null, daysSinceWorkflowModified = null;
    if (hasIronclad && openOpps.length) {
      const kycOpps = openOpps.filter(o => o["Stage"] === "3 - KYC / Contracting");
      const candidatePool = kycOpps.length ? kycOpps : openOpps;
      let bestCandidate = null, bestModDt = null;
      candidatePool.forEach(o => {
        const modDt = parseDate(o["Last Modified Date"]);
        if (modDt && (!bestModDt || modDt > bestModDt)) { bestModDt = modDt; bestCandidate = o; }
      });
      if (!bestCandidate) bestCandidate = candidatePool[0];
      workflowCreatedDate = bestCandidate["Created Date"];
      workflowModifiedDate = bestCandidate["Last Modified Date"];
      const cd = parseDate(workflowCreatedDate), md = parseDate(workflowModifiedDate);
      daysSinceWorkflowLaunch = cd ? daysBetween(TODAY, cd) : null;
      daysSinceWorkflowModified = md ? daysBetween(TODAY, md) : null;
    }

    const accountId = (m["Account Id 18-char"] || "").trim();
    const caseResult = bestCaseForAccount(accountId, key);
    let hasCase = !!caseResult, caseNumber = "", caseStatus = "", caseOwner = "", caseType = "", caseTransitionNotes = "",
        caseOpenedDate = "", caseLastModifiedDate = "", daysSinceCaseModified = null, isCaseActive = false,
        totalCasesForAccount = 0, activeCasesForAccount = 0, caseMatchedViaId = false;
    if (hasCase) {
      const bc = caseResult.best;
      totalCasesForAccount = caseResult.total; activeCasesForAccount = caseResult.active; caseMatchedViaId = caseResult.matchedViaId;
      caseNumber = bc["Case Number"]; caseStatus = bc["Status"]; caseOwner = bc["Case Owner"]; caseType = bc["Type"];
      caseTransitionNotes = (bc["Transition Notes"] || "").trim();
      caseOpenedDate = bc["Opened Date"]; caseLastModifiedDate = bc["Case Date/Time Last Modified"];
      isCaseActive = ACTIVE_CASE_STATUSES.has(caseStatus);
      const cmd = parseDateTime(caseLastModifiedDate) || parseDate(caseOpenedDate);
      daysSinceCaseModified = cmd ? daysBetween(TODAY, cmd) : null;
    }

    const slackFinding = SLACK_FINDINGS[acctName];
    const slackChecked = !!slackFinding;
    const slackSignalFound = slackFinding ? slackFinding.found : false;
    const slackSummary = slackFinding ? slackFinding.summary : "";
    const slackBlockerFlag = slackFinding ? !!slackFinding.blocker_flag : false;
    const slackTentative = slackFinding ? !!slackFinding.tentative : false;
    let daysSinceSlackTouch = null;
    if (slackFinding && slackFinding.effective_last_touch_date) {
      const sd = parseDate(slackFinding.effective_last_touch_date);
      daysSinceSlackTouch = sd ? daysBetween(TODAY, sd) : null;
      if (daysSinceSlackTouch !== null && (bestDaysSinceActivity === null || daysSinceSlackTouch < bestDaysSinceActivity)) {
        bestDaysSinceActivity = daysSinceSlackTouch;
      }
    }

    const calendarFinding = CALENDAR_FINDINGS[acctName];
    const calendarChecked = !!calendarFinding;
    const calendarMeetingFound = calendarFinding ? calendarFinding.found : false;
    const calendarSummary = calendarFinding ? calendarFinding.summary : "";
    let daysSinceCalendarMeeting = null;
    if (calendarFinding && calendarFinding.effective_last_meeting_date) {
      const cd2 = parseDate(calendarFinding.effective_last_meeting_date);
      daysSinceCalendarMeeting = cd2 ? daysBetween(TODAY, cd2) : null;
      if (daysSinceCalendarMeeting !== null && (bestDaysSinceActivity === null || daysSinceCalendarMeeting < bestDaysSinceActivity)) {
        bestDaysSinceActivity = daysSinceCalendarMeeting;
      }
    }

    const activityScore = recencyScore(bestDaysSinceActivity);
    let caseScore, contractScore;
    if (hasCase) { caseScore = isCaseActive ? recencyScore(daysSinceCaseModified) : -1; contractScore = -1; }
    else { caseScore = -1; contractScore = hasIronclad ? recencyScore(daysSinceWorkflowModified) : -1; }
    const slackScore = daysSinceSlackTouch !== null ? recencyScore(daysSinceSlackTouch) : -1;
    const calendarScore = daysSinceCalendarMeeting !== null ? recencyScore(daysSinceCalendarMeeting) : -1;
    let engScore = Math.max(activityScore, caseScore, contractScore, slackScore, calendarScore);
    if (bestNextSteps) engScore = Math.min(100, engScore + 10);
    if (!hasOpp && !hasIronclad && !(hasCase && isCaseActive) && slackScore < 0 && calendarScore < 0) engScore = 0;

    const bucket = likelihoodBucket(bestProb, bestDaysSinceActivity, hasOpp, hasIronclad, daysSinceWorkflowModified,
                                     hasCase, isCaseActive, caseStatus, daysSinceCaseModified);

    const noActivitySignal = bestDaysSinceActivity === null || bestDaysSinceActivity > 90;
    let zeroTouch;
    if (hasCase) {
      const noCaseSignal = !isCaseActive || daysSinceCaseModified === null || daysSinceCaseModified > 90;
      zeroTouch = noActivitySignal && noCaseSignal;
    } else {
      const noContractSignal = !hasIronclad || daysSinceWorkflowModified === null || daysSinceWorkflowModified > 90;
      zeroTouch = noActivitySignal && noContractSignal;
    }
    if (daysSinceSlackTouch !== null && daysSinceSlackTouch <= 90) zeroTouch = false;
    if (daysSinceCalendarMeeting !== null && daysSinceCalendarMeeting <= 90) zeroTouch = false;

    const rlInfo = rlByAccount[key];

    records.push({
      account: acctName, campaign, motion: campaign.replace(" - 2026 Must Close", ""), is_gm_motion: isGmMotion,
      account_owner: accountOwner, assigned_owner: assignedOwner, split_coverage: splitCoverage,
      primary_client_type: m["Primary Client Type"], sf_open_opp_count: m["# Open Opportunities"],
      sf_open_opp_stage_num: m["Open Opp Stage #"], sf_closed_won_nb: m["# Closed Won NB Opps"],
      ironclad_workflow: ironcladWorkflowName, has_ironclad: hasIronclad,
      workflow_created_date: workflowCreatedDate, workflow_modified_date: workflowModifiedDate,
      days_since_workflow_launch: daysSinceWorkflowLaunch, days_since_workflow_modified: daysSinceWorkflowModified,
      has_case: hasCase, case_matched_via_id: caseMatchedViaId, is_case_active: isCaseActive,
      case_number: caseNumber, case_status: caseStatus, case_owner: caseOwner, case_type: caseType,
      case_transition_notes: caseTransitionNotes.slice(0, 400), case_opened_date: caseOpenedDate,
      case_last_modified_date: caseLastModifiedDate, days_since_case_modified: daysSinceCaseModified,
      total_cases_for_account: totalCasesForAccount, active_cases_for_account: activeCasesForAccount,
      has_opportunity: hasOpp, opp_count: openOpps.length,
      total_y1_expected_revenue: round2(totalY1), weighted_y1_expected_revenue: round2(weightedY1),
      trading_y1_expected_revenue: round2(tradingY1), realizable_2026_revenue: round2(realizable2026),
      has_trading_opp: tradingY1 > 0, status_scope_mismatch: statusScopeMismatch,
      days_since_activity: bestDaysSinceActivity, touch_source: bestTouchSource,
      next_steps: bestNextSteps.slice(0, 300), stage: bestStage, probability: bestProb, close_date: bestCloseDate,
      engagement_score: engScore, likelihood: bucket, zero_touch: zeroTouch, opps: oppLines,
      existing_client: !!rlInfo, fy26_actual_revenue: rlInfo ? rlInfo.fy26_total_revenue : 0,
      client_tier: rlInfo ? rlInfo.client_tier : "", global_markets_owner_field: rlInfo ? rlInfo.global_markets_owner : "",
      cohort: rlInfo ? rlInfo.cohort : "", account_id: accountId,
      slack_checked: slackChecked, slack_signal_found: slackSignalFound, slack_summary: slackSummary,
      slack_blocker_flag: slackBlockerFlag, slack_tentative: slackTentative,
      slack_checked_date: slackFinding ? (slackFinding.checked_date || SLACK_CHECKED_DATE) : "",
      calendar_checked: calendarChecked, calendar_meeting_found: calendarMeetingFound, calendar_summary: calendarSummary,
      days_since_calendar_meeting: daysSinceCalendarMeeting,
      origin: bestOrigin, discovery_meeting_booked_by: bestDiscoveryBookedBy,
      cycle_day: bestCycleDay, cycle_total: bestCycleTotal, cycle_status: bestCycleStatus,
      stablecoin_collision: STABLECOIN_COLLISION_SET.has(acctName),
    });
  });

  return aggregateDashboardData(records, assignedOwnerColPresent);
}

function round2(v) { return Math.round(v * 100) / 100; }
function fmtDate(d) { return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; }

// ---------------- Aggregation (mirrors aggregate.py: rep/motion/product/gm rollup + concentration + ramp signal) ----------------
function aggregateDashboardData(records, assignedOwnerColPresent) {
  const LIKELIHOODS = ["Onboarding - Active", "Onboarding - Stalled", "Contract Negotiation - Active", "Contract Negotiation - Stalled", "Hot", "Warm", "Cold", "Stalled", "No Opportunity"];

  // ---- Rep rollup: existing metrics + ramp signal + New Logo/Expansion revenue split ----
  // RAMP SIGNAL METHODOLOGY (placeholder pending the real framework): we don't have real hire
  // dates, so "first pipeline evidence" (the earliest Created Date across all opportunities
  // currently assigned to that rep) is used as a proxy for when they started actively working
  // accounts. A generic 180-day linear ramp is applied on top of that -- a clear stand-in.
  const repMap = {};
  records.forEach(r => {
    const o = r.assigned_owner;
    const d = repMap[o] = repMap[o] || {
      accounts: 0, with_opp: 0, zero_touch: 0, split: 0, total_y1: 0, weighted_y1: 0, trading_y1: 0, eng_sum: 0,
      has_case: 0, ns_edit: 0, motions: new Set(), likes: {}, new_logo_y1: 0, expansion_y1: 0, earliest_created: null,
    };
    d.accounts++; if (r.has_opportunity) d.with_opp++; if (r.zero_touch) d.zero_touch++; if (r.split_coverage) d.split++;
    d.total_y1 += r.total_y1_expected_revenue; d.weighted_y1 += r.weighted_y1_expected_revenue; d.trading_y1 += r.trading_y1_expected_revenue;
    d.eng_sum += r.engagement_score; d.motions.add(r.motion); if (r.has_case) d.has_case++;
    if (r.touch_source === "next_steps_edit") d.ns_edit++;
    d.likes[r.likelihood] = (d.likes[r.likelihood] || 0) + 1;
    if (r.origin === "Existing Client / Expansion") d.expansion_y1 += r.total_y1_expected_revenue;
    else if (r.has_opportunity) d.new_logo_y1 += r.total_y1_expected_revenue;
    r.opps.forEach(o_line => {
      const cd = parseDate(o_line.created_date);
      if (cd && (d.earliest_created === null || cd < d.earliest_created)) d.earliest_created = cd;
    });
  });
  const reps = Object.entries(repMap).map(([name, d]) => {
    const daysSinceFirstEvidence = d.earliest_created ? daysBetween(TODAY, d.earliest_created) : null;
    let rampPct, rampStatus;
    if (daysSinceFirstEvidence !== null && daysSinceFirstEvidence <= RAMP_WINDOW_DAYS) {
      rampPct = Math.round(100 * daysSinceFirstEvidence / RAMP_WINDOW_DAYS);
      rampStatus = "Ramping";
    } else {
      rampPct = 100;
      rampStatus = daysSinceFirstEvidence !== null ? "Fully Ramped" : "Unknown";
    }
    return {
      name, accounts: d.accounts, with_opp: d.with_opp, zero_touch: d.zero_touch, split: d.split,
      total_y1: round2(d.total_y1), weighted_y1: round2(d.weighted_y1), trading_y1: round2(d.trading_y1),
      new_logo_y1: round2(d.new_logo_y1), expansion_y1: round2(d.expansion_y1),
      avg_engagement: d.accounts ? round2(d.eng_sum / d.accounts) : 0,
      hot: d.likes["Hot"] || 0, warm: d.likes["Warm"] || 0, cold: d.likes["Cold"] || 0, stalled: d.likes["Stalled"] || 0, no_opp: d.likes["No Opportunity"] || 0,
      contract_active: d.likes["Contract Negotiation - Active"] || 0, contract_stalled: d.likes["Contract Negotiation - Stalled"] || 0,
      onboarding_active: d.likes["Onboarding - Active"] || 0, onboarding_stalled: d.likes["Onboarding - Stalled"] || 0,
      has_case: d.has_case, ns_edit_rescued: d.ns_edit, motions: Array.from(d.motions).sort(),
      earliest_pipeline_evidence: d.earliest_created ? fmtDate(d.earliest_created) : null,
      days_since_first_evidence: daysSinceFirstEvidence, ramp_pct: rampPct, ramp_status: rampStatus,
    };
  }).sort((a, b) => b.accounts - a.accounts);

  const motionMap = {};
  records.forEach(r => {
    const d = motionMap[r.motion] = motionMap[r.motion] || { accounts: 0, with_opp: 0, zero_touch: 0, total_y1: 0, weighted_y1: 0, realizable_2026: 0, reps: new Set(), onboarding_stalled: 0 };
    d.accounts++; if (r.has_opportunity) d.with_opp++; if (r.zero_touch) d.zero_touch++;
    d.total_y1 += r.total_y1_expected_revenue; d.weighted_y1 += r.weighted_y1_expected_revenue;
    d.realizable_2026 += r.realizable_2026_revenue || 0; d.reps.add(r.assigned_owner);
    if (r.likelihood === "Onboarding - Stalled") d.onboarding_stalled++;
  });
  const motions = Object.entries(motionMap).map(([motion, v]) => ({
    motion, accounts: v.accounts, with_opp: v.with_opp, zero_touch: v.zero_touch,
    total_y1: round2(v.total_y1), weighted_y1: round2(v.weighted_y1), realizable_2026: round2(v.realizable_2026),
    reps: v.reps.size, onboarding_stalled: v.onboarding_stalled,
  })).sort((a, b) => b.total_y1 - a.total_y1);

  const prodRev = {}, prodCount = {};
  records.forEach(r => {
    r.opps.forEach(o => {
      const parts = parseProductLine(o.product_line);
      if (!parts.length) return;
      const share = o.y1_rev / parts.length;
      parts.forEach(p => { prodRev[p] = (prodRev[p] || 0) + share; prodCount[p] = (prodCount[p] || 0) + 1; });
    });
  });
  const products = Object.entries(prodRev).map(([product, y1]) => ({ product, y1_revenue: round2(y1), opp_touches: prodCount[product] }))
    .sort((a, b) => b.y1_revenue - a.y1_revenue);

  const gmReps = new Set();
  records.forEach(r => { if (r.is_gm_motion) gmReps.add(r.assigned_owner); });
  const gm = {
    gm_reps: Array.from(gmReps).sort(),
    accounts_touched_by_gm_motion: records.filter(r => r.is_gm_motion).length,
    accounts_with_trading_opp: records.filter(r => r.has_trading_opp).length,
    split_coverage_accounts: records.filter(r => r.split_coverage).length,
    trading_y1_total: round2(records.reduce((s, r) => s + r.trading_y1_expected_revenue, 0)),
    trading_weighted_y1: round2(records.reduce((s, r) => s + r.trading_y1_expected_revenue * r.probability / 100, 0)),
    gm_status_scope_mismatch: records.filter(r => r.is_gm_motion && r.status_scope_mismatch).length,
  };

  // ---- Pipeline concentration metric ----
  // Uses distinct opportunities (not account-level rollups), sorted by both total Y1 expected
  // revenue and 2026-realizable revenue, to show what share of the pipeline sits in the top
  // 10 / top 25 deals.
  const allOppsFlat = [];
  records.forEach(r => {
    r.opps.forEach(o => {
      allOppsFlat.push({ account: r.account, name: o.name, y1_rev: o.y1_rev, realizable: o.realizable_2026_revenue || 0 });
    });
  });
  function concentrationStats(opps, key) {
    const sorted = [...opps].sort((a, b) => b[key] - a[key]);
    const total = sorted.reduce((s, o) => s + o[key], 0);
    const top10 = sorted.slice(0, 10).reduce((s, o) => s + o[key], 0);
    const top25 = sorted.slice(0, 25).reduce((s, o) => s + o[key], 0);
    return {
      total: round2(total), top10_amount: round2(top10), top10_pct: total ? round2(100 * top10 / total) : 0,
      top25_amount: round2(top25), top25_pct: total ? round2(100 * top25 / total) : 0,
      top_deals: sorted.slice(0, 25).map(o => ({ account: o.account, name: o.name, amount: round2(o[key]) })),
    };
  }
  const concentration = {
    by_y1_expected: concentrationStats(allOppsFlat, "y1_rev"),
    by_realizable_2026: concentrationStats(allOppsFlat, "realizable"),
    total_opp_count: allOppsFlat.length,
  };

  const totalAccounts = records.length;
  const uniqueAccounts = new Set(records.map(r => r.account)).size;
  const withOpp = records.filter(r => r.has_opportunity).length;
  const zeroTouch = records.filter(r => r.zero_touch).length;
  const splitCov = records.filter(r => r.split_coverage).length;
  const existingClients = records.filter(r => r.existing_client).length;
  const hasIronclad = records.filter(r => r.has_ironclad).length;
  const hasCase = records.filter(r => r.has_case).length;
  const hasCaseActive = records.filter(r => r.has_case && r.is_case_active).length;
  const hasCaseViaId = records.filter(r => r.has_case && r.case_matched_via_id).length;
  const hasCaseViaName = records.filter(r => r.has_case && !r.case_matched_via_id).length;
  const slackChecked = records.filter(r => r.slack_checked).length;
  const slackFound = records.filter(r => r.slack_signal_found).length;
  const slackBlockers = records.filter(r => r.slack_blocker_flag).length;
  const slackUniqueChecked = new Set(records.filter(r => r.slack_checked).map(r => r.account)).size;
  const calendarChecked = records.filter(r => r.calendar_checked).length;
  const calendarFound = records.filter(r => r.calendar_meeting_found).length;
  const stablecoinCollisionCount = records.filter(r => r.stablecoin_collision).length;
  const nsEditRescued = records.filter(r => r.touch_source === "next_steps_edit").length;
  const byLik = k => records.filter(r => r.likelihood === k).length;

  const summary = {
    total_assignments: totalAccounts, unique_accounts: uniqueAccounts, with_opportunity: withOpp, no_opportunity: totalAccounts - withOpp,
    zero_touch: zeroTouch, touched: totalAccounts - zeroTouch, split_coverage: splitCov, existing_clients_in_list: existingClients,
    total_y1_pipeline: round2(records.reduce((s, r) => s + r.total_y1_expected_revenue, 0)),
    weighted_y1_pipeline: round2(records.reduce((s, r) => s + r.weighted_y1_expected_revenue, 0)),
    realizable_2026_pipeline: round2(records.reduce((s, r) => s + (r.realizable_2026_revenue || 0), 0)),
    trading_y1_pipeline: round2(records.reduce((s, r) => s + r.trading_y1_expected_revenue, 0)),
    existing_actual_revenue: round2(records.filter(r => r.existing_client).reduce((s, r) => s + r.fy26_actual_revenue, 0)),
    has_ironclad: hasIronclad, has_case: hasCase, has_case_active: hasCaseActive, has_case_via_id: hasCaseViaId, has_case_via_name: hasCaseViaName,
    slack_checked: slackChecked, slack_found: slackFound, slack_blockers: slackBlockers, slack_unique_checked: slackUniqueChecked,
    ns_edit_rescued: nsEditRescued,
    calendar_checked: calendarChecked, calendar_found: calendarFound,
    stablecoin_collision_count: stablecoinCollisionCount,
    contract_active: byLik("Contract Negotiation - Active"), contract_stalled: byLik("Contract Negotiation - Stalled"),
    onboarding_active: byLik("Onboarding - Active"), onboarding_stalled: byLik("Onboarding - Stalled"),
    hot: byLik("Hot"), warm: byLik("Warm"), cold: byLik("Cold"), stalled: byLik("Stalled"), no_opp_bucket: byLik("No Opportunity"),
    reps_total: reps.length, reps_below_touch_bar: reps.filter(x => x.zero_touch > 0).length,
    assigned_owner_col_present: assignedOwnerColPresent,
  };

  return { summary, reps, motions, products, gm, concentration, accounts: records };
}

// ================================================================
// LIVE LOADER — reads the 5 tabs via the viewer's own Google Sheets/
// Drive connector through window.claude.mcp. See the header comment
// at the top of this file and the accompanying reply for the caveats
// on the exact connector tool name/input shape, which could not be
// observed from the authoring session and may need one live
// test-and-adjust pass after first publish.
// ================================================================
const SPREADSHEET_ID = "1lOT0gx7HY8z4h0IF6UUiI98SKreX6MT1ZW1clhjKGOA";
const SHEET_TABS = {
  mustClose: "2026_mustclose_Assigned_RevOps",
  opportunities: "Open Opportunities",
  cases: "KYC Case report_RevOps_Sung",
  revenue: "Revenue Data",
  nextSteps: "NExt Step Field History",
};
// Candidate connector display names -- tried in order against listTools().
const SHEETS_SERVER_CANDIDATES = ["Google Drive", "Google Sheets"];

function mcpAvailable() {
  return typeof window !== "undefined" && !!window.claude && !!window.claude.mcp;
}

async function discoverSheetsConnector() {
  const result = await window.claude.mcp.listTools();
  const servers = (result && result.servers) || [];
  const nameMatch = s => SHEETS_SERVER_CANDIDATES.some(c => c.toLowerCase() === s.toLowerCase());
  // Confirmed live: "Google Drive" exposes read_file_content, which returns the WHOLE
  // spreadsheet as one natural-language/markdown document (all tabs, no per-tab range
  // reads available on this connector) -- see parseWholeDocIntoTabs below.
  for (const server of servers) {
    if (!nameMatch(server.server)) continue;
    if (!server.tools || !server.tools.length) continue; // not connected / no tools granted
    const tool = server.tools.find(t => /^read_file_content$/i.test(t.name))
              || server.tools.find(t => /read_file_content|download_file_content/i.test(t.name));
    if (tool) return { server: server.server, tool: tool.name, allTools: server.tools.map(t => t.name) };
  }
  for (const server of servers) {
    if (!server.tools || !server.tools.length) continue;
    const tool = server.tools.find(t => /read_file_content|download_file_content/i.test(t.name));
    if (tool) return { server: server.server, tool: tool.name, allTools: server.tools.map(t => t.name) };
  }
  return { availableServers: servers.map(s => ({ server: s.server, tools: (s.tools || []).map(t => t.name) })) };
}

// read_file_content's payload has been observed as a plain string (the natural-language
// doc). Handle a couple of plausible wrapper shapes defensively too. If none match, throw
// with enough shape detail (type, keys, a truncated dump) to fix this on the next pass
// without having to guess again.
function extractDocText(payload) {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    if (typeof payload.fileContent === "string") return payload.fileContent;
    if (typeof payload.text === "string") return payload.text;
    if (typeof payload.content === "string") return payload.content;
    if (Array.isArray(payload.content)) {
      const textBlock = payload.content.find(b => b && b.type === "text" && typeof b.text === "string");
      if (textBlock) return textBlock.text;
      // No text-typed block matched -- try the first block with ANY string field, or
      // fall back to describing the block shapes actually present.
      for (const b of payload.content) {
        if (b && typeof b === "object") {
          const strField = Object.keys(b).find(k => typeof b[k] === "string" && k !== "type");
          if (strField) return b[strField];
        }
      }
    }
  }
  const err = new Error("read_file_content returned a payload shape with no recognizable text content.");
  err.payloadType = Array.isArray(payload) ? "array" : typeof payload;
  err.payloadKeys = (payload && typeof payload === "object") ? Object.keys(payload) : undefined;
  err.payloadPreview = (() => {
    try { return JSON.stringify(payload).slice(0, 1500); } catch (e2) { return String(payload).slice(0, 1500); }
  })();
  throw err;
}

// A real CSV parser (quoted fields, "" escaping, embedded commas/newlines inside quotes) --
// the exported rows include quoted HTML anchor tags with commas inside href attributes,
// so naive split(',') / split('\n') would corrupt rows.
function parseCsvText(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = "";
    } else if (c === '\r') {
      // skip -- \n (or end of quoted field) handles the row break
    } else if (c === '\n') {
      row.push(field); field = ""; rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0].trim() === ""));
}

// read_file_content renders sheets as GFM-style pipe tables (observed live), sometimes
// with a blank header row + separator ahead of the real header (an artifact of a blank
// row 1 in the source sheet) -- both get skipped as non-data rows here.
function unescapeMarkdown(s) {
  return s.replace(/\\([_*#\\`~\[\]()>])/g, "$1");
}
function looksLikePipeTable(text) {
  return /\|\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?/.test(text);
}
function parsePipeTableText(text) {
  const PIPE_PLACEHOLDER = "@@PIPE@@";
  const protectedText = text.replace(/\\\|/g, PIPE_PLACEHOLDER);
  const rows = [];
  protectedText.split(/\r?\n/).forEach(line => {
    if (!line.includes("|")) return;
    let cells = line.split("|").map(c => unescapeMarkdown(c.split(PIPE_PLACEHOLDER).join("|")).trim());
    if (cells.length && cells[0] === "") cells = cells.slice(1);
    if (cells.length && cells[cells.length - 1] === "") cells = cells.slice(0, -1);
    if (!cells.length) return;
    const isSeparatorRow = cells.every(c => c === "" || /^:?-+:?$/.test(c));
    const isBlankRow = cells.every(c => c === "");
    if (isSeparatorRow || isBlankRow) return;
    rows.push(cells);
  });
  return rows;
}
// Auto-detects pipe-table vs. comma-CSV per section, since the two source formats
// observed for this connector/tool differ from each other.
function parseTabContent(text) {
  return looksLikePipeTable(text) ? parsePipeTableText(text) : parseCsvText(text);
}

// ---- Section splitting ----
// Locates each of the 5 needed tabs inside the whole-document text. Tries a markdown
// heading first ("#".."######" followed by the tab name), since that's the more common
// convention; falls back to finding the tab name's own literal (or markdown-underscore-
// escaped) text anywhere in the document and treating everything from the end of that
// line up to the next marker (another located tab, or any heading at all) as its content.
// This is deliberately format-agnostic: this connector's rendering was observed to omit
// heading markers entirely for at least the first sheet in the document.
function findAllHeadings(docText) {
  const headings = [];
  const re = /^#{1,6}\s+(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(docText))) headings.push({ name: m[1].trim(), index: m.index, contentStart: re.lastIndex + 1 });
  return headings;
}
function locateByPosition(docText, name) {
  const escapedVariant = name.replace(/_/g, "\\_");
  const idxPlain = docText.lastIndexOf(name);
  const idxEscaped = escapedVariant !== name ? docText.lastIndexOf(escapedVariant) : -1;
  const idx = Math.max(idxPlain, idxEscaped);
  if (idx === -1) return null;
  const lineEnd = docText.indexOf("\n", idx);
  return { idx, contentStart: lineEnd === -1 ? docText.length : lineEnd + 1 };
}
// The "Auto Refresh Execution Log" tab (an artifact of the Apps Script that refreshes
// these tabs from Salesforce reports every few hours) writes a row per refresh that
// repeats each *other* tab's name as a plain data value -- e.g. a row containing
// "2026_mustclose_Assigned_RevOps" as its "Sheet" column. Since that log accumulates one
// such row per refresh cycle, a given tab's name can appear dozens of times close
// together purely as log data, which corrupts simple name-based positional search (each
// match gets cut off by the very next log row mentioning a different target tab).
// Column-header fingerprints sidestep this entirely: a header row's specific column-name
// combination can't coincidentally appear as a single log data value.
const TAB_FINGERPRINTS = {
  "2026_mustclose_Assigned_RevOps": ["Campaign Name", "Ironclad Workflow"],
  "Open Opportunities": ["Opportunity Name", "Y1 Expected Revenue"],
  "KYC Case report_RevOps_Sung": ["Case Number", "Transition Notes"],
};
function locateByColumnFingerprint(docText, terms) {
  if (!terms || !terms.length) return null;
  const primary = terms[0];
  let searchFrom = 0;
  while (true) {
    const idx = docText.indexOf(primary, searchFrom);
    if (idx === -1) return null;
    const window = docText.slice(idx, idx + 600);
    if (terms.every(t => window.includes(t))) {
      // Anchor on the START of the header line (not just past the matched terms), so
      // this tab's own header row is included in ITS content, and the preceding tab's
      // slice ends exactly here rather than mid-line into this header.
      const lineStart = docText.lastIndexOf("\n", idx) + 1;
      return { idx: lineStart, contentStart: lineStart };
    }
    searchFrom = idx + primary.length;
  }
}

function locateTabSections(docText, wantedNames) {
  const headings = findAllHeadings(docText);
  const headingIndices = headings.map(h => h.index);
  const notFound = [];
  const methods = {};

  // One unified, sorted marker list regardless of how each wanted tab was located,
  // so a heading-found tab's content still stops at a later positional-found tab
  // (and vice versa) rather than only ever stopping at another heading.
  // Priority per tab: markdown heading > known column-header fingerprint > literal
  // tab-name occurrence (least reliable -- see the fingerprint comment above).
  const markers = [];
  wantedNames.forEach(name => {
    const heading = headings.find(h => h.name.toLowerCase() === name.trim().toLowerCase());
    if (heading) {
      markers.push({ name, idx: heading.index, contentStart: heading.contentStart });
      methods[name] = "heading";
      return;
    }
    const fp = locateByColumnFingerprint(docText, TAB_FINGERPRINTS[name]);
    if (fp) {
      markers.push({ name, idx: fp.idx, contentStart: fp.contentStart });
      methods[name] = "fingerprint";
      return;
    }
    const pos = locateByPosition(docText, name);
    if (pos) {
      markers.push({ name, idx: pos.idx, contentStart: pos.contentStart });
      methods[name] = "name-position";
      return;
    }
    notFound.push(name);
  });

  markers.sort((a, b) => a.idx - b.idx);
  const sections = {};
  markers.forEach((marker, i) => {
    const nextMarkerIdx = i + 1 < markers.length ? markers[i + 1].idx : Infinity;
    const nextHeadingIdx = headingIndices.find(hIdx => hIdx > marker.contentStart);
    const end = Math.min(nextMarkerIdx, nextHeadingIdx !== undefined ? nextHeadingIdx : Infinity, docText.length);
    sections[marker.name] = docText.slice(marker.contentStart, end === Infinity ? docText.length : end);
  });

  return { sections, notFound, headingsFoundCount: headings.length, methods };
}

async function loadLiveData() {
  if (!mcpAvailable()) {
    const err = new Error("This viewer's browser session has no MCP connector bridge available.");
    err.code = "no_mcp";
    throw err;
  }
  const conn = await discoverSheetsConnector();
  if (!conn.tool) {
    const err = new Error("No connected Google Sheets/Drive connector tool was found for this viewer.");
    err.code = "no_connector";
    err.availableServers = conn.availableServers;
    throw err;
  }

  const args = { fileId: SPREADSHEET_ID };
  let result;
  try {
    result = await window.claude.mcp.callTool(conn.server, conn.tool, args, { cache: { refresh: true } });
  } catch (e) {
    const err = new Error(`Reading the spreadsheet via ${conn.server} / ${conn.tool} failed: ${(e && e.message) || e}`);
    err.code = (e && e.code) || "unknown";
    err.server = (e && e.server) || conn.server;
    err.tool = conn.tool;
    err.allTools = conn.allTools;
    err.attemptedArgs = args;
    err.originalMessage = e && e.message;
    err.retryable = e && e.retryable;
    err.result = e && e.result;
    throw err;
  }

  let docText;
  try {
    docText = extractDocText(result.payload);
  } catch (e) {
    e.server = conn.server;
    e.tool = conn.tool;
    e.code = "unrecognized_payload";
    throw e;
  }
  const tabEntries = Object.entries(SHEET_TABS);
  const wantedNames = tabEntries.map(([, tabName]) => tabName);
  const { sections, notFound, headingsFoundCount, methods } = locateTabSections(docText, wantedNames);
  if (notFound.length) {
    const err = new Error(
      `${notFound.length}/${tabEntries.length} expected tab(s) could not be located anywhere in the document read back from ${conn.server} / ${conn.tool}: ` +
      notFound.map(t => `"${t}"`).join(", ")
    );
    err.code = "tab_not_found";
    err.server = conn.server;
    err.tool = conn.tool;
    err.missingTabs = notFound;
    err.sectionsFound = Object.keys(sections);
    err.locationMethods = methods;
    err.headingsFoundCount = headingsFoundCount;
    err.docTextLength = docText.length;
    err.docTextPreview = docText.slice(0, 1500);
    throw err;
  }

  const parsed = {};
  tabEntries.forEach(([key, tabName]) => { parsed[key] = parseTabContent(sections[tabName]); });

  // A section that parsed to <2 rows (no header + data) almost certainly means the
  // positional slice grabbed the wrong span -- fail loudly with the raw section text
  // rather than silently feeding buildDashboardData near-empty tables.
  const thin = tabEntries.filter(([key]) => parsed[key].length < 2);
  if (thin.length) {
    const err = new Error(
      `${thin.length}/${tabEntries.length} tab(s) parsed to fewer than 2 rows, suggesting the section boundary is wrong: ` +
      thin.map(([, t]) => `"${t}"`).join(", ")
    );
    err.code = "thin_section";
    err.server = conn.server;
    err.tool = conn.tool;
    err.thinTabs = thin.map(([key, t]) => ({ tab: t, rowCount: parsed[key].length, method: methods[t] }));
    err.locationMethods = methods;
    err.sectionPreviews = thin.reduce((acc, [, t]) => {
      acc[t] = (sections[t] || "").slice(0, 800);
      return acc;
    }, {});
    throw err;
  }

  const mcRaw = parsed.mustClose;
  const oppRaw = parsed.opportunities;
  const caseRaw = parsed.cases;
  const rlRaw = parsed.revenue;
  const nsRaw = parsed.nextSteps;

  const mcRows = rowsToObjects(mcRaw);
  const oppRows = rowsToObjects(oppRaw);
  const caseRows = rowsToObjects(caseRaw);
  const rlRows = rlRaw; // raw 2D rows -- multi-row header, indexed access in buildDashboardData
  const nsRows = rowsToObjects(nsRaw);
  return buildDashboardData(mcRows, oppRows, caseRows, rlRows, nsRows);
}

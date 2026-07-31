
// ============================================================
// Must-Close 2026 Command Center — client logic
// ============================================================
let DATA, S, REPS, MOTIONS, PRODUCTS, GM, ACCOUNTS;
function setData(d){
  DATA = d;
  S = d.summary; REPS = d.reps; MOTIONS = d.motions; PRODUCTS = d.products; GM = d.gm; ACCOUNTS = d.accounts;
}

const LIK_COLOR = {
  "Onboarding - Active": "var(--onboard)", "Onboarding - Stalled": "var(--onboard-stall)",
  "Contract Negotiation - Active": "var(--contract)", "Contract Negotiation - Stalled": "var(--contract-stall)",
  "Hot": "var(--hot)", "Warm": "var(--warm)", "Cold": "var(--cold)",
  "Stalled": "var(--stalled)", "No Opportunity": "var(--noopp)"
};
const LIK_CHIP = {
  "Onboarding - Active": "chip-onboard", "Onboarding - Stalled": "chip-onboard-stall",
  "Contract Negotiation - Active": "chip-contract", "Contract Negotiation - Stalled": "chip-contract-stall",
  "Hot": "chip-hot", "Warm": "chip-warm", "Cold": "chip-cold",
  "Stalled": "chip-stalled", "No Opportunity": "chip-noopp"
};

function fmtMoney(v){
  if (v === null || v === undefined) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e6) return (v<0?"-":"") + "$" + (abs/1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (v<0?"-":"") + "$" + (abs/1e3).toFixed(0) + "K";
  return "$" + v.toFixed(0);
}
function fmtDays(d){ return (d===null||d===undefined) ? "no activity" : d + "d"; }
function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

// ---------------- Tabs ----------------
document.getElementById('tabs').addEventListener('click', (e)=>{
  const tab = e.target.closest('.tab');
  if(!tab) return;
  activateTab(tab.dataset.tab);
});
function activateTab(name){
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===name));
  document.querySelectorAll('.panel-section').forEach(p=>p.classList.toggle('active', p.id==='panel-'+name));
}
function goToAccountsFiltered(mode){
  activateTab('accounts');
  if(mode==='zero_touch'){ zeroTouchOnly = true; splitOnly = false; renderAccountsTable(); document.getElementById('filter-zero-touch').classList.add('active'); }
  if(mode==='contract_stalled'){
    document.getElementById('filter-likelihood').value = 'Contract Negotiation - Stalled';
    renderAccountsTable();
  }
  if(mode==='onboarding_stalled'){
    document.getElementById('filter-likelihood').value = 'Onboarding - Stalled';
    renderAccountsTable();
  }
}

// ================================================================
// OVERVIEW
// ================================================================
function renderKPIs(){
  const grid = document.getElementById('kpi-grid');
  const items = [
    {label:"Must-close accounts", value: S.unique_accounts, foot: S.total_assignments + " rep-account assignments (incl. split coverage)"},
    {label:"With an open opportunity", value: S.with_opportunity, foot: Math.round(100*S.with_opportunity/S.total_assignments)+"% of assignments · "+S.no_opportunity+" still need an opp created", cls: S.no_opportunity>80?"warn":""},
    {label:"Zero-touch (90d+, any signal)", value: S.zero_touch, foot: Math.round(100*S.zero_touch/S.total_assignments)+"% below the 1-touchpoint bar — SF activity, Case, and Ironclad all checked", cls:"danger"},
    {label:"Matched to a real Case", value: S.has_case, foot: S.has_case_active+" have an active onboarding case in flight", cls:"accent"},
    {label:"Open Y1 pipeline", value: fmtMoney(S.total_y1_pipeline), foot: fmtMoney(S.weighted_y1_pipeline)+" probability-weighted", cls:"accent"},
    {label:"Trading (GM) pipeline", value: fmtMoney(S.trading_y1_pipeline), foot: "Hold/A1 Spot, Derivatives, Margin — see Global Markets tab", cls:"accent"},
  ];
  grid.innerHTML = items.map(it=>`
    <div class="kpi ${it.cls||''}">
      <div class="label">${it.label}</div>
      <div class="value">${it.value}</div>
      <div class="foot">${it.foot}</div>
    </div>`).join('');

  document.getElementById('ic-stat-case-total').textContent = S.has_case;
  document.getElementById('ic-stat-onboard-active').textContent = S.onboarding_active;
  document.getElementById('ic-stat-onboard-stalled').textContent = S.onboarding_stalled;
  document.getElementById('ic-stat-1').textContent = S.contract_active + S.contract_stalled;
  document.getElementById('ic-stat-2').textContent = S.contract_active;
  document.getElementById('ic-stat-3').textContent = S.contract_stalled;
  document.getElementById('ns-rescued-stat').textContent = S.ns_edit_rescued;
}

function renderLikelihoodBars(){
  const total = S.total_assignments;
  const rows = [
    {k:"Onboarding - Active", v:S.onboarding_active, c:"var(--onboard)"},
    {k:"Onboarding - Stalled", v:S.onboarding_stalled, c:"var(--onboard-stall)"},
    {k:"Contract Negotiation - Active", v:S.contract_active, c:"var(--contract)"},
    {k:"Contract Negotiation - Stalled", v:S.contract_stalled, c:"var(--contract-stall)"},
    {k:"Hot", v:S.hot, c:"var(--hot)"},
    {k:"Warm", v:S.warm, c:"var(--warm)"},
    {k:"Cold", v:S.cold, c:"var(--cold)"},
    {k:"Stalled", v:S.stalled, c:"var(--stalled)"},
    {k:"No Opportunity", v:S.no_opp_bucket, c:"var(--noopp)"},
  ];
  document.getElementById('likelihood-bars').innerHTML = rows.map(r=>`
    <div class="hbar-row">
      <div class="hbar-label">${r.k}</div>
      <div class="hbar-track"><div class="hbar-fill" style="width:${(100*r.v/total).toFixed(1)}%; background:${r.c};"></div></div>
      <div class="hbar-value">${r.v} · ${Math.round(100*r.v/total)}%</div>
    </div>`).join('');
}

function renderMotionBars(){
  const maxAcc = Math.max(...MOTIONS.map(m=>m.accounts));
  document.getElementById('motion-bars').innerHTML = MOTIONS.map(m=>`
    <div class="hbar-row">
      <div class="hbar-label">${m.motion}</div>
      <div class="hbar-track"><div class="hbar-fill" style="width:${(100*m.accounts/maxAcc).toFixed(1)}%; background:var(--accent);"></div></div>
      <div class="hbar-value">${m.accounts} accts</div>
    </div>`).join('') + `
    <div style="margin-top:10px; font-size:11.5px; color:var(--text-dim);">
      ${MOTIONS.map(m=>`<div style="display:flex; justify-content:space-between; padding:4px 0; border-top:1px solid var(--border-soft);"><span>${m.motion}</span><span class="mono">${m.reps} reps · ${fmtMoney(m.total_y1)} Y1 · ${m.zero_touch} zero-touch</span></div>`).join('')}
    </div>`;
}

function renderZeroTouchSummary(){
  const zt = ACCOUNTS.filter(a=>a.zero_touch);
  const byRep = {};
  zt.forEach(a=>{ byRep[a.assigned_owner] = (byRep[a.assigned_owner]||0)+1; });
  const arr = Object.entries(byRep).sort((a,b)=>b[1]-a[1]).slice(0,12);
  const max = Math.max(...arr.map(x=>x[1]));
  document.getElementById('zero-touch-summary').innerHTML = `
    <div style="font-size:12px; color:var(--text-dim); margin-bottom:12px;">Top reps by zero-touch account count — ${zt.length} accounts total need an immediate touchpoint to meet the 2026 must-close standard.</div>
    ` + arr.map(([name,count])=>`
    <div class="hbar-row">
      <div class="hbar-label">${escapeHtml(name)}</div>
      <div class="hbar-track"><div class="hbar-fill" style="width:${(100*count/max).toFixed(1)}%; background:var(--stalled);"></div></div>
      <div class="hbar-value">${count}</div>
    </div>`).join('');
}

// ================================================================
// REP COVERAGE
// ================================================================
function ringSVG(pct, color){
  const r = 30, c = 2*Math.PI*r;
  const off = c*(1-pct/100);
  return `<svg width="74" height="74" viewBox="0 0 74 74">
    <circle cx="37" cy="37" r="${r}" fill="none" stroke="var(--panel-3)" stroke-width="7"/>
    <circle cx="37" cy="37" r="${r}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${off}"/>
  </svg>`;
}
function renderRepGrid(){
  const search = (document.getElementById('rep-search').value||"").toLowerCase();
  const sortKey = document.getElementById('rep-sort').value;
  let list = REPS.filter(r=>r.name.toLowerCase().includes(search));
  list.sort((a,b)=>b[sortKey]-a[sortKey]);
  document.getElementById('rep-grid').innerHTML = list.map(r=>{
    const touchedPct = Math.round(100*(r.accounts-r.zero_touch)/r.accounts);
    const color = touchedPct>=80 ? 'var(--hot)' : (touchedPct>=50 ? 'var(--warm)' : 'var(--stalled)');
    const rampBadge = r.ramp_status === 'Ramping'
      ? `<span class="chip chip-warm" title="Placeholder methodology: 180-day linear ramp from earliest pipeline evidence (${escapeHtml(r.earliest_pipeline_evidence||'')}). Swap in Aris's real ramp curve when available.">Ramping ${r.ramp_pct}%</span>`
      : (r.ramp_status === 'Fully Ramped' ? '' : '');
    const totalSplitRev = (r.new_logo_y1||0) + (r.expansion_y1||0);
    const newLogoPct = totalSplitRev ? Math.round(100*r.new_logo_y1/totalSplitRev) : 0;
    return `
    <div class="rep-card">
      <div class="ring-wrap">${ringSVG(touchedPct, color)}<div class="ring-label">${touchedPct}%</div></div>
      <div class="rep-info">
        <div class="rep-name">${escapeHtml(r.name)} ${rampBadge}</div>
        <div class="rep-meta">${r.accounts} accts · ${r.motions.join(', ')}${r.split>0 ? ' · '+r.split+' split':''}</div>
        <div class="rep-stats">
          <div class="rep-stat">Zero-touch <b style="color:var(--stalled)">${r.zero_touch}</b></div>
          <div class="rep-stat">Weighted <b>${fmtMoney(r.weighted_y1)}</b></div>
          <div class="rep-stat">Eng. <b>${r.avg_engagement}</b></div>
        </div>
        ${totalSplitRev>0 ? `
        <div style="margin-top:6px;">
          <div class="hbar-track" style="height:8px; position:relative; overflow:hidden;">
            <div style="position:absolute; left:0; top:0; height:100%; width:${newLogoPct}%; background:var(--hot);"></div>
            <div style="position:absolute; right:0; top:0; height:100%; width:${100-newLogoPct}%; background:var(--contract);"></div>
          </div>
          <div style="font-size:10px; color:var(--text-faint); margin-top:3px;">New Logo ${fmtMoney(r.new_logo_y1)} (${newLogoPct}%) · Expansion ${fmtMoney(r.expansion_y1)} (${100-newLogoPct}%)</div>
        </div>` : ''}
        <div class="rep-stats" style="margin-top:5px;">
          <span class="chip chip-onboard">${r.onboarding_active} onboarding</span>
          <span class="chip chip-onboard-stall">${r.onboarding_stalled} stalled onboarding</span>
          <span class="chip chip-contract">${r.contract_active} in contract</span>
          <span class="chip chip-stalled">${r.stalled}+${r.no_opp} at risk</span>
        </div>
      </div>
    </div>`;
  }).join('') || `<div class="empty-state">No reps match "${escapeHtml(search)}"</div>`;
}
document.getElementById('rep-search').addEventListener('input', renderRepGrid);
document.getElementById('rep-sort').addEventListener('change', renderRepGrid);

// ================================================================
// ACCOUNT EXPLORER
// ================================================================
let zeroTouchOnly = false, splitOnly = false;
let sortState = {key:'total_y1_expected_revenue', dir:-1};

function populateAccountFilters(){
  const repSel = document.getElementById('filter-rep');
  const owners = [...new Set(ACCOUNTS.map(a=>a.assigned_owner))].sort();
  repSel.innerHTML = '<option value="">All reps</option>' + owners.map(o=>`<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');

  const motionSel = document.getElementById('filter-motion');
  const motions = [...new Set(ACCOUNTS.map(a=>a.motion))].sort();
  motionSel.innerHTML = '<option value="">All motions</option>' + motions.map(m=>`<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');

  const likSel = document.getElementById('filter-likelihood');
  const liks = ["Onboarding - Active","Onboarding - Stalled","Contract Negotiation - Active","Contract Negotiation - Stalled","Hot","Warm","Cold","Stalled","No Opportunity"];
  likSel.innerHTML = '<option value="">All</option>' + liks.map(l=>`<option value="${l}">${l}</option>`).join('');
}

function currentFilteredAccounts(){
  const search = (document.getElementById('acct-search').value||"").toLowerCase();
  const rep = document.getElementById('filter-rep').value;
  const motion = document.getElementById('filter-motion').value;
  const lik = document.getElementById('filter-likelihood').value;
  let list = ACCOUNTS.filter(a=>{
    if(search && !(a.account.toLowerCase().includes(search) || a.assigned_owner.toLowerCase().includes(search) || a.account_owner.toLowerCase().includes(search))) return false;
    if(rep && a.assigned_owner!==rep) return false;
    if(motion && a.motion!==motion) return false;
    if(lik && a.likelihood!==lik) return false;
    if(zeroTouchOnly && !a.zero_touch) return false;
    if(splitOnly && !a.split_coverage) return false;
    return true;
  });
  list.sort((a,b)=>{
    let av=a[sortState.key], bv=b[sortState.key];
    const na = (av===null||av===undefined);
    const nb = (bv===null||bv===undefined);
    if(typeof (av ?? bv) === 'string'){
      av = av||""; bv = bv||"";
      return sortState.dir * (av<bv?-1:av>bv?1:0);
    }
    if(na && nb) return 0;
    if(na) return 1;
    if(nb) return -1;
    return sortState.dir * (bv-av) * -1;
  });
  return list;
}

function originChipClass(origin){
  const map = {
    "BDR Outbound": "chip-hot",
    "Inbound": "chip-contract",
    "Event": "chip-warm",
    "Referral": "chip-onboard",
    "Existing Client / Expansion": "chip-split",
    "Prospecting List": "chip-noopp",
    "Not Logged": "chip-pending-data",
  };
  return map[origin] || "chip-pending-data";
}
function cycleCellHtml(a){
  if(a.cycle_status === "Unknown" || a.cycle_day===null || a.cycle_total===null){
    return '<span style="color:var(--text-faint); font-style:italic;">n/a</span>';
  }
  const cls = a.cycle_status === "Maturing" ? "chip-onboard" : "chip-contract-stall";
  return `<span class="chip ${cls}" title="${a.cycle_status}: day ${a.cycle_day} of a ${a.cycle_total}-day planned cycle (based on this opp's own Created→Close dates)">${a.cycle_day}/${a.cycle_total}d</span>`;
}
function renderAccountsTable(){
  const list = currentFilteredAccounts();
  document.getElementById('accounts-count-label').textContent = `Showing ${list.length} of ${ACCOUNTS.length} assignments`;
  const tbody = document.getElementById('accounts-tbody');
  if(list.length===0){ tbody.innerHTML = `<tr><td colspan="13"><div class="empty-state">No accounts match these filters</div></td></tr>`; return; }
  tbody.innerHTML = list.map((a,i)=>{
    const engColor = a.engagement_score>=70?'var(--hot)':a.engagement_score>=40?'var(--warm)':'var(--stalled)';
    return `<tr data-idx="${ACCOUNTS.indexOf(a)}">
      <td>${escapeHtml(a.account)}${a.has_trading_opp?' <span class="chip chip-gm" style="margin-left:4px;">GM</span>':''}${a.calendar_meeting_found?' <span class="chip chip-onboard" style="margin-left:4px;" title="Live meeting found on Sung\'s own Google Calendar">LM</span>':''}${a.stablecoin_collision?' <span class="chip chip-contract-stall" style="margin-left:4px;" title="Stablecoin GTM collision — dual coverage with Stablecoins team">SC</span>':''}</td>
      <td>${escapeHtml(a.assigned_owner)}</td>
      <td>${escapeHtml(a.motion)}</td>
      <td><span class="chip ${originChipClass(a.origin)}" style="font-size:10px;">${escapeHtml(a.origin)}</span>${a.discovery_meeting_booked_by?`<div style="font-size:9.5px; color:var(--text-faint); margin-top:2px;">BDR: ${escapeHtml(a.discovery_meeting_booked_by)}</div>`:''}</td>
      <td>${escapeHtml(a.stage||'—')}</td>
      <td class="num">${a.total_y1_expected_revenue ? fmtMoney(a.total_y1_expected_revenue) : '—'}</td>
      <td class="num">${a.has_opportunity ? a.probability+'%' : '—'}</td>
      <td class="num">${cycleCellHtml(a)}</td>
      <td class="num">${fmtDays(a.days_since_activity)}${a.touch_source==='next_steps_edit'?' <span class="chip chip-onboard" style="padding:1px 6px; font-size:9.5px;" title="Freshest touch is a Next Steps field edit, not a logged Activity">NS✎</span>':''}</td>
      <td class="num"><span class="eng-bar"><span class="eng-bar-fill" style="width:${a.engagement_score}%; background:${engColor};"></span></span>${a.engagement_score}</td>
      <td><span class="chip ${LIK_CHIP[a.likelihood]}">${a.likelihood}</span></td>
      <td>${a.has_case ? escapeHtml(a.case_status) : '<span style="color:var(--text-faint); font-style:italic;">no case</span>'}</td>
      <td>${a.split_coverage ? '<span class="chip chip-split">Split</span>' : '—'}</td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('tr').forEach(tr=>{
    tr.addEventListener('click', ()=>openDrawer(ACCOUNTS[+tr.dataset.idx]));
  });
}

document.getElementById('acct-search').addEventListener('input', renderAccountsTable);
document.getElementById('filter-rep').addEventListener('change', renderAccountsTable);
document.getElementById('filter-motion').addEventListener('change', renderAccountsTable);
document.getElementById('filter-likelihood').addEventListener('change', renderAccountsTable);
document.getElementById('filter-zero-touch').addEventListener('click', (e)=>{
  zeroTouchOnly = !zeroTouchOnly;
  e.target.classList.toggle('active', zeroTouchOnly);
  renderAccountsTable();
});
document.getElementById('filter-split').addEventListener('click', (e)=>{
  splitOnly = !splitOnly;
  e.target.classList.toggle('active', splitOnly);
  renderAccountsTable();
});
document.getElementById('filter-clear').addEventListener('click', ()=>{
  document.getElementById('acct-search').value='';
  document.getElementById('filter-rep').value='';
  document.getElementById('filter-motion').value='';
  document.getElementById('filter-likelihood').value='';
  zeroTouchOnly=false; splitOnly=false;
  document.getElementById('filter-zero-touch').classList.remove('active');
  document.getElementById('filter-split').classList.remove('active');
  renderAccountsTable();
});
document.querySelectorAll('#panel-accounts thead th').forEach(th=>{
  th.addEventListener('click', ()=>{
    const key = th.dataset.key;
    if(sortState.key===key) sortState.dir *= -1; else { sortState.key=key; sortState.dir=-1; }
    document.querySelectorAll('#panel-accounts thead th').forEach(t=>t.classList.remove('sorted'));
    th.classList.add('sorted');
    renderAccountsTable();
  });
});

// ---------------- Drawer / detail ----------------
function openDrawer(a){
  const overlay = document.getElementById('drawer-overlay');
  const d = document.getElementById('drawer');
  d.innerHTML = `
    <button class="close-btn" onclick="closeDrawer()">&times;</button>
    <h2>${escapeHtml(a.account)}</h2>
    <div style="font-size:12.5px; color:var(--text-dim);">${escapeHtml(a.primary_client_type||'')} · ${escapeHtml(a.motion)} motion</div>
    <div style="margin-top:10px; display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
      <span class="chip ${LIK_CHIP[a.likelihood]}">${a.likelihood}</span>
      ${a.split_coverage ? '<span class="chip chip-split">Split coverage</span>':''}
      ${a.has_trading_opp ? '<span class="chip chip-gm">Global Markets product</span>':''}
      ${a.existing_client ? '<span class="chip" style="background:#243318;color:#a3d977;">Existing revenue client</span>':''}
      <button class="btn sf-refresh-btn" data-account-name="${escapeHtml(a.account)}" style="margin-left:auto;">↻ Refresh from Salesforce</button>
    </div>
    <div id="sf-refresh-status-${slackKey(a.account)}" style="font-size:11px; color:var(--text-faint); margin-top:6px;">${(window.__sfRefreshCache && window.__sfRefreshCache['sf_refresh_'+slackKey(a.account)]) ? 'Last refreshed from Salesforce ' + escapeHtml(window.__sfRefreshCache['sf_refresh_'+slackKey(a.account)].when) : ''}</div>

    <div class="drawer-section">
      <h4>Coverage</h4>
      <div class="kv">
        <div><span>Account Owner (base)</span>${escapeHtml(a.account_owner)}</div>
        <div><span>Assigned Owner (this motion)</span>${escapeHtml(a.assigned_owner)}</div>
        <div><span>Campaign</span>${escapeHtml(a.campaign)}</div>
        <div><span>Ironclad Workflow</span>${escapeHtml(a.ironclad_workflow||'—')}</div>
      </div>
      ${a.status_scope_mismatch ? `<div class="next-steps-box" style="border-left-color:var(--warm);">This is a Global Market assignment with no Trading-product opportunity yet — the stage/status shown falls back to a non-Trading opportunity on the account. Create a Trading opportunity to track this rep's actual coverage.</div>` : ''}
      ${a.stablecoin_collision ? `<div class="next-steps-box" style="border-left-color:var(--contract-stall);">Stablecoin GTM collision: this account is also tracked by the Stablecoins team. Both teams need a coordinated touchpoint.</div>` : ''}
    </div>

    <div class="drawer-section">
      <h4>Source &amp; Cycle</h4>
      <div class="kv">
        <div><span>Origin</span><span class="chip ${originChipClass(a.origin)}">${escapeHtml(a.origin)}</span></div>
        <div><span>Discovery meeting booked by</span>${a.discovery_meeting_booked_by?escapeHtml(a.discovery_meeting_booked_by):'—'}</div>
        <div><span>Cycle status</span>${a.cycle_status==='Unknown'?'n/a':`${a.cycle_status} (day ${a.cycle_day} of ${a.cycle_total})`}</div>
      </div>
      ${a.cycle_status==='Past Window' ? `<div class="next-steps-box" style="border-left-color:var(--contract-stall);">Past its own forecasted close date while still open — day ${a.cycle_day} against a ${a.cycle_total}-day planned cycle. Worth a status check, not just a reminder.</div>` : ''}
      ${a.cycle_status==='Maturing' ? `<div class="next-steps-box" style="border-left-color:var(--onboard); color:var(--text-dim);">Still within its own planned cycle (day ${a.cycle_day} of ${a.cycle_total}) — not stalled, just maturing.</div>` : ''}
    </div>

    ${a.has_ironclad ? `
    <div class="drawer-section">
      <h4>Contract negotiation status</h4>
      <div class="kv">
        <div><span>Workflow launched (proxy: opp Created Date)</span>${escapeHtml(a.workflow_created_date||'—')}${a.days_since_workflow_launch!==null?` (${a.days_since_workflow_launch}d ago)`:''}</div>
        <div><span>Last modified (proxy: opp Last Modified Date)</span>${escapeHtml(a.workflow_modified_date||'—')}${a.days_since_workflow_modified!==null?` (${a.days_since_workflow_modified}d ago)`:''}</div>
      </div>
      <div class="next-steps-box" style="border-left-color:${a.likelihood==='Contract Negotiation - Stalled'?'var(--contract-stall)':'var(--contract)'};">
        ${a.likelihood==='Contract Negotiation - Stalled'
          ? 'No document movement in 21+ days — flag for legal/KYC follow-up before this quietly stalls in redlines.'
          : 'Workflow is moving — recent document activity within the last 21 days.'}
      </div>
      <div style="font-size:10.5px; color:var(--text-faint); margin-top:6px;">Note: these dates are proxied from the linked opportunity, since Ironclad's own Created/Last Modified timestamps aren't in the source export. Swap in the real Account-page Ironclad dates for precision.</div>
    </div>` : ''}

    <div class="drawer-section">
      <h4>Onboarding / KYC case</h4>
      ${a.has_case ? `
      <div class="kv">
        <div><span>Case number</span>${escapeHtml(a.case_number)}</div>
        <div><span>Case status</span><span class="chip ${a.likelihood==='Onboarding - Active'?'chip-onboard':a.likelihood==='Onboarding - Stalled'?'chip-onboard-stall':'chip-pending-data'}">${escapeHtml(a.case_status)}</span></div>
        <div><span>Case owner</span>${escapeHtml(a.case_owner)}</div>
        <div><span>Case type</span>${escapeHtml(a.case_type)}</div>
        <div><span>Opened</span>${escapeHtml(a.case_opened_date||'—')}</div>
        <div><span>Last modified</span>${escapeHtml(a.case_last_modified_date||'—')}${a.days_since_case_modified!==null?` (${a.days_since_case_modified}d ago)`:''}</div>
      </div>
      ${a.case_transition_notes ? `<div class="next-steps-box" style="border-left-color:${a.likelihood==='Onboarding - Stalled'?'var(--onboard-stall)':'var(--onboard)'};"><b>Transition notes:</b><br/>${escapeHtml(a.case_transition_notes)}</div>` : `<div class="next-steps-box" style="border-left-color:var(--text-faint); color:var(--text-faint);">No transition notes logged on this case.</div>`}
      ${a.total_cases_for_account>1 ? `<div style="font-size:10.5px; color:var(--text-faint); margin-top:6px;">${a.total_cases_for_account} total cases on this account (${a.active_cases_for_account} active) — showing the most relevant one.</div>` : ''}
      <div style="font-size:10.5px; color:var(--text-faint); margin-top:4px;">Matched via ${a.case_matched_via_id ? 'Account Id (precise)' : 'account name (fallback — no Account Id on this row)'}.</div>
      ` : `
      <div class="kv">
        <div><span>Case status</span><span class="chip chip-pending-data">No case matched</span></div>
        <div><span>Case reason</span>—</div>
      </div>
      <div class="next-steps-box" style="border-left-color:var(--text-faint); color:var(--text-faint);">No onboarding Case record matched this account name in the KYC_Case_RevOps export.</div>
      `}
    </div>

    <div class="drawer-section">
      <h4>Revenue opportunity</h4>
      <div class="kv">
        <div><span>Open Y1 expected revenue</span>${a.total_y1_expected_revenue?fmtMoney(a.total_y1_expected_revenue):'—'}</div>
        <div><span>Weighted (× probability)</span>${a.weighted_y1_expected_revenue?fmtMoney(a.weighted_y1_expected_revenue):'—'}</div>
        <div><span>Trading-product Y1 revenue</span>${a.trading_y1_expected_revenue?fmtMoney(a.trading_y1_expected_revenue):'$0'}</div>
        <div><span>FY26 actual revenue (if existing client)</span>${a.existing_client?fmtMoney(a.fy26_actual_revenue):'n/a — net-new logo'}</div>
      </div>
    </div>

    <div class="drawer-section">
      <h4>Engagement</h4>
      <div class="kv">
        <div><span>Engagement score</span>${a.engagement_score} / 100</div>
        <div><span>Days since last touch</span>${fmtDays(a.days_since_activity)}${a.touch_source==='next_steps_edit'?' <span class="chip chip-onboard">via Next Steps edit</span>':a.touch_source==='last_activity'?' <span class="chip chip-pending-data">via logged Activity</span>':''}</div>
      </div>
      ${a.next_steps ? `<div class="next-steps-box"><b>Next steps${a.touch_source==='next_steps_edit'?' (from field-edit history — most current)':' (Salesforce)'}:</b><br/>${escapeHtml(a.next_steps)}</div>` : `<div class="next-steps-box" style="border-left-color:var(--stalled);">No next steps logged — data quality / bottleneck flag.</div>`}
      <div class="slack-box" id="slack-box-${slackKey(a.account)}">
        ${renderSlackBoxContent(a)}
      </div>
      ${a.calendar_checked ? `
      <div class="slack-box" style="margin-top:8px; background:linear-gradient(135deg, #1a1220, #0f1620); border-color:#4a2b57;">
        <div class="slack-title" style="color:#c99ee0;">📅 Calendar signal <span class="chip chip-onboard">Live meeting found</span></div>
        <p>${escapeHtml(a.calendar_summary)}</p>
        <div style="font-size:10.5px; color:var(--text-faint);">Checked against Sung's own Google Calendar only — see Overview tab for scope limits.</div>
      </div>` : ''}
    </div>

    ${a.opps && a.opps.length ? `
    <div class="drawer-section">
      <h4>Open opportunities (${a.opps.length})</h4>
      ${a.opps.map(o=>`
        <div class="opp-card">
          <div class="opp-name">${escapeHtml(o.name)} ${o.trading?'<span class="chip chip-gm" style="margin-left:4px;">GM</span>':''}</div>
          <div class="opp-meta">${escapeHtml(o.stage)} · ${escapeHtml(o.product_line)}</div>
          <div class="opp-meta">${fmtMoney(o.y1_rev)} Y1 · ${o.probability}% prob · close ${escapeHtml(o.close_date)} · owner ${escapeHtml(o.owner)}</div>
          <div class="opp-meta">Last activity: ${o.last_activity_date?escapeHtml(o.last_activity_date):'none logged'} (${fmtDays(o.days_since_activity)})</div>
          ${o.next_steps_edit_date ? `<div class="opp-meta">Next Steps last edited: ${escapeHtml(o.next_steps_edit_date)} (${fmtDays(o.days_since_next_steps_edit)}) — "${escapeHtml(o.next_steps_edit_value)}"</div>` : ''}
          <div class="opp-meta" style="color:var(--accent);">2026 realizable: ${fmtMoney(o.realizable_2026_revenue||0)}${o.pro_ration_months!==undefined?` (${o.pro_ration_months.toFixed(1)} mo. after 60-day ramp)`:''}</div>
        </div>`).join('')}
    </div>` : `<div class="drawer-section"><h4>Open opportunities</h4><div class="next-steps-box" style="border-left-color:var(--noopp);">No open opportunity exists for this must-close account yet — create one to start tracking progress.</div></div>`}
  `;
  overlay.classList.add('open');
}
function closeDrawer(){ document.getElementById('drawer-overlay').classList.remove('open'); }
document.getElementById('drawer-overlay').addEventListener('click', (e)=>{
  if(e.target.id==='drawer-overlay'){ closeDrawer(); return; }
  const btn = e.target.closest('.slack-pull-btn');
  if(btn){
    const name = btn.dataset.accountName;
    runLiveSlackPull(name);
  }
  const sfBtn = e.target.closest('.sf-refresh-btn');
  if(sfBtn){
    const name = sfBtn.dataset.accountName;
    refreshAccountFromSalesforce(name);
  }
});

// ================================================================
// MCP CONNECTOR HELPERS — shared by the Slack and Salesforce
// live-lookup buttons below. Both discover the viewer's connector
// at call time via window.claude.mcp.listTools() rather than
// hardcoding a tool name, since the exact tool names/shapes for
// this artifact's connectors were not observable at authoring time.
// See the accompanying chat reply for that caveat in full.
// ================================================================
async function discoverConnectorTool(candidateServerNames, toolTest){
  if(!window.claude || !window.claude.mcp) return null;
  let list;
  try{ list = await window.claude.mcp.listTools(); }catch(e){ return null; }
  const servers = (list && list.servers) || [];
  for(const server of servers){
    if(!candidateServerNames.some(c=>c.toLowerCase()===server.server.toLowerCase())) continue;
    if(!server.tools || !server.tools.length) continue;
    const tool = server.tools.find(toolTest);
    if(tool) return { server: server.server, tool: tool.name };
  }
  return null;
}
function summarizePayloadForDisplay(payload, maxChars){
  maxChars = maxChars || 1200;
  if(payload == null) return "(empty response)";
  if(typeof payload === "string") return payload.slice(0, maxChars);
  if(Array.isArray(payload)){
    const lines = payload.slice(0, 8).map(item=>{
      if(item && typeof item === "object"){
        const text = item.text || item.message || item.snippet || item.summary || item.title;
        if(text) return String(text).slice(0, 240);
      }
      return JSON.stringify(item).slice(0, 240);
    });
    return lines.join("\n\n").slice(0, maxChars) || "(no results)";
  }
  return JSON.stringify(payload, null, 2).slice(0, maxChars);
}

// ================================================================
// SLACK SIGNAL — baked findings from this session's live research,
// plus a genuinely functional on-demand pull for every other account.
// ================================================================
function slackKey(accountName){
  // window.storage keys can't contain whitespace, slashes, or quotes
  return 'slack_live_' + accountName.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 80);
}

function findAccountByName(name){
  return ACCOUNTS.find(a => a.account === name);
}

function renderSlackBoxContent(a){
  // 1) Baked-in real finding from this session's research batch
  if(a.slack_checked){
    const blockerBadge = a.slack_blocker_flag ? `<span class="chip chip-contract-stall" style="margin-left:6px;">Blocker found</span>` : '';
    const tentativeBadge = a.slack_tentative ? `<span class="chip chip-pending-data" style="margin-left:6px;">Unconfirmed match</span>` : '';
    const foundBadge = a.slack_signal_found ? `<span class="chip chip-onboard">Signal found</span>` : `<span class="chip chip-pending-data">No signal found</span>`;
    return `
      <div class="slack-title">💬 Slack signal ${foundBadge}${blockerBadge}${tentativeBadge}</div>
      <p>${escapeHtml(a.slack_summary)}</p>
      <div style="font-size:10.5px; color:var(--text-faint); margin-bottom:8px;">Checked ${escapeHtml(a.slack_checked_date)} · slack_search_public_and_private</div>
      <button class="btn slack-pull-btn" data-account-name="${escapeHtml(a.account)}">Re-check live</button>
    `;
  }
  // 2) A previous live pull this session, cached in storage
  try{
    const cacheRaw = window.__slackCache && window.__slackCache[slackKey(a.account)];
    if(cacheRaw){
      return `
        <div class="slack-title">💬 Slack signal <span class="chip chip-onboard">Live result</span></div>
        <p>${escapeHtml(cacheRaw.summary)}</p>
        <div style="font-size:10.5px; color:var(--text-faint); margin-bottom:8px;">Pulled live ${escapeHtml(cacheRaw.when)}</div>
        <button class="btn slack-pull-btn" data-account-name="${escapeHtml(a.account)}">Re-check live</button>
      `;
    }
  }catch(e){}
  // 3) Not yet checked — offer the live pull
  return `
    <div class="slack-title">💬 Slack signal <span style="font-weight:400; color:var(--text-faint); font-size:10.5px;">(live, on-demand)</span></div>
    <p>Search your connected Slack workspace for recent mentions of "${escapeHtml(a.account)}" — deal chatter, blockers, or win/loss signal not yet logged in Salesforce.</p>
    <button class="btn slack-pull-btn" data-account-name="${escapeHtml(a.account)}">Pull Slack Signal</button>
  `;
}

async function runLiveSlackPull(accountName){
  const key = slackKey(accountName);
  const boxEl = document.getElementById('slack-box-' + key);
  if(!boxEl) return;
  boxEl.innerHTML = `<div class="slack-title">💬 Slack signal</div><p>Searching Slack for "${escapeHtml(accountName)}"…</p>`;
  if(!window.claude || !window.claude.mcp){
    boxEl.innerHTML = `
      <div class="slack-title">💬 Slack signal</div>
      <p style="color:var(--stalled);">This page has no MCP connector bridge in this viewer session — Slack search isn't available here.</p>
      <button class="btn slack-pull-btn" data-account-name="${escapeHtml(accountName)}">Try again</button>
    `;
    return;
  }
  try{
    const conn = await discoverConnectorTool(["Slack"], t=>/search/i.test(t.name));
    if(!conn) throw Object.assign(new Error("No connected Slack connector tool was found for this viewer. Connect Slack in claude.ai Settings → Connectors, then try again."), {code:"server_not_connected"});
    const result = await window.claude.mcp.callTool(conn.server, conn.tool, {
      query: `"${accountName}" deal OR contract OR blocker OR client`,
    });
    const summary = summarizePayloadForDisplay(result.payload);
    const when = new Date().toLocaleString();
    window.__slackCache = window.__slackCache || {};
    window.__slackCache[key] = { summary, when };
    try{ await window.storage.set(key, JSON.stringify({ summary, when })); }catch(e){}
    boxEl.innerHTML = `
      <div class="slack-title">💬 Slack signal <span class="chip chip-onboard">Live result</span></div>
      <p>${escapeHtml(summary)}</p>
      <div style="font-size:10.5px; color:var(--text-faint); margin-bottom:8px;">Pulled live ${escapeHtml(when)} via ${escapeHtml(conn.server)}</div>
      <button class="btn slack-pull-btn" data-account-name="${escapeHtml(accountName)}">Re-check live</button>
    `;
  }catch(err){
    const code = err && err.code;
    let hint = "Something went wrong running this search.";
    if(code === "needs_reauth") hint = "Reconnect Slack in claude.ai Settings → Connectors, then try again.";
    else if(code === "server_not_connected") hint = "Add Slack in claude.ai Settings → Connectors, then try again.";
    else if(code === "not_granted" || code === "capability_disabled") hint = "This artifact doesn't have MCP access granted in this view.";
    boxEl.innerHTML = `
      <div class="slack-title">💬 Slack signal</div>
      <p style="color:var(--stalled);">${escapeHtml(hint)} (${escapeHtml(String((err && err.message) || err))})</p>
      <button class="btn slack-pull-btn" data-account-name="${escapeHtml(accountName)}">Try again</button>
    `;
  }
}

// Warm the in-memory Slack cache from persistent storage for any accounts pulled in earlier sessions
(async function preloadSlackCache(){
  window.__slackCache = window.__slackCache || {};
  try{
    const list = await window.storage.list('slack_live_');
    if(list && list.keys){
      for(const k of list.keys){
        try{
          const res = await window.storage.get(k);
          if(res && res.value) window.__slackCache[k] = JSON.parse(res.value);
        }catch(e){}
      }
    }
  }catch(e){ /* storage may be unavailable; live pulls still work, just without cross-session cache */ }
})();

// ================================================================
// SALESFORCE LIVE REFRESH — pulls current Opportunity + Case status
// for one account via SOQL (through the Salesforce MCP connector)
// and recomputes that account's engagement score/likelihood in place.
// Field API names confirmed against the org schema:
//   Opportunity: StageName, Product_Line__c, Y1_Expected_Revenue__c,
//                Probability, CloseDate, LastActivityDate, Next_Steps__c,
//                CreatedDate, LastModifiedDate, Owner.Name
//   Case: CaseNumber, Status, Type, Owner.Name, CreatedDate,
//         LastModifiedDate, Transition_Notes__c
// ================================================================
const TRADING_PRODUCTS_JS = ["Trading - Spot (Hold)", "Trading - Spot (A1)", "Trading - Derivatives (A1)", "Trading - Margin (A1)"];
const ACTIVE_CASE_STATUSES_JS = ["Pending", "Open", "On Hold", "In Progress", "New"];
const CONTRACT_ACTIVE_THRESHOLD_JS = 21;

function recencyScoreJS(days){
  if(days===null||days===undefined) return 0;
  if(days<=14) return 100;
  if(days<=30) return 80;
  if(days<=60) return 60;
  if(days<=90) return 40;
  if(days<=180) return 20;
  return 5;
}
function isTradingJS(productLine){
  if(!productLine) return false;
  let parts;
  const trimmed = productLine.trim();
  if(trimmed.startsWith('[')){
    try{
      const parsed = JSON.parse(trimmed);
      parts = Array.isArray(parsed) ? parsed.map(String) : [];
    }catch(e){
      parts = trimmed.replace(/^\[|\]$/g,'').split(',').map(s=>s.replace(/^"|"$/g,''));
    }
  } else {
    parts = productLine.split(';');
  }
  const norm = s => (s||'').toLowerCase().replace(/-/g,' ').replace(/\s+/g,' ').trim();
  const tradingNorm = TRADING_PRODUCTS_JS.map(norm);
  return parts.map(norm).some(p=>tradingNorm.includes(p));
}
function daysBetweenJS(dateStr){
  if(!dateStr) return null;
  const d = new Date(dateStr);
  if(isNaN(d.getTime())) return null;
  const today = new Date(2026,6,30); // dashboard's "as of" date
  return Math.round((today - d) / 86400000);
}
function classifyOriginJS(leadSource, oppType, discoveryBookedBy){
  leadSource = (leadSource||'').trim();
  oppType = (oppType||'').trim();
  discoveryBookedBy = (discoveryBookedBy||'').trim();
  if(oppType==='Add-On Business' || oppType==='Renewal (Porto)' || leadSource==='Existing Client') return 'Existing Client / Expansion';
  if(leadSource==='Event') return 'Event';
  if(['Referral - Employee','Referral - Customer','Referral - Partner'].includes(leadSource)) return 'Referral';
  if(leadSource==='Website - Contact Us Form') return 'Inbound';
  if(['Sales Prospected','Outbound - Cross Sell'].includes(leadSource)) return 'BDR Outbound';
  if(['AdvizorPro','LinkedIn Sales Navigator','Purchased List'].includes(leadSource)) return 'Prospecting List';
  if(discoveryBookedBy) return 'BDR Outbound';
  return 'Not Logged';
}
function cycleMaturityJS(createdDateStr, closeDateStr){
  const created = createdDateStr ? new Date(createdDateStr) : null;
  const close = closeDateStr ? new Date(closeDateStr) : null;
  if(!created || isNaN(created.getTime()) || !close || isNaN(close.getTime())) return {cycleDay:null, cycleTotal:null, cycleStatus:'Unknown'};
  const today = new Date(2026,6,30);
  const cycleDay = Math.round((today - created) / 86400000);
  const cycleTotal = Math.round((close - created) / 86400000);
  if(cycleTotal <= 0) return {cycleDay, cycleTotal, cycleStatus:'Unknown'};
  return {cycleDay, cycleTotal, cycleStatus: cycleDay <= cycleTotal ? 'Maturing' : 'Past Window'};
}
const YEAR_END_2026_JS = new Date(2026,11,31);
const RAMP_DAYS_JS = 60;
const AVG_DAYS_PER_MONTH_JS = 365.25/12;
function realizable2026JS(y1Revenue, probability, closeDateStr){
  if(!closeDateStr || !y1Revenue || !probability) return {realizable:0, proRationMonths:0};
  const closeDt = new Date(closeDateStr);
  if(isNaN(closeDt.getTime())) return {realizable:0, proRationMonths:0};
  const rampEnd = new Date(closeDt.getTime() + RAMP_DAYS_JS*86400000);
  const daysRemaining = (YEAR_END_2026_JS - rampEnd) / 86400000;
  let proRationMonths = daysRemaining / AVG_DAYS_PER_MONTH_JS;
  proRationMonths = Math.max(0, Math.min(12, proRationMonths));
  const monthlyRate = y1Revenue/12;
  const realizable = monthlyRate * (probability/100) * proRationMonths;
  return {realizable, proRationMonths};
}
function likelihoodBucketJS(prob, daysSinceTouch, hasOpp, hasCase, isCaseActive, caseStatus, daysSinceCaseModified){
  if(hasCase && isCaseActive){
    if(caseStatus==='On Hold') return 'Onboarding - Stalled';
    if(daysSinceCaseModified!==null && daysSinceCaseModified<=CONTRACT_ACTIVE_THRESHOLD_JS) return 'Onboarding - Active';
    return 'Onboarding - Stalled';
  }
  if(!hasOpp) return 'No Opportunity';
  if(daysSinceTouch===null || daysSinceTouch>120) return 'Stalled';
  if(prob>=50 && daysSinceTouch<=30) return 'Hot';
  if(prob>=25 || daysSinceTouch<=60) return 'Warm';
  return 'Cold';
}

// Warm a light cache of prior "last refreshed from Salesforce" timestamps across sessions
window.__sfRefreshCache = window.__sfRefreshCache || {};
(async function preloadSfRefreshCache(){
  try{
    const list = await window.storage.list('sf_refresh_');
    if(list && list.keys){
      for(const k of list.keys){
        try{
          const res = await window.storage.get(k);
          if(res && res.value) window.__sfRefreshCache[k] = JSON.parse(res.value);
        }catch(e){}
      }
    }
  }catch(e){}
})();

function applyLiveDataToAccount(a, opps, cases){
  // ---- pick the representative opportunity (GM rows prefer Trading product) ----
  let pool = opps;
  if(a.is_gm_motion){
    const tradingPool = opps.filter(o=>isTradingJS(o.product_line));
    if(tradingPool.length) pool = tradingPool;
  }
  let bestOpp = null, bestDays = null;
  for(const o of pool){
    const days = daysBetweenJS(o.last_activity_date);
    if(days!==null && (bestDays===null || days<bestDays)){ bestDays = days; bestOpp = o; }
  }
  if(!bestOpp && pool.length) bestOpp = pool[0];

  // ---- pick the representative case (prefer active, most recently modified) ----
  const activeCases = cases.filter(c=>ACTIVE_CASE_STATUSES_JS.includes(c.status));
  const casePool = activeCases.length ? activeCases : cases;
  let bestCase = null, bestCaseDt = null;
  for(const c of casePool){
    const dt = new Date(c.last_modified_date || c.created_date);
    if(!isNaN(dt.getTime()) && (bestCaseDt===null || dt>bestCaseDt)){ bestCaseDt = dt; bestCase = c; }
  }
  const hasCase = !!bestCase;
  const isCaseActive = hasCase && ACTIVE_CASE_STATUSES_JS.includes(bestCase.status);
  const daysSinceCaseModified = hasCase ? daysBetweenJS(bestCase.last_modified_date || bestCase.created_date) : null;

  // ---- update the account record in place ----
  a.opps = opps.map(o => {
    const days = daysBetweenJS(o.last_activity_date);
    const { realizable, proRationMonths } = realizable2026JS(o.y1_revenue||0, o.probability||0, o.close_date);
    return {
      name: o.name, stage: o.stage, product_line: o.product_line || "",
      trading: isTradingJS(o.product_line), y1_rev: o.y1_revenue || 0,
      probability: o.probability || 0, close_date: o.close_date || "",
      last_activity_date: o.last_activity_date || "", days_since_activity: days,
      next_steps: o.next_steps || "", owner: o.owner || "",
      realizable_2026_revenue: Math.round(realizable*100)/100,
      pro_ration_months: Math.round(proRationMonths*100)/100,
      lead_source: o.lead_source || "", type: o.type || "",
      discovery_meeting_booked_by: o.discovery_meeting_booked_by || "",
      created_date: o.created_date || ""
    };
  });
  a.total_y1_expected_revenue = a.opps.reduce((s,o)=>s+(o.y1_rev||0), 0);
  a.weighted_y1_expected_revenue = a.opps.reduce((s,o)=>s+(o.y1_rev||0)*(o.probability||0)/100, 0);
  a.realizable_2026_revenue = a.opps.reduce((s,o)=>s+(o.realizable_2026_revenue||0), 0);
  a.trading_y1_expected_revenue = a.opps.filter(o=>o.trading).reduce((s,o)=>s+(o.y1_rev||0), 0);
  a.has_trading_opp = a.trading_y1_expected_revenue > 0;
  a.days_since_activity = bestOpp ? daysBetweenJS(bestOpp.last_activity_date) : a.days_since_activity;
  a.stage = bestOpp ? bestOpp.stage : a.stage;
  a.probability = bestOpp ? (bestOpp.probability||0) : a.probability;
  a.next_steps = bestOpp ? (bestOpp.next_steps||"") : a.next_steps;
  a.close_date = bestOpp ? bestOpp.close_date : a.close_date;
  a.has_opportunity = opps.length > 0;
  a.opp_count = opps.length;
  if(bestOpp){
    a.origin = classifyOriginJS(bestOpp.lead_source, bestOpp.type, bestOpp.discovery_meeting_booked_by);
    a.discovery_meeting_booked_by = bestOpp.discovery_meeting_booked_by || "";
    const cyc = cycleMaturityJS(bestOpp.created_date, bestOpp.close_date);
    a.cycle_day = cyc.cycleDay; a.cycle_total = cyc.cycleTotal; a.cycle_status = cyc.cycleStatus;
  }
  a.case_status = hasCase ? bestCase.status : a.case_status;
  a.case_owner = hasCase ? bestCase.owner : a.case_owner;
  a.case_number = hasCase ? bestCase.case_number : a.case_number;
  a.case_transition_notes = hasCase ? (bestCase.transition_notes||"") : a.case_transition_notes;
  a.days_since_case_modified = daysSinceCaseModified;
  a.has_case = hasCase || a.has_case;
  a.is_case_active = isCaseActive;

  const activityScore = recencyScoreJS(a.days_since_activity);
  const caseScore = hasCase && isCaseActive ? recencyScoreJS(daysSinceCaseModified) : -1;
  let engScore = Math.max(activityScore, caseScore);
  if(a.next_steps) engScore = Math.min(100, engScore + 10);
  a.engagement_score = engScore;
  a.likelihood = likelihoodBucketJS(a.probability, a.days_since_activity, a.has_opportunity, hasCase, isCaseActive, a.case_status, daysSinceCaseModified);
  const noActivity = (a.days_since_activity===null || a.days_since_activity>90);
  const noCaseSignal = (!hasCase) || (!isCaseActive) || (daysSinceCaseModified===null || daysSinceCaseModified>90);
  a.zero_touch = noActivity && noCaseSignal;

  return { oppCount: opps.length, caseCount: cases.length };
}

async function refreshAccountFromSalesforce(accountName){
  const a = findAccountByName(accountName);
  if(!a) return;
  const statusEl = document.getElementById('sf-refresh-status-' + slackKey(accountName));
  if(statusEl) statusEl.textContent = 'Querying Salesforce…';
  if(!window.claude || !window.claude.mcp){
    if(statusEl) statusEl.textContent = 'This page has no MCP connector bridge in this viewer session — Salesforce refresh isn\'t available here.';
    return;
  }
  try{
    const conn = await discoverConnectorTool(["Salesforce"], t=>/soql|query/i.test(t.name));
    if(!conn) throw Object.assign(new Error("No connected Salesforce connector tool was found for this viewer. Connect Salesforce in claude.ai Settings → Connectors, then try again."), {code:"server_not_connected"});

    const oppQuery = `SELECT Id, Name, StageName, Product_Line__c, Y1_Expected_Revenue__c, Probability, CloseDate, LastActivityDate, Next_Steps__c, CreatedDate, LastModifiedDate, Owner.Name, LeadSource, Type, Discovery_Meeting_Booked_By__c FROM Opportunity WHERE AccountId = '${a.account_id}' AND IsClosed = false`;
    const caseQuery = `SELECT CaseNumber, Status, Type, Owner.Name, CreatedDate, LastModifiedDate, Transition_Notes__c FROM Case WHERE AccountId = '${a.account_id}' AND Type IN ('KYC','A1') ORDER BY LastModifiedDate DESC LIMIT 20`;

    const [oppResult, caseResult] = await Promise.all([
      window.claude.mcp.callTool(conn.server, conn.tool, { q: oppQuery }),
      window.claude.mcp.callTool(conn.server, conn.tool, { q: caseQuery }),
    ]);
    const oppRecords = (oppResult.payload && (oppResult.payload.records || oppResult.payload)) || [];
    const caseRecords = (caseResult.payload && (caseResult.payload.records || caseResult.payload)) || [];
    const opps = (Array.isArray(oppRecords) ? oppRecords : []).map(r => ({
      name: r.Name, stage: r.StageName, product_line: r.Product_Line__c, y1_revenue: r.Y1_Expected_Revenue__c,
      probability: r.Probability, close_date: r.CloseDate, last_activity_date: r.LastActivityDate,
      next_steps: r.Next_Steps__c, created_date: r.CreatedDate, owner: r.Owner && r.Owner.Name,
      lead_source: r.LeadSource, type: r.Type, discovery_meeting_booked_by: r.Discovery_Meeting_Booked_By__c,
    }));
    const cases = (Array.isArray(caseRecords) ? caseRecords : []).map(r => ({
      case_number: r.CaseNumber, status: r.Status, type: r.Type, owner: r.Owner && r.Owner.Name,
      created_date: r.CreatedDate, last_modified_date: r.LastModifiedDate, transition_notes: r.Transition_Notes__c,
    }));

    const { oppCount, caseCount } = applyLiveDataToAccount(a, opps, cases);

    const when = new Date().toLocaleString();
    try{ await window.storage.set('sf_refresh_' + slackKey(accountName), JSON.stringify({ when, opps: oppCount, cases: caseCount })); }catch(e){}

    renderAccountsTable();
    renderRepGrid();
    renderOnboarding();
    renderGM();
    openDrawer(a);
    const refreshedStatusEl = document.getElementById('sf-refresh-status-' + slackKey(accountName));
    if(refreshedStatusEl) refreshedStatusEl.textContent = `Refreshed live from Salesforce ${when} — ${oppCount} open opportunit${oppCount===1?'y':'ies'}, ${caseCount} case${caseCount===1?'':'s'} found.`;
  }catch(err){
    const code = err && err.code;
    let hint = 'Refresh failed.';
    if(code === 'needs_reauth') hint = 'Reconnect Salesforce in claude.ai Settings → Connectors, then try again.';
    else if(code === 'server_not_connected') hint = 'Add Salesforce in claude.ai Settings → Connectors, then try again.';
    if(statusEl) statusEl.textContent = hint + ' (' + String((err && err.message) || err) + ')';
  }
}

async function batchRefreshFromSalesforce(){
  const statusEl = document.getElementById('batch-refresh-status');
  const list = currentFilteredAccounts();
  if(list.length===0){
    if(statusEl) statusEl.textContent = 'No accounts match the current filters — pick a filter (e.g. Zero-touch only, or a Likelihood) first, then batch refresh.';
    return;
  }
  const uniqueIds = [...new Set(list.map(a=>a.account_id).filter(Boolean))];
  if(uniqueIds.length===0){
    if(statusEl) statusEl.textContent = 'None of the currently filtered rows have an Account Id to refresh against.';
    return;
  }
  if(!window.claude || !window.claude.mcp){
    if(statusEl) statusEl.textContent = 'This page has no MCP connector bridge in this viewer session — Salesforce refresh isn\'t available here.';
    return;
  }
  const btn = document.getElementById('batch-refresh-btn');
  if(btn) btn.disabled = true;
  if(statusEl) statusEl.textContent = `Querying Salesforce for ${uniqueIds.length} account${uniqueIds.length===1?'':'s'} (${list.length} row${list.length===1?'':'s'} in view)…`;

  try{
    const conn = await discoverConnectorTool(["Salesforce"], t=>/soql|query/i.test(t.name));
    if(!conn) throw Object.assign(new Error("No connected Salesforce connector tool was found for this viewer. Connect Salesforce in claude.ai Settings → Connectors, then try again."), {code:"server_not_connected"});

    const idList = uniqueIds.map(id=>`'${id}'`).join(',');
    const oppQuery = `SELECT Id, AccountId, Name, StageName, Product_Line__c, Y1_Expected_Revenue__c, Probability, CloseDate, LastActivityDate, Next_Steps__c, CreatedDate, LastModifiedDate, Owner.Name, LeadSource, Type, Discovery_Meeting_Booked_By__c FROM Opportunity WHERE AccountId IN (${idList}) AND IsClosed = false`;
    const caseQuery = `SELECT AccountId, CaseNumber, Status, Type, Owner.Name, CreatedDate, LastModifiedDate, Transition_Notes__c FROM Case WHERE AccountId IN (${idList}) AND Type IN ('KYC','A1') ORDER BY LastModifiedDate DESC`;

    const [oppResult, caseResult] = await Promise.all([
      window.claude.mcp.callTool(conn.server, conn.tool, { q: oppQuery }),
      window.claude.mcp.callTool(conn.server, conn.tool, { q: caseQuery }),
    ]);
    const oppRecords = (oppResult.payload && (oppResult.payload.records || oppResult.payload)) || [];
    const caseRecords = (caseResult.payload && (caseResult.payload.records || caseResult.payload)) || [];

    const oppsByAccountId = {};
    (Array.isArray(oppRecords) ? oppRecords : []).forEach(r => {
      const accId = r.AccountId;
      (oppsByAccountId[accId] = oppsByAccountId[accId] || []).push({
        name: r.Name, stage: r.StageName, product_line: r.Product_Line__c, y1_revenue: r.Y1_Expected_Revenue__c,
        probability: r.Probability, close_date: r.CloseDate, last_activity_date: r.LastActivityDate,
        next_steps: r.Next_Steps__c, created_date: r.CreatedDate, owner: r.Owner && r.Owner.Name,
        lead_source: r.LeadSource, type: r.Type, discovery_meeting_booked_by: r.Discovery_Meeting_Booked_By__c,
      });
    });
    const casesByAccountId = {};
    (Array.isArray(caseRecords) ? caseRecords : []).forEach(r => {
      const accId = r.AccountId;
      (casesByAccountId[accId] = casesByAccountId[accId] || []).push({
        case_number: r.CaseNumber, status: r.Status, type: r.Type, owner: r.Owner && r.Owner.Name,
        created_date: r.CreatedDate, last_modified_date: r.LastModifiedDate, transition_notes: r.Transition_Notes__c,
      });
    });

    let updated = 0, noMatch = 0, totalOpps = 0, totalCases = 0;
    for(const a of list){
      const opps = oppsByAccountId[a.account_id] || [];
      const cases = casesByAccountId[a.account_id] || [];
      if(!oppsByAccountId[a.account_id] && !casesByAccountId[a.account_id]) noMatch++;
      const { oppCount, caseCount } = applyLiveDataToAccount(a, opps, cases);
      totalOpps += oppCount; totalCases += caseCount;
      updated++;
    }

    const when = new Date().toLocaleString();
    try{ await window.storage.set('sf_batch_refresh_last', JSON.stringify({ when, count: updated })); }catch(e){}

    renderAccountsTable();
    renderRepGrid();
    renderOnboarding();
    renderGM();

    if(statusEl) statusEl.textContent = `Batch refreshed ${updated} row${updated===1?'':'s'} (${uniqueIds.length} unique account${uniqueIds.length===1?'':'s'}) at ${when} — ${totalOpps} open opportunities and ${totalCases} cases pulled live.${noMatch?` ${noMatch} account${noMatch===1?'':'s'} returned no data (cleared to zero-opp/zero-case).`:''}`;
  }catch(err){
    const code = err && err.code;
    let hint = 'Batch refresh failed.';
    if(code === 'needs_reauth') hint = 'Reconnect Salesforce in claude.ai Settings → Connectors, then try again.';
    else if(code === 'server_not_connected') hint = 'Add Salesforce in claude.ai Settings → Connectors, then try again.';
    if(statusEl) statusEl.textContent = hint + ' (' + String((err && err.message) || err) + ')';
  }finally{
    if(btn) btn.disabled = false;
  }
}
document.getElementById('batch-refresh-btn').addEventListener('click', batchRefreshFromSalesforce);


function renderGM(){
  document.getElementById('gm-stat-1').textContent = GM.accounts_touched_by_gm_motion;
  document.getElementById('gm-stat-2').textContent = GM.accounts_with_trading_opp;
  document.getElementById('gm-stat-3').textContent = GM.split_coverage_accounts;

  const grid = document.getElementById('gm-kpi-grid');
  grid.innerHTML = `
    <div class="kpi accent"><div class="label">Trading Y1 pipeline</div><div class="value">${fmtMoney(GM.trading_y1_total)}</div><div class="foot">Across Hold/A1 Spot, Derivatives, Margin</div></div>
    <div class="kpi accent"><div class="label">Weighted trading pipeline</div><div class="value">${fmtMoney(GM.trading_weighted_y1)}</div><div class="foot">Probability-adjusted</div></div>
    <div class="kpi"><div class="label">GM desk reps</div><div class="value">${GM.gm_reps.length}</div><div class="foot">${GM.gm_reps.join(', ')}</div></div>
    <div class="kpi warn"><div class="label">Split-coverage accounts</div><div class="value">${GM.split_coverage_accounts}</div><div class="foot">Need 2 independent touchpoints</div></div>
  `;

  document.getElementById('gm-mismatch-count').textContent = GM.gm_status_scope_mismatch;
  const mismatchList = ACCOUNTS.filter(a=>a.is_gm_motion && a.status_scope_mismatch);
  document.getElementById('gm-mismatch-tbody').innerHTML = mismatchList.map(a=>`
    <tr data-idx="${ACCOUNTS.indexOf(a)}">
      <td>${escapeHtml(a.account)}</td>
      <td>${escapeHtml(a.assigned_owner)}</td>
      <td>${escapeHtml(a.stage||'—')} <span style="color:var(--text-faint);">(non-Trading)</span></td>
      <td><span class="chip ${LIK_CHIP[a.likelihood]}">${a.likelihood}</span></td>
    </tr>`).join('') || `<tr><td colspan="4"><div class="empty-state">None — every Global Market account has at least one Trading opportunity</div></td></tr>`;
  document.querySelectorAll('#gm-mismatch-tbody tr[data-idx]').forEach(tr=>{
    tr.addEventListener('click', ()=>openDrawer(ACCOUNTS[+tr.dataset.idx]));
  });

  const gmReps = REPS.filter(r=>GM.gm_reps.includes(r.name));
  const maxAcc = Math.max(...gmReps.map(r=>r.accounts), 1);
  document.getElementById('gm-rep-table').innerHTML = gmReps.map(r=>{
    const touchedPct = Math.round(100*(r.accounts-r.zero_touch)/r.accounts);
    return `<div class="hbar-row" style="grid-template-columns:150px 1fr 220px;">
      <div class="hbar-label">${escapeHtml(r.name)}</div>
      <div class="hbar-track"><div class="hbar-fill" style="width:${(100*r.accounts/maxAcc).toFixed(1)}%; background:var(--accent);"></div></div>
      <div class="hbar-value">${r.accounts} accts · ${fmtMoney(r.trading_y1)} · ${touchedPct}% touched</div>
    </div>`;
  }).join('');

  const splitList = ACCOUNTS.filter(a=>a.split_coverage).sort((a,b)=>b.trading_y1_expected_revenue-a.trading_y1_expected_revenue);
  document.getElementById('gm-split-tbody').innerHTML = splitList.map(a=>`
    <tr>
      <td>${escapeHtml(a.account)}</td>
      <td>${escapeHtml(a.account_owner)}</td>
      <td>${escapeHtml(a.assigned_owner)}</td>
      <td class="num">${a.trading_y1_expected_revenue?fmtMoney(a.trading_y1_expected_revenue):fmtMoney(a.total_y1_expected_revenue)}</td>
      <td class="num">${fmtDays(a.days_since_activity)}</td>
      <td><span class="chip ${LIK_CHIP[a.likelihood]}">${a.likelihood}</span></td>
    </tr>`).join('');

  const stablecoinList = ACCOUNTS.filter(a=>a.stablecoin_collision);
  const notFoundList = ["Morgan Stanley", "Robinhood", "ByBit"];
  document.getElementById('stablecoin-collision-table').innerHTML = `
    <div class="table-scroll" style="max-height:200px;">
      <table>
        <thead><tr><th>Account</th><th>Owner</th><th>Motion</th><th class="num">Y1 Exp. Rev</th><th>Likelihood</th></tr></thead>
        <tbody>
          ${stablecoinList.map(a=>`<tr>
            <td>${escapeHtml(a.account)} <span class="chip chip-contract-stall" style="margin-left:4px;">SC</span></td>
            <td>${escapeHtml(a.assigned_owner)}</td>
            <td>${escapeHtml(a.motion)}</td>
            <td class="num">${fmtMoney(a.total_y1_expected_revenue)}</td>
            <td><span class="chip ${LIK_CHIP[a.likelihood]}">${a.likelihood}</span></td>
          </tr>`).join('')}
          ${notFoundList.map(n=>`<tr style="opacity:0.6;">
            <td>${escapeHtml(n)}</td>
            <td colspan="4" style="color:var(--text-faint); font-style:italic;">Not in must-close list or revenue ledger — no data to show</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ================================================================
// REVENUE & PRODUCT MIX
// ================================================================
function renderConcentration(){
  const c = DATA.concentration;
  if(!c) return;
  const y1 = c.by_y1_expected;
  document.getElementById('concentration-kpis').innerHTML = `
    <div class="kpi warn"><div class="label">Top 10 deals</div><div class="value">${y1.top10_pct}%</div><div class="foot">${fmtMoney(y1.top10_amount)} of ${fmtMoney(y1.total)} total pipeline</div></div>
    <div class="kpi warn"><div class="label">Top 25 deals</div><div class="value">${y1.top25_pct}%</div><div class="foot">${fmtMoney(y1.top25_amount)} of ${fmtMoney(y1.total)} total pipeline</div></div>
    <div class="kpi"><div class="label">Total open opportunities</div><div class="value">${c.total_opp_count}</div><div class="foot">Across all must-close accounts</div></div>
  `;
  const maxDeal = Math.max(...y1.top_deals.slice(0,10).map(d=>d.amount));
  document.getElementById('concentration-top-deals').innerHTML = y1.top_deals.slice(0,10).map(d=>`
    <div class="hbar-row">
      <div class="hbar-label">${escapeHtml(d.account)}</div>
      <div class="hbar-track"><div class="hbar-fill" style="width:${(100*d.amount/maxDeal).toFixed(1)}%; background:var(--warm);"></div></div>
      <div class="hbar-value">${fmtMoney(d.amount)}</div>
    </div>`).join('');
}
function renderRevenue(){
  const grid = document.getElementById('rev-kpi-grid');
  grid.innerHTML = `
    <div class="kpi accent"><div class="label">Total open Y1 pipeline</div><div class="value">${fmtMoney(S.total_y1_pipeline)}</div><div class="foot">Across ${S.with_opportunity} assignments with an open opp</div></div>
    <div class="kpi accent"><div class="label">2026 Realizable pipeline</div><div class="value">${fmtMoney(S.realizable_2026_pipeline)}</div><div class="foot">Probability × ramp/pro-ration to 12/31/2026 — see formula below</div></div>
    <div class="kpi"><div class="label">Existing-client actuals (FY26)</div><div class="value">${fmtMoney(S.existing_actual_revenue)}</div><div class="foot">${S.existing_clients_in_list} accounts already on the books</div></div>
    <div class="kpi"><div class="label">Trading (GM) share</div><div class="value">${Math.round(100*S.trading_y1_pipeline/S.total_y1_pipeline)}%</div><div class="foot">${fmtMoney(S.trading_y1_pipeline)} of total pipeline</div></div>
  `;
  renderConcentration();

  const maxP = Math.max(...PRODUCTS.map(p=>p.y1_revenue));
  document.getElementById('product-bars').innerHTML = PRODUCTS.map(p=>`
    <div class="hbar-row">
      <div class="hbar-label">${escapeHtml(p.product)}</div>
      <div class="hbar-track"><div class="hbar-fill" style="width:${(100*p.y1_revenue/maxP).toFixed(1)}%; background:${p.product.startsWith('Trading')?'var(--accent)':'#5a6b8c'};"></div></div>
      <div class="hbar-value">${fmtMoney(p.y1_revenue)}</div>
    </div>`).join('');

  const existing = ACCOUNTS.filter(a=>a.existing_client).sort((a,b)=>b.fy26_actual_revenue-a.fy26_actual_revenue);
  document.getElementById('existing-clients-tbody').innerHTML = existing.map(a=>`
    <tr>
      <td>${escapeHtml(a.account)}</td>
      <td>${escapeHtml(a.assigned_owner)}</td>
      <td class="num">${fmtMoney(a.fy26_actual_revenue)}</td>
      <td class="num">${a.total_y1_expected_revenue?fmtMoney(a.total_y1_expected_revenue):'—'}</td>
      <td>${escapeHtml(a.client_tier||'—')}</td>
    </tr>`).join('');

  const maxM = Math.max(...MOTIONS.map(m=>m.total_y1));
  document.getElementById('motion-revenue-bars').innerHTML = MOTIONS.map(m=>`
    <div class="hbar-row">
      <div class="hbar-label">${escapeHtml(m.motion)}</div>
      <div class="hbar-track">
        <div class="hbar-fill" style="width:${(100*m.total_y1/maxM).toFixed(1)}%; background:#3a4666;"></div>
        <div class="hbar-fill" style="width:${(100*m.weighted_y1/maxM).toFixed(1)}%; background:var(--warm); position:absolute; top:0; left:0;"></div>
        <div class="hbar-fill" style="width:${(100*m.realizable_2026/maxM).toFixed(1)}%; background:var(--accent); position:absolute; top:0; left:0;"></div>
      </div>
      <div class="hbar-value">${fmtMoney(m.realizable_2026)} / ${fmtMoney(m.weighted_y1)} / ${fmtMoney(m.total_y1)}</div>
    </div>`).join('');
}

// ================================================================
// ONBOARDING / KYC (real Case data)
// ================================================================
let onboardSortState = {key:'days_since_case_modified', dir:1};

function renderOnboardKPIs(){
  const grid = document.getElementById('onboard-kpi-grid');
  const items = [
    {label:"Matched to a real Case", value: S.has_case, foot: Math.round(100*S.has_case/S.total_assignments)+"% of assignments", cls:"accent"},
    {label:"Active case in flight", value: S.has_case_active, foot: "Pending / Open / In Progress / New", cls:"accent"},
    {label:"Onboarding — Active", value: S.onboarding_active, foot: "Case modified ≤21 days, not On Hold"},
    {label:"Onboarding — Stalled", value: S.onboarding_stalled, foot: "On Hold, or idle 21+ days", cls:"danger"},
    {label:"No case matched", value: S.total_assignments - S.has_case, foot: "Falls back to Ironclad proxy or opp signal"},
  ];
  grid.innerHTML = items.map(it=>`
    <div class="kpi ${it.cls||''}">
      <div class="label">${it.label}</div>
      <div class="value">${it.value}</div>
      <div class="foot">${it.foot}</div>
    </div>`).join('');
  document.getElementById('onboard-coverage-sub').textContent =
    `${S.has_case} of ${S.total_assignments} assignments (${Math.round(100*S.has_case/S.total_assignments)}%) matched to a real onboarding Case — ${S.has_case_via_id} by Account Id, ${S.has_case_via_name} by name fallback. The remaining ${S.total_assignments-S.has_case} either never had a KYC/onboarding case opened, or truly have no match.`;
}

function populateOnboardFilters(){
  const sel = document.getElementById('onboard-filter-status');
  const statuses = [...new Set(ACCOUNTS.filter(a=>a.has_case).map(a=>a.case_status))].sort();
  sel.innerHTML = '<option value="">All</option>' + statuses.map(s=>`<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
}

let onboardNoCaseOnly = false;
function currentOnboardAccounts(){
  const search = (document.getElementById('onboard-search').value||"").toLowerCase();
  const status = document.getElementById('onboard-filter-status').value;
  let list = ACCOUNTS.filter(a=>{
    if(search && !(a.account.toLowerCase().includes(search) || a.assigned_owner.toLowerCase().includes(search) || (a.case_transition_notes||"").toLowerCase().includes(search))) return false;
    if(status && a.case_status!==status) return false;
    if(onboardNoCaseOnly && a.has_case) return false;
    return true;
  });
  list.sort((a,b)=>{
    let av=a[onboardSortState.key], bv=b[onboardSortState.key];
    const na = (av===null||av===undefined||av==="");
    const nb = (bv===null||bv===undefined||bv==="");
    if(typeof (av ?? bv) === 'string'){
      av = av||""; bv = bv||"";
      return onboardSortState.dir * (av<bv?-1:av>bv?1:0);
    }
    if(na && nb) return 0;
    if(na) return 1;
    if(nb) return -1;
    return onboardSortState.dir * (bv-av) * -1;
  });
  return list;
}

function renderOnboarding(){
  renderOnboardKPIs();
  const list = currentOnboardAccounts();
  document.getElementById('onboarding-count-label').textContent = `Showing ${list.length} of ${ACCOUNTS.length} assignments`;
  const tbody = document.getElementById('onboarding-tbody');
  if(list.length===0){ tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">No accounts match these filters</div></td></tr>`; return; }
  tbody.innerHTML = list.map(a=>{
    const statusChip = !a.has_case
      ? `<span class="chip chip-pending-data">No case matched</span>`
      : `<span class="chip ${a.likelihood==='Onboarding - Active'?'chip-onboard':a.likelihood==='Onboarding - Stalled'?'chip-onboard-stall':'chip-pending-data'}">${escapeHtml(a.case_status)}</span>`;
    return `<tr data-idx="${ACCOUNTS.indexOf(a)}">
      <td>${escapeHtml(a.account)}</td>
      <td>${escapeHtml(a.assigned_owner)}</td>
      <td>${escapeHtml(a.stage||'—')}</td>
      <td>${statusChip}</td>
      <td>${a.has_case ? escapeHtml(a.case_owner) : '—'}</td>
      <td class="num">${a.has_case ? fmtDays(a.days_since_case_modified) : '—'}</td>
      <td style="max-width:320px; white-space:normal; font-size:11.5px; color:var(--text-dim);">${a.has_case && a.case_transition_notes ? escapeHtml(a.case_transition_notes) : (a.has_case ? '<span style="color:var(--text-faint); font-style:italic;">no notes logged</span>' : '<span style="color:var(--text-faint); font-style:italic;">n/a</span>')}</td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('tr').forEach(tr=>{
    tr.addEventListener('click', ()=>openDrawer(ACCOUNTS[+tr.dataset.idx]));
  });
}
document.getElementById('onboard-search').addEventListener('input', renderOnboarding);
document.getElementById('onboard-filter-status').addEventListener('change', renderOnboarding);
document.getElementById('onboard-filter-nocase').addEventListener('click', (e)=>{
  onboardNoCaseOnly = !onboardNoCaseOnly;
  e.target.classList.toggle('active', onboardNoCaseOnly);
  renderOnboarding();
});
document.getElementById('onboard-filter-clear').addEventListener('click', ()=>{
  document.getElementById('onboard-search').value='';
  document.getElementById('onboard-filter-status').value='';
  onboardNoCaseOnly = false;
  document.getElementById('onboard-filter-nocase').classList.remove('active');
  renderOnboarding();
});
document.querySelectorAll('#panel-onboarding thead th[data-key]').forEach(th=>{
  th.addEventListener('click', ()=>{
    const key = th.dataset.key;
    if(onboardSortState.key===key) onboardSortState.dir *= -1; else { onboardSortState.key=key; onboardSortState.dir=1; }
    document.querySelectorAll('#panel-onboarding thead th').forEach(t=>t.classList.remove('sorted'));
    th.classList.add('sorted');
    renderOnboarding();
  });
});

function renderSlackOverview(){
  const uniqueChecked = S.slack_unique_checked || 0;
  const pct = Math.round(100 * uniqueChecked / S.unique_accounts);
  document.getElementById('slack-overview-sub').textContent =
    `${uniqueChecked} of ${S.unique_accounts} accounts checked (${pct}%) · ${S.slack_found} had account-specific signal · ${S.slack_blockers} surfaced a real blocker`;
  const checked = [];
  const seen = new Set();
  for(const a of ACCOUNTS){
    if(a.slack_checked && !seen.has(a.account)){ seen.add(a.account); checked.push(a); }
  }
  const listHtml = checked.map(a=>{
    const blockerBadge = a.slack_blocker_flag ? `<span class="chip chip-contract-stall" style="margin-left:6px;">Blocker</span>` : '';
    const tentativeBadge = a.slack_tentative ? `<span class="chip chip-pending-data" style="margin-left:6px;">Unconfirmed</span>` : '';
    const foundBadge = a.slack_signal_found ? `<span class="chip chip-onboard">Signal found</span>` : `<span class="chip chip-pending-data">No signal</span>`;
    return `<div class="opp-card">
      <div class="opp-name">${escapeHtml(a.account)} ${foundBadge}${blockerBadge}${tentativeBadge}</div>
      <div class="opp-meta" style="margin-top:5px;">${escapeHtml(a.slack_summary)}</div>
    </div>`;
  }).join('');
  document.getElementById('slack-overview-findings').innerHTML = `<div style="max-height:420px; overflow-y:auto;">${listHtml}</div>`;
}

// ---------------- init ----------------
function fixHbarTrackPositioning(){
  document.querySelectorAll('.hbar-track').forEach(t=>{ t.style.position='relative'; });
}
function renderAll(){
  renderKPIs();
  renderLikelihoodBars();
  renderMotionBars();
  renderZeroTouchSummary();
  renderSlackOverview();
  renderRepGrid();
  populateAccountFilters();
  renderAccountsTable();
  renderGM();
  renderOnboarding();
  renderRevenue();
  fixHbarTrackPositioning();
}

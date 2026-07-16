// Shared shell for sketches 006/007/008 — picked panes only
(function () {
  const jobs = [
    { id: 'acme', title: 'PM, Learning Platform', co: 'Acme Learning', fit: 84, stage: 'interview', tags: 'today interview high', next: 'Review HM prep · optional Jane intro', due: true },
    { id: 'nova', title: 'Founding PM', co: 'NovaWork', fit: 79, stage: 'review', tags: 'today review high', next: 'Pursue + stakeholder research', due: false },
    { id: 'ridge', title: 'PM, Talent Ops', co: 'Ridge AI', fit: 82, stage: 'applied', tags: 'today applied high', next: 'Follow-up due tomorrow', due: true },
    { id: 'field', title: 'PM, Workforce', co: 'Fieldnote', fit: 77, stage: 'applied', tags: 'applied', next: 'Nudge if silent 4d', due: false },
    { id: 'lumen', title: 'Education PM', co: 'Lumen', fit: 68, stage: 'materials', tags: 'materials', next: 'Human-review drafts', due: false },
    { id: 'orbit', title: 'Product Lead', co: 'Orbit Labs', fit: 71, stage: 'review', tags: 'review', next: 'Score deeper before materials', due: false },
  ];
  const docs = {
    acme: [
      { name: 'resume-job_acme.md', status: 'draft_needs_human_review', body: '# Resume · Acme\n\n## Evidence-backed highlights\n- Educator discovery → −30% review time (pp_01)\n- Cross-functional launch (pp_02)\n\n## Role target\nPM, Learning Platform' },
      { name: 'interview-hm-acme.md', status: 'draft', body: '# HM prep · Acme\n\n## STAR\n1. Discovery with educators…\n2. Launch ownership…\n\n## Questions to ask\n- How is success measured at 90 days?' },
      { name: 'outreach-jane.md', status: 'draft only', body: '# Outreach · Jane Chen\n\nHi Jane — shared employer path…\n\n(not sent)' },
    ],
    nova: [{ name: '—', status: 'no drafts yet', body: 'Run pursue to stage materials.' }],
    ridge: [{ name: 'resume-ridge.md', status: 'used', body: 'Already applied. Follow-up next.' }],
    field: [{ name: '—', status: 'none', body: 'No open drafts.' }],
    lumen: [{ name: 'cover-lumen.md', status: 'draft', body: 'Draft cover · needs review.' }],
    orbit: [{ name: '—', status: 'none', body: 'No materials yet.' }],
  };

  const state = {
    filter: 'today',
    selected: 'acme',
    agent: false,
    review: false,
    cmd: false,
    profile: 'pm-edtech',
    overlay: null,
  };

  const $ = (id) => document.getElementById(id);
  const toast = $('toast');
  const status = $('status');

  function flash(msg) {
    status.textContent = msg;
    if (!toast) return;
    toast.textContent = msg;
    toast.style.display = 'block';
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { toast.style.display = 'none'; }, 1400);
  }

  function work(ms = 700) {
    const loader = $('loader');
    if (loader) loader.style.display = 'inline-flex';
    clearTimeout(work._t);
    work._t = setTimeout(() => { if (loader) loader.style.display = 'none'; }, ms);
  }

  function filtered() {
    return jobs.filter((j) => {
      if (state.filter === 'all') return true;
      if (state.filter === 'today') return j.tags.includes('today') || j.due;
      return j.stage === state.filter || j.tags.split(/\s+/).includes(state.filter);
    });
  }

  function job() {
    return jobs.find((j) => j.id === state.selected) || jobs[0];
  }

  function renderList() {
    const el = $('jobs');
    if (!el) return;
    const rows = filtered();
    el.innerHTML = rows.map((j) => `
      <div class="job ${j.id === state.selected ? 'on' : ''}" data-id="${j.id}">
        <div class="t"><span>${j.title}</span><span class="muted">${j.fit}</span></div>
        <div class="m">${j.co} · ${j.stage}${j.due ? ' · due' : ''}</div>
      </div>`).join('') || '<div class="muted">No jobs in this filter.</div>';
    el.querySelectorAll('.job').forEach((node) => {
      node.onclick = () => { state.selected = node.dataset.id; render(); flash('selected ' + node.dataset.id); };
    });
  }

  function renderDetail() {
    const j = job();
    $('d-title').textContent = j.title;
    $('d-sub').textContent = `${j.co} · fit ${j.fit} · ${j.stage} · ${j.id}`;
    $('d-next').textContent = j.next;
    $('d-actions').innerHTML = `
      <button class="btn primary" data-act="pursue">Pursue</button>
      <button class="btn" data-act="score">Score</button>
      <button class="btn" data-act="network">Network</button>
      <button class="btn" data-act="docs">Docs</button>
      <button class="btn ghost" data-act="agent">Agent</button>`;
    $('d-actions').querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => act(b.dataset.act);
    });

    const rp = $('review-panel');
    if (rp) {
      rp.style.display = state.review ? 'block' : 'none';
      if (state.review) {
        $('review-list').innerHTML = [
          'resume-job_acme.md · draft',
          'interview-hm-acme.md · draft',
          'outreach-jane.md · draft only',
          'cover-lumen.md · draft',
        ].map((x) => `<div class="doc-line" data-doc="1">${x}</div>`).join('');
        $('review-list').querySelectorAll('.doc-line').forEach((n) => {
          n.onclick = () => openOverlay('docs');
        });
      }
    }
  }

  function renderAgent() {
    const ws = $('ws');
    if (ws) ws.classList.toggle('agent-on', state.agent);
    const btn = $('btn-agent');
    if (btn) btn.classList.toggle('on', state.agent);
    const msgs = $('msgs');
    if (msgs && !msgs.dataset.seeded) {
      msgs.dataset.seeded = '1';
      msgs.innerHTML = `
        <div class="msg"><div class="who">hermes</div>Focused on <b>${job().id}</b>. I stay tucked until you need multi-step help.</div>`;
    }
  }

  function renderCmd() {
    const bar = $('cmdbar');
    if (bar) bar.classList.toggle('open', state.cmd);
    if (state.cmd) $('cmd')?.focus();
  }

  function openOverlay(kind, extra) {
    state.overlay = kind;
    const overlay = $('overlay');
    const modal = $('modal');
    const j = job();
    let html = '';
    if (kind === 'network') {
      html = `<h3>Network path · ${j.co}</h3>
        <div class="row"><span>you → Jane Chen → HM</span><span class="muted">shared_employer · high</span></div>
        <div class="row"><span>no second path</span><span class="muted">—</span></div>
        <p class="muted" style="margin:10px 0">Nothing sent. Draft intro via agent or CLI.</p>
        <div class="actions"><button class="btn primary" id="ov-agent">Ask agent to draft intro</button><button class="btn ghost" id="ov-close">Close</button></div>`;
    } else if (kind === 'docs') {
      const list = docs[j.id] || docs.nova;
      const idx = extra?.idx || 0;
      const doc = list[Math.min(idx, list.length - 1)];
      html = `<h3>Documents · ${j.id}</h3>
        <div style="display:grid;grid-template-columns:180px 1fr;gap:12px;min-height:240px">
          <div>${list.map((d, i) => `<div class="doc-line ${i === idx ? 'on' : ''}" data-i="${i}">${d.name}<div class="muted">${d.status}</div></div>`).join('')}</div>
          <pre style="white-space:pre-wrap;color:inherit;font:inherit;margin:0">${doc.body}</pre>
        </div>
        <div class="actions" style="margin-top:12px"><button class="btn" id="ov-close">Close</button></div>`;
    } else if (kind === 'discovery') {
      html = `<h3>Discovery health</h3>
        <div class="row"><span>portfolio</span><span>ok · 2 imported</span></div>
        <div class="row"><span>ashby</span><span>ok · 1 imported</span></div>
        <div class="row"><span>career-page</span><span>timeout</span></div>
        <div class="row"><span>greenhouse</span><span>ok</span></div>
        <div class="actions" style="margin-top:12px"><button class="btn primary" id="ov-daily">Run daily</button><button class="btn ghost" id="ov-close">Close</button></div>`;
    } else if (kind === 'system') {
      html = `<h3>System</h3>
        <div class="row"><span>hermes</span><span>ready</span></div>
        <div class="row"><span>codex</span><span>ready</span></div>
        <div class="row"><span>mcp</span><span>26 tools</span></div>
        <div class="row"><span>browser</span><span>unavailable</span></div>
        <div class="row"><span>scheduler</span><span>daily_discovery disabled</span></div>
        <div class="actions" style="margin-top:12px"><button class="btn ghost" id="ov-close">Close</button></div>`;
    } else if (kind === 'profile') {
      html = `<h3>Profile</h3>
        <div class="doc-line" data-p="pm-edtech">pm-edtech</div>
        <div class="doc-line" data-p="generalist">generalist</div>
        <div class="actions" style="margin-top:12px"><button class="btn ghost" id="ov-close">Close</button></div>`;
    }
    modal.innerHTML = html;
    overlay.classList.add('open');
    modal.querySelector('#ov-close')?.addEventListener('click', closeOverlay);
    modal.querySelector('#ov-daily')?.addEventListener('click', () => { closeOverlay(); act('daily'); });
    modal.querySelector('#ov-agent')?.addEventListener('click', () => { closeOverlay(); state.agent = true; render(); agentSay('Draft a short intro ask for Jane. Draft only.'); });
    modal.querySelectorAll('[data-i]').forEach((n) => {
      n.onclick = () => openOverlay('docs', { idx: Number(n.dataset.i) });
    });
    modal.querySelectorAll('[data-p]').forEach((n) => {
      n.onclick = () => {
        state.profile = n.dataset.p;
        $('profile').textContent = state.profile + ' ▾';
        closeOverlay();
        flash('profile · ' + state.profile);
      };
    });
  }

  function closeOverlay() {
    state.overlay = null;
    $('overlay')?.classList.remove('open');
  }

  function agentSay(text) {
    const msgs = $('msgs');
    if (!msgs) return;
    work(900);
    msgs.insertAdjacentHTML('beforeend', `<div class="msg"><div class="who">you</div>${text}</div>`);
    setTimeout(() => {
      msgs.insertAdjacentHTML('beforeend', `<div class="msg"><div class="who">hermes · tools</div>→ tools on <b>${job().id}</b><br/>Done. Drafts remain gated. Nothing external.</div>`);
      msgs.scrollTop = msgs.scrollHeight;
      flash('agent idle');
    }, 500);
  }

  function act(name) {
    if (name === 'pursue') { work(); flash('pursue ' + state.selected + ' · drafts gated'); return; }
    if (name === 'score') { work(400); flash('score ' + job().fit + ' · deterministic'); return; }
    if (name === 'network') { openOverlay('network'); return; }
    if (name === 'docs') { openOverlay('docs'); return; }
    if (name === 'agent') { state.agent = !state.agent; render(); flash(state.agent ? 'agent on' : 'agent off'); return; }
    if (name === 'review') { state.review = !state.review; render(); flash(state.review ? 'review panel' : 'review hidden'); return; }
    if (name === 'cmd') { state.cmd = !state.cmd; render(); return; }
    if (name === 'daily') { work(1000); flash('daily · high_fit=3 · 1 source failure'); return; }
    if (name === 'discovery') { openOverlay('discovery'); return; }
    if (name === 'system') { openOverlay('system'); return; }
    if (name === 'profile') { openOverlay('profile'); return; }
  }

  function render() {
    // filters
    document.querySelectorAll('.filter').forEach((f) => f.classList.toggle('on', f.dataset.f === state.filter));
    $('btn-review')?.classList.toggle('on', state.review);
    renderList();
    renderDetail();
    renderAgent();
    renderCmd();
  }

  function bindChrome() {
    document.querySelectorAll('.filter').forEach((f) => {
      f.onclick = () => { state.filter = f.dataset.f; render(); flash('filter · ' + state.filter); };
    });
    $('btn-agent')?.addEventListener('click', () => act('agent'));
    $('btn-review')?.addEventListener('click', () => act('review'));
    $('btn-sys')?.addEventListener('click', () => act('system'));
    $('profile')?.addEventListener('click', () => act('profile'));
    $('hide-agent')?.addEventListener('click', () => act('agent'));
    $('send')?.addEventListener('click', () => {
      const v = $('input').value.trim();
      if (!v) return;
      $('input').value = '';
      agentSay(v);
    });
    $('runcmd')?.addEventListener('click', () => {
      const v = $('cmd').value.trim();
      if (v) { work(); flash('ran: ' + v); }
      $('cmd').value = '';
      state.cmd = false;
      render();
    });
    $('cmd')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('runcmd').click();
      if (e.key === 'Escape') { state.cmd = false; render(); }
    });
    $('overlay')?.addEventListener('click', (e) => { if (e.target.id === 'overlay') closeOverlay(); });

    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        if (e.key === 'Escape') {
          document.activeElement.blur();
          if (state.overlay) closeOverlay();
          else if (state.cmd) { state.cmd = false; render(); }
        }
        return;
      }
      if (e.key === 'Escape') {
        if (state.overlay) return closeOverlay();
        if (state.cmd) { state.cmd = false; return render(); }
        if (state.agent) return act('agent');
        if (state.review) return act('review');
      }
      if (e.key === 'a') act('agent');
      if (e.key === 'r') act('review');
      if (e.key === ':') { e.preventDefault(); state.cmd = true; render(); }
      if (e.key === 'n') act('network');
      if (e.key === 'o') act('docs');
      if (e.key === 's') act('discovery');
      if (e.key === '?' || e.key === 'h') act('system');
      if (e.key === 'p') act('pursue');
      if (e.key === 'd') act('daily');
      if (e.key === 'j' || e.key === 'k') {
        const rows = filtered();
        let i = rows.findIndex((x) => x.id === state.selected);
        if (i < 0) i = 0;
        i = e.key === 'j' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
        if (rows[i]) { state.selected = rows[i].id; render(); }
      }
    });
  }

  bindChrome();
  render();
})();

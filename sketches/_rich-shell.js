// Richer shell for 009 (A-style) and 010 (C-style)
(function () {
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const jobs = [
    {
      id: 'acme', title: 'PM, Learning Platform', co: 'Acme Learning', loc: 'Remote',
      fit: 84, high: true, stage: 'interview', src: 'portfolio→gh', mode: 'deterministic',
      tags: 'today interview high due', due: 'prep review',
      next: 'Review HM prep packet before tomorrow 2pm; optional Jane intro',
      proofs: [
        { id: 'pp_01', label: 'Educator discovery → −30% review' },
        { id: 'pp_02', label: 'Cross-functional launch' },
        { id: 'pp_03', label: 'Activation improvement' },
      ],
      path: { strength: 'high', summary: 'you → Jane Chen → HM', edge: 'shared_employer' },
      artifacts: [
        { name: 'resume-job_acme.md', status: 'draft' },
        { name: 'cover-job_acme.md', status: 'draft' },
        { name: 'interview-hm-acme.md', status: 'draft' },
        { name: 'outreach-jane.md', status: 'draft only' },
      ],
      stages: [
        ['score', 'ok'], ['company', 'ok'], ['contacts', 'ok'], ['network', 'ok'],
        ['questions', 'ok'], ['resume', 'draft'], ['cover', 'draft'], ['application', 'ok'],
        ['outreach', 'draft'], ['interview', 'draft'],
      ],
      body: 'Imported via portfolio router → Greenhouse. High fit on learning-platform PM. Interview stage live.',
    },
    {
      id: 'nova', title: 'Founding PM', co: 'NovaWork', loc: 'Remote',
      fit: 79, high: true, stage: 'review', src: 'ashby', mode: 'deterministic',
      tags: 'today review high', due: 'pursue',
      next: 'Run pursue; network is thin — research stakeholders before outreach',
      proofs: [
        { id: 'pp_01', label: 'Educator discovery' },
        { id: 'pp_02', label: 'Launch ownership' },
      ],
      path: { strength: 'none', summary: 'no warm path yet', edge: '—' },
      artifacts: [],
      stages: [['score', 'ok'], ['company', '—'], ['resume', '—'], ['outreach', '—']],
      body: 'Early-stage WorkTech. Strong domain match; needs research depth.',
    },
    {
      id: 'ridge', title: 'PM, Talent Ops', co: 'Ridge AI', loc: 'Remote',
      fit: 82, high: true, stage: 'applied', src: 'greenhouse', mode: 'deterministic',
      tags: 'today applied high due', due: 'follow-up',
      next: 'Follow up tomorrow; materials already used',
      proofs: [{ id: 'pp_02', label: 'Cross-functional launch' }, { id: 'pp_04', label: 'Ops workflow design' }],
      path: { strength: 'medium', summary: 'you → alum @ Ridge', edge: 'shared_school' },
      artifacts: [{ name: 'resume-ridge.md', status: 'used' }, { name: 'cover-ridge.md', status: 'used' }],
      stages: [['score', 'ok'], ['resume', 'used'], ['application', 'applied'], ['outreach', '—']],
      body: 'Applied 3d ago. Good fit on talent/ops adjacency.',
    },
    {
      id: 'field', title: 'PM, Workforce', co: 'Fieldnote', loc: 'Remote',
      fit: 77, high: false, stage: 'applied', src: 'lever', mode: 'deterministic',
      tags: 'applied', due: 'nudge',
      next: 'Nudge if silent another day',
      proofs: [{ id: 'pp_01', label: 'Educator discovery' }],
      path: { strength: 'low', summary: 'cold', edge: '—' },
      artifacts: [{ name: 'resume-field.md', status: 'used' }],
      stages: [['score', 'ok'], ['application', 'applied']],
      body: 'Applied 4d ago. Mid-high fit.',
    },
    {
      id: 'lumen', title: 'Education PM', co: 'Lumen', loc: 'NYC',
      fit: 68, high: false, stage: 'materials', src: 'portfolio', mode: 'deterministic',
      tags: 'materials', due: 'human review',
      next: 'Review thinner proof grounding before apply',
      proofs: [{ id: 'pp_03', label: 'Activation improvement' }],
      path: { strength: 'none', summary: 'no path', edge: '—' },
      artifacts: [{ name: 'cover-lumen.md', status: 'draft' }, { name: 'resume-lumen.md', status: 'draft' }],
      stages: [['score', 'ok'], ['resume', 'draft'], ['cover', 'draft']],
      body: 'Materials ready but mid fit — careful review.',
    },
    {
      id: 'orbit', title: 'Product Lead, K-12', co: 'Orbit Labs', loc: 'Hybrid',
      fit: 71, high: false, stage: 'review', src: 'career-page', mode: 'deterministic',
      tags: 'review', due: 'score deeper',
      next: 'Optional deeper score before investing materials',
      proofs: [{ id: 'pp_01', label: 'Educator discovery' }],
      path: { strength: 'none', summary: 'no path', edge: '—' },
      artifacts: [],
      stages: [['score', 'ok']],
      body: 'Education domain fit; weaker platform scale proof.',
    },
  ];

  const today = [
    { kind: 'due', text: 'Follow up Jane @ Acme · 16:00', job: 'acme' },
    { kind: 'iv', text: 'HM interview Acme · tomorrow 2pm', job: 'acme' },
    { kind: 'new', text: '3 high-fit from daily (portfolio + ashby)', job: 'nova' },
    { kind: 'fail', text: 'career-page source timeout on last daily', job: null },
  ];

  const reviewItems = [
    { name: 'resume-job_acme.md', job: 'acme', status: 'draft_needs_human_review' },
    { name: 'interview-hm-acme.md', job: 'acme', status: 'draft' },
    { name: 'outreach-jane.md', job: 'acme', status: 'draft only' },
    { name: 'cover-lumen.md', job: 'lumen', status: 'draft' },
  ];

  const logLines = [
    '14:01 daily · high_fit=3 · career-page timeout',
    '14:03 pursue acme · score 84 · network Jane Chen',
    '14:04 artifact resume draft_needs_human_review',
    '14:10 hermes auth ok · protocol 1',
    '14:12 review queue · 4 drafts',
  ];

  const state = {
    filter: 'today',
    selected: 'acme',
    agent: true, // on by default; still toggleable
    cmd: false,
    profile: 'pm-edtech',
    overlay: null,
  };

  const $ = (id) => document.getElementById(id);

  function flash(msg) {
    const s = $('status');
    if (s) s.textContent = msg;
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(flash._t);
    flash._t = setTimeout(() => t.classList.remove('show'), 1400);
  }

  function work(ms = 600) {
    document.body.classList.add('working');
    clearTimeout(work._t);
    work._t = setTimeout(() => document.body.classList.remove('working'), ms);
  }

  function job() {
    return jobs.find((j) => j.id === state.selected) || jobs[0];
  }

  function filtered() {
    return jobs.filter((j) => {
      if (state.filter === 'all') return true;
      if (state.filter === 'today') return /\btoday\b|\bdue\b/.test(j.tags) || j.due;
      if (state.filter === 'high') return j.high;
      return j.stage === state.filter;
    });
  }

  function renderCounts() {
    const el = $('counts');
    if (!el) return;
    el.innerHTML = `
      <span>open <b>${jobs.length}</b></span>
      <span>high <b class="ok">${jobs.filter((j) => j.high).length}</b></span>
      <span>due <b class="warn">${jobs.filter((j) => /\bdue\b/.test(j.tags)).length}</b></span>
      <span>drafts <b class="warn">${reviewItems.length}</b></span>
      <span>iv <b>${jobs.filter((j) => j.stage === 'interview').length}</b></span>`;
  }

  function renderBrief() {
    const el = $('brief');
    if (!el) return;
    el.innerHTML = today.map((t) => `
      <div class="brief-item" data-job="${t.job || ''}">
        <span class="tag ${t.kind}">${t.kind}</span>
        <span>${t.text}</span>
      </div>`).join('');
    el.querySelectorAll('.brief-item').forEach((n) => {
      n.onclick = () => {
        if (n.dataset.job) {
          state.selected = n.dataset.job;
          render();
          flash('focus ' + n.dataset.job);
        }
      };
    });
  }

  function renderList() {
    const el = $('jobs');
    if (!el) return;
    const dense = document.body.dataset.density === 'operator';
    const rows = filtered();
    if (dense) {
      el.innerHTML = `
        <table class="grid">
          <thead><tr><th>id</th><th>role</th><th>co</th><th>fit</th><th>stage</th><th>next</th><th>src</th></tr></thead>
          <tbody>
            ${rows.map((j) => `
              <tr class="${j.id === state.selected ? 'on' : ''}" data-id="${j.id}">
                <td class="muted">${j.id}</td>
                <td>${j.title}</td>
                <td>${j.co}</td>
                <td class="${j.high ? 'ok' : ''}">${j.fit}</td>
                <td>${j.stage}</td>
                <td class="warn">${j.due}</td>
                <td class="muted">${j.src}</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
      el.querySelectorAll('tr[data-id]').forEach((tr) => {
        tr.onclick = () => { state.selected = tr.dataset.id; render(); };
      });
    } else {
      el.innerHTML = rows.map((j) => `
        <article class="job ${j.id === state.selected ? 'on' : ''}" data-id="${j.id}">
          <div class="job-top">
            <strong>${j.title}</strong>
            <span class="fit ${j.high ? 'ok' : ''}">${j.fit}${j.high ? ' · high' : ''}</span>
          </div>
          <div class="job-meta">${j.co} · ${j.loc} · ${j.stage}</div>
          <div class="job-next">${j.due} · ${j.src}</div>
          <div class="job-signals">
            <span>${j.proofs.length} proofs</span>
            <span>${j.artifacts.length} drafts</span>
            <span>path ${j.path.strength}</span>
          </div>
        </article>`).join('') || '<div class="muted">No jobs in filter.</div>';
      el.querySelectorAll('.job').forEach((n) => {
        n.onclick = () => { state.selected = n.dataset.id; render(); };
      });
    }
  }

  function renderDetail() {
    const j = job();
    $('d-title').textContent = j.title;
    $('d-sub').textContent = `${j.co} · ${j.loc} · ${j.id} · src ${j.src}`;
    $('d-fit').innerHTML = `<span class="fit-num ${j.high ? 'ok' : ''}">${j.fit}</span>
      <span class="muted">/100 · ${j.mode}${j.high ? ' · high-fit' : ''}</span>`;
    $('d-next').textContent = j.next;
    $('d-body').textContent = j.body;

    $('d-proofs').innerHTML = j.proofs.map((p) =>
      `<div class="chip"><code>${p.id}</code> ${p.label}</div>`).join('') || '<div class="muted">No proofs matched</div>';

    $('d-path').innerHTML = `<div class="path ${j.path.strength}">
      <b>${j.path.summary}</b>
      <span class="muted">${j.path.edge} · ${j.path.strength}</span>
    </div>`;

    $('d-artifacts').innerHTML = j.artifacts.length
      ? j.artifacts.map((a, i) =>
        `<button class="chip btnish" data-doc="${i}">${a.name} <span class="muted">${a.status}</span></button>`).join('')
      : '<div class="muted">No artifacts yet — pursue to stage</div>';
    $('d-artifacts').querySelectorAll('[data-doc]').forEach((b) => {
      b.onclick = () => openOverlay('docs', Number(b.dataset.doc));
    });

    $('d-stages').innerHTML = j.stages.map(([name, st]) =>
      `<span class="stage ${st}">${name}<i>${st}</i></span>`).join('');

    $('d-actions').innerHTML = `
      <button class="btn primary" data-act="pursue">Pursue</button>
      <button class="btn" data-act="score">Score</button>
      <button class="btn" data-act="network">Network</button>
      <button class="btn" data-act="docs">Docs</button>
      <button class="btn" data-act="answers">Answers</button>
      <button class="btn ghost" data-act="agent">Agent</button>`;
    $('d-actions').querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => act(b.dataset.act);
    });
  }

  function renderSide() {
    const ws = $('ws');
    ws?.classList.toggle('agent-on', state.agent);
    ws?.classList.remove('log-on');
    $('btn-agent')?.classList.toggle('on', state.agent);
    // review + log are overlays only — never leave "on" chrome
    $('btn-review')?.classList.remove('on');
    $('btn-log')?.classList.remove('on');
    $('cmdbar')?.classList.toggle('open', state.cmd);

    // hide legacy inline panels if present in older sketches
    const rp = $('review-panel');
    if (rp) rp.hidden = true;
    const log = $('log-panel');
    if (log) log.hidden = true;

    if (state.agent && !$('msgs')?.dataset.seeded) {
      $('msgs').dataset.seeded = '1';
      $('msgs').innerHTML = `<div class="msg"><div class="who">hermes</div>Agent on by default. Context pinned to <b>${job().id}</b>. Toggle off with <b>a</b> if you want list+detail only.</div>`;
    }
  }

  function openOverlay(kind, docIdx = 0) {
    const j = job();
    const modal = $('modal');
    const overlay = $('overlay');
    let html = '';
    if (kind === 'network') {
      html = `<h3>Network · ${j.co}</h3>
        <div class="ov-card"><b>${j.path.summary}</b><div class="muted">${j.path.edge} · strength ${j.path.strength}</div></div>
        <div class="ov-card muted">No other ranked paths. Import edges via :network import</div>
        <div class="actions"><button class="btn primary" id="x-agent">Draft intro (agent)</button><button class="btn ghost" id="x-close">Close</button></div>`;
    } else if (kind === 'docs') {
      const arts = j.artifacts.length ? j.artifacts : [{ name: '(none)', status: '—', body: 'No drafts. Run pursue.' }];
      const i = Math.min(docIdx, arts.length - 1);
      const bodies = {
        'resume-job_acme.md': '# Resume · Acme\n\n## Evidence-backed highlights\n- Educator discovery → −30% review (pp_01)\n- Launch ownership (pp_02)\n- Activation (pp_03)\n\n## Target\nPM, Learning Platform',
        'cover-job_acme.md': '# Cover · Acme\n\nWhy this role… grounded in pp_01–03.\n\n(draft_needs_human_review)',
        'interview-hm-acme.md': '# HM prep\n\n## STAR × 3\n1. Discovery…\n2. Launch…\n3. Activation…\n\n## Ask\n- 90-day success?',
        'outreach-jane.md': '# Outreach · Jane\n\nHi Jane — shared employer path…\n\n(not sent)',
        'cover-lumen.md': '# Cover · Lumen\n\nDraft — thinner proof set.',
        'resume-ridge.md': '# Resume · Ridge\n\nUsed in application.',
        'cover-ridge.md': '# Cover · Ridge\n\nUsed.',
        'resume-field.md': '# Resume · Fieldnote\n\nUsed.',
        'resume-lumen.md': '# Resume · Lumen\n\nDraft.',
      };
      html = `<h3>Documents · ${j.id}</h3>
        <div class="doc-layout">
          <div class="doc-nav">${arts.map((a, idx) =>
            `<div class="doc-item ${idx === i ? 'on' : ''}" data-i="${idx}">${a.name}<div class="muted">${a.status}</div></div>`).join('')}</div>
          <pre class="doc-body">${bodies[arts[i].name] || arts[i].body || 'No preview.'}</pre>
        </div>
        <div class="actions"><button class="btn" id="x-close">Close</button></div>`;
    } else if (kind === 'discovery') {
      html = `<h3>Discovery health</h3>
        <div class="ov-card">portfolio <span class="ok">ok · 2 imported · 2 high</span></div>
        <div class="ov-card">ashby <span class="ok">ok · 1 imported · 1 high</span></div>
        <div class="ov-card">greenhouse <span class="ok">ok</span></div>
        <div class="ov-card">lever <span class="ok">ok</span></div>
        <div class="ov-card">career-page <span class="bad">timeout · isolated</span></div>
        <div class="actions"><button class="btn primary" id="x-daily">Run daily</button><button class="btn ghost" id="x-close">Close</button></div>`;
    } else if (kind === 'system') {
      html = `<h3>System</h3>
        <div class="ov-card">hermes <span class="ok">ready · prompt-arg</span></div>
        <div class="ov-card">codex <span class="ok">ready · stdin-json</span></div>
        <div class="ov-card">mcp <span class="ok">26 tools</span></div>
        <div class="ov-card">browser <span class="bad">unavailable</span></div>
        <div class="ov-card">scheduler <span class="warn">daily_discovery disabled</span></div>
        <div class="ov-card">side-effects <span class="ok">off</span></div>
        <div class="actions"><button class="btn ghost" id="x-close">Close</button></div>`;
    } else if (kind === 'answers') {
      html = `<h3>Answers match · ${j.co}</h3>
        <div class="ov-card ok">matched 4 · why company, experience story, portfolio, education</div>
        <div class="ov-card bad">blocked 1 restricted · work authorization → sensitive_prompt</div>
        <div class="muted">Restricted values never shown or auto-filled.</div>
        <div class="actions"><button class="btn ghost" id="x-close">Close</button></div>`;
    } else if (kind === 'profile') {
      html = `<h3>Profile</h3>
        <div class="doc-item" data-p="pm-edtech">pm-edtech</div>
        <div class="doc-item" data-p="generalist">generalist</div>
        <div class="actions"><button class="btn ghost" id="x-close">Close</button></div>`;
    } else if (kind === 'review') {
      html = `<h3>Review queue · ${reviewItems.length}</h3>
        ${reviewItems.map((r) => {
          const job = jobs.find((j) => j.id === r.job);
          const idx = job ? Math.max(0, job.artifacts.findIndex((a) => a.name === r.name)) : 0;
          return `
          <div class="ov-card review-row" data-job="${r.job}" data-doc="${idx}" style="cursor:pointer;display:flex;justify-content:space-between;gap:8px;align-items:center">
            <div><b>${r.name}</b><div class="muted">${r.status} · ${r.job}</div></div>
            <span class="muted">open →</span>
          </div>`;
        }).join('')}
        <div class="actions" style="margin-top:10px"><button class="btn ghost" id="x-close">Close</button></div>`;
    } else if (kind === 'log') {
      html = `<h3>Event log</h3>
        <div class="ov-card" style="font-family:inherit;max-height:50vh;overflow:auto">
          ${logLines.map((l) => `<div style="padding:3px 0;border-bottom:1px solid rgba(127,127,127,.15)">${escapeHtml(l)}</div>`).join('')}
        </div>
        <div class="actions" style="margin-top:10px"><button class="btn ghost" id="x-close">Close</button></div>`;
    }
    modal.innerHTML = html;
    overlay.classList.add('open');
    modal.querySelector('#x-close')?.addEventListener('click', closeOverlay);
    modal.querySelector('#x-daily')?.addEventListener('click', () => { closeOverlay(); act('daily'); });
    modal.querySelector('#x-agent')?.addEventListener('click', () => {
      closeOverlay();
      state.agent = true;
      render();
      agentSay('Draft a short intro ask for Jane. Draft only, do not send.');
    });
    modal.querySelectorAll('[data-i]').forEach((n) => {
      n.onclick = () => openOverlay('docs', Number(n.dataset.i));
    });
    modal.querySelectorAll('[data-p]').forEach((n) => {
      n.onclick = () => {
        state.profile = n.dataset.p;
        $('profile').textContent = state.profile + ' ▾';
        closeOverlay();
        flash('profile ' + state.profile);
      };
    });
    modal.querySelectorAll('.review-row[data-job]').forEach((row) => {
      row.onclick = () => {
        state.selected = row.dataset.job;
        render();
        openOverlay('docs', Number(row.dataset.doc));
      };
    });
  }

  function closeOverlay() {
    $('overlay')?.classList.remove('open');
  }

  function agentSay(text) {
    work(800);
    const msgs = $('msgs');
    if (!msgs) return;
    const userMsg = document.createElement('div');
    userMsg.className = 'msg';
    const userWho = document.createElement('div');
    userWho.className = 'who';
    userWho.textContent = 'you';
    const userBody = document.createElement('div');
    userBody.textContent = text;
    userMsg.appendChild(userWho);
    userMsg.appendChild(userBody);
    msgs.appendChild(userMsg);
    setTimeout(() => {
      const reply = document.createElement('div');
      reply.className = 'msg';
      const replyWho = document.createElement('div');
      replyWho.className = 'who';
      replyWho.textContent = 'hermes · tools';
      const replyBody = document.createElement('div');
      replyBody.textContent = '→ pursue_job / map_reachable_network on ' + job().id + '. Fit ' + job().fit + '. Path: ' + job().path.summary + '. Drafts gated. Nothing external.';
      reply.appendChild(replyWho);
      reply.appendChild(replyBody);
      msgs.appendChild(reply);
      msgs.scrollTop = msgs.scrollHeight;
      logLines.unshift(new Date().toTimeString().slice(0, 5) + ' agent · ' + job().id);
      flash('agent idle');
      renderSide();
    }, 450);
  }

  function act(name) {
    if (name === 'pursue') { work(); flash('pursue ' + state.selected + ' · staging drafts'); logLines.unshift('pursue ' + state.selected); return renderSide(); }
    if (name === 'score') { work(350); flash('score ' + job().fit); return; }
    if (name === 'network') return openOverlay('network');
    if (name === 'docs') return openOverlay('docs');
    if (name === 'answers') return openOverlay('answers');
    if (name === 'agent') { state.agent = !state.agent; render(); flash(state.agent ? 'agent on' : 'agent off'); return; }
    if (name === 'review') return openOverlay('review');
    if (name === 'log') return openOverlay('log');
    if (name === 'cmd') { state.cmd = !state.cmd; render(); if (state.cmd) $('cmd')?.focus(); return; }
    if (name === 'daily') { work(900); flash('daily · 3 high-fit · 1 failure isolated'); logLines.unshift('daily high_fit=3'); return renderSide(); }
    if (name === 'discovery') return openOverlay('discovery');
    if (name === 'system') return openOverlay('system');
    if (name === 'profile') return openOverlay('profile');
  }

  function render() {
    document.querySelectorAll('.filter').forEach((f) => f.classList.toggle('on', f.dataset.f === state.filter));
    renderCounts();
    renderBrief();
    renderList();
    renderDetail();
    renderSide();
  }

  function bind() {
    document.querySelectorAll('.filter').forEach((f) => {
      f.onclick = () => { state.filter = f.dataset.f; render(); flash('filter ' + state.filter); };
    });
    $('btn-agent')?.addEventListener('click', () => act('agent'));
    $('btn-review')?.addEventListener('click', () => act('review'));
    $('btn-log')?.addEventListener('click', () => act('log'));
    $('btn-sys')?.addEventListener('click', () => act('system'));
    $('btn-src')?.addEventListener('click', () => act('discovery'));
    $('profile')?.addEventListener('click', () => act('profile'));
    $('hide-agent')?.addEventListener('click', () => act('agent'));
    $('send')?.addEventListener('click', () => {
      const v = $('input')?.value.trim();
      if (!v) return;
      $('input').value = '';
      agentSay(v);
    });
    $('runcmd')?.addEventListener('click', () => {
      const v = $('cmd')?.value.trim();
      if (v) { work(); flash('ran: ' + v); logLines.unshift('cmd ' + v); }
      if ($('cmd')) $('cmd').value = '';
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
          if ($('overlay')?.classList.contains('open')) closeOverlay();
          else if (state.cmd) { state.cmd = false; render(); }
        }
        return;
      }
      if (e.key === 'Escape') {
        if ($('overlay')?.classList.contains('open')) return closeOverlay();
        if (state.cmd) { state.cmd = false; return render(); }
        // Esc does not auto-hide agent (default-on); use `a` to toggle
      }
      if (e.key === 'a') act('agent');
      if (e.key === 'r') act('review');
      if (e.key === 'l') act('log');
      if (e.key === ':') { e.preventDefault(); act('cmd'); }
      if (e.key === 'n') act('network');
      if (e.key === 'o') act('docs');
      if (e.key === 's') act('discovery');
      if (e.key === 'q') act('answers');
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

  bind();
  render();
})();

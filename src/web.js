import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { esc } from './utils.js';
import { state } from './analytics.js';
import { handleApi } from './api.js';

const stages = ['saved','researching','materials-ready','applied','recruiter-screen','interview','offer','rejected','withdrawn','ghosted'];

function option(value, label = value) { return `<option value="${esc(value)}">${esc(label)}</option>`; }

function html(st) {
  const profileOptions = st.profiles.map(p => option(p.id, `${p.name} (${p.id})`)).join('');
  const jobOptions = st.jobs.map(j => option(j.id, `${j.title} — ${j.company}`)).join('');
  const kanban = stages.map(stage => {
    const apps = st.applications.filter(a => a.status === stage);
    const cards = apps.map(a => `<article class="card"><strong>${esc(a.title)}</strong><br><span>${esc(a.company)}</span><br><code>${esc(a.id)}</code><form data-api="/api/applications/${esc(a.id)}" data-method="PATCH"><select name="status">${stages.map(s => `<option value="${s}" ${s === a.status ? 'selected' : ''}>${s}</option>`).join('')}</select><input name="notes" placeholder="status note"><button>Update</button></form></article>`).join('') || '<p class="muted">No cards</p>';
    return `<section class="lane"><h3>${esc(stage)} <span>${apps.length}</span></h3>${cards}</section>`;
  }).join('');
  const jobs = st.jobs.map(x => `<tr><td><strong>${esc(x.title)}</strong><br><span class="muted">${esc(x.id)}</span></td><td>${esc(x.company)}</td><td>${esc(x.fit_score ?? '—')}</td><td>${esc(x.application_status || 'not tracked')}</td><td><form data-api="/api/jobs/${esc(x.id)}" data-method="PATCH"><input name="title" value="${esc(x.title)}"><input name="company" value="${esc(x.company)}"><button>Save</button></form></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No jobs imported.</td></tr>';
  const artifacts = st.artifacts.map(a => `<article class="card"><strong>${esc(a.title)}</strong><br><code>${esc(a.id)}</code><p>${esc(a.type)} · ${esc(a.approval_status)}</p><a href="/workspace/${esc(a.path)}">Open draft</a><form data-api="/api/artifacts/${esc(a.id)}" data-method="PATCH"><button name="approvalStatus" value="approved">Approve</button><button name="approvalStatus" value="rejected">Reject</button><button name="approvalStatus" value="draft_needs_human_review">Back to draft</button></form></article>`).join('') || '<p class="muted">No artifacts yet.</p>';
  const tasks = st.tasks.map(t => `<li>${esc(t.title)} — ${esc(t.priority)} — ${esc(t.due_at || 'no due date')}</li>`).join('') || '<li class="muted">No open tasks.</li>';
  const profiles = st.profiles.map(p => `<article class="card"><h3>${esc(p.name)}</h3><p><code>${esc(p.id)}</code></p></article>`).join('') || '<p class="muted">No profiles yet.</p>';
  const audit = st.audit.map(a => `<li><code>${esc(a.created_at)}</code> ${esc(a.action)} ${esc(a.entity_type)}:${esc(a.entity_id)} (${esc(a.external_side_effect)})</li>`).join('') || '<li class="muted">No audit events yet.</li>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>JobOS Local Dashboard</title><style>
body{font-family:Inter,system-ui;margin:0;background:#0f172a;color:#e2e8f0}.app{display:grid;grid-template-columns:230px 1fr;min-height:100vh}.rail{background:#020617;padding:18px;position:sticky;top:0;height:100vh}.rail a{display:block;color:#cbd5e1;padding:8px;text-decoration:none}main{padding:24px}section.panel{background:#111827;border:1px solid #334155;border-radius:16px;padding:18px;margin:14px 0}.card{background:#0b1220;border:1px solid #1f2937;padding:12px;border-radius:10px;margin:8px 0}.muted{color:#94a3b8}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #334155;padding:8px;text-align:left}.banner{background:#422006}.kanban{display:grid;grid-template-columns:repeat(5,minmax(190px,1fr));gap:10px;overflow-x:auto}.lane{background:#0b1220;border:1px solid #334155;border-radius:12px;padding:10px;min-width:190px}input,select,textarea,button{margin:4px;padding:8px;border-radius:8px;border:1px solid #475569}button{background:#38bdf8;color:#082f49;font-weight:700;cursor:pointer}form.grid{display:grid;grid-template-columns:repeat(2,minmax(180px,1fr));gap:8px}textarea{min-height:110px;grid-column:1/-1}.status{position:fixed;right:18px;bottom:18px;background:#022c22;border:1px solid #059669;border-radius:10px;padding:10px;display:none}</style></head><body><div class="app"><nav class="rail"><h2>JobOS</h2><a href="#today">Today</a><a href="#board">Kanban board</a><a href="#jobs">Jobs</a><a href="#applications">Applications</a><a href="#artifacts">Artifact review</a><a href="#research">Research</a><a href="#outreach">Outreach</a><a href="#tasks">Tasks</a><a href="#profile-proof">Profile & Proof</a><a href="#automations">Automations</a><a href="#audit">Audit Log</a></nav><main><section class="panel banner"><strong>Human gate:</strong> JobOS cannot submit applications, send outreach, or touch external accounts. This dashboard only edits local JobOS state and reviews drafts.</section>
<section id="today" class="panel"><h1>Today / Priority Brief</h1><p>Interactive local dashboard: create jobs/applications/proof points, move the kanban board, and approve/reject draft artifacts. Agents should still prefer CLI/API/MCP for repeatable operations.</p></section>
<section id="board" class="panel"><h2>Kanban-style application status board</h2><div class="kanban">${kanban}</div></section>
<section id="jobs" class="panel"><h2>Jobs</h2><form class="grid" data-api="/api/jobs" data-method="POST"><select name="profileId" required>${profileOptions}</select><input name="title" placeholder="Title" required><input name="company" placeholder="Company" required><input name="location" placeholder="Location"><input name="url" placeholder="URL"><textarea name="description" placeholder="Paste job description"></textarea><button>Create job</button></form><table><thead><tr><th>Role</th><th>Company</th><th>Fit</th><th>Status</th><th>Edit</th></tr></thead><tbody>${jobs}</tbody></table></section>
<section id="applications" class="panel"><h2>Applications</h2><form data-api="/api/applications" data-method="POST"><select name="jobId" required>${jobOptions}</select><select name="status">${stages.map(s => option(s)).join('')}</select><input name="notes" placeholder="Internal note"><button>Create application</button></form></section>
<section id="artifacts" class="panel"><h2>Artifact review UI</h2><p class="muted">Approve/reject only local draft artifacts; external submission remains manual.</p>${artifacts}</section>
<section id="research" class="panel"><h2>Research</h2><p>Use CLI/API/MCP to generate dossiers and stakeholder briefs, then inspect files from each job workspace.</p></section>
<section id="outreach" class="panel"><h2>Outreach</h2><p>Draft-only outreach is stored as artifacts/tasks. JobOS never sends messages.</p></section>
<section id="tasks" class="panel"><h2>Tasks</h2><form data-api="/api/tasks" data-method="POST"><input name="title" placeholder="Task title" required><select name="priority"><option>normal</option><option>high</option><option>low</option></select><button>Create task</button></form><ul>${tasks}</ul></section>
<section id="profile-proof" class="panel"><h2>Profile & Proof</h2>${profiles}<form data-api="/api/proofs" data-method="POST"><select name="profileId" required>${profileOptions}</select><input name="summary" placeholder="Evidence-backed proof point" required><input name="evidence" placeholder="Evidence/source"><input name="skills" placeholder="comma-separated skills"><button>Add proof point</button></form></section>
<section id="automations" class="panel"><h2>Automations</h2><p>Automation runs are internal-only and audited. No external side effects without human approval.</p></section>
<section id="audit" class="panel"><h2>Audit Log</h2><ul>${audit}</ul></section></main></div><div id="status" class="status"></div><script>
const statusBox=document.getElementById('status');
function payload(form, submitter){ const data={}; for (const el of form.elements) { if(!el.name || el.type==='submit' || el.tagName==='BUTTON') continue; const v=el.value; if(v!=='' || el.required) data[el.name]=el.name==='skills'?v.split(',').map(x=>x.trim()).filter(Boolean):v; } if(submitter?.name) data[submitter.name]=submitter.value; return data; }
for (const form of document.querySelectorAll('form[data-api]')) form.addEventListener('submit', async ev => { ev.preventDefault(); const submitter=ev.submitter; const res=await fetch(form.dataset.api,{method:form.dataset.method||'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload(form, submitter))}); const text=await res.text(); statusBox.style.display='block'; statusBox.textContent=res.ok?'Saved local JobOS state':'Error: '+text; if(res.ok) setTimeout(()=>location.reload(),500); });
</script></body></html>`;
}

export function web(s, { port = 4317, host = '127.0.0.1', onReady = null } = {}) {
  const server = http.createServer(async (req, res) => {
    const raw = req.url || '/';
    if (raw.startsWith('/workspace/') && /(\.\.|%2e%2e)/i.test(raw)) { res.writeHead(400); res.end('Bad workspace path'); return; }
    const u = new URL(raw, `http://${req.headers.host}`);
    const api = await handleApi(s, req, res, u); if (api !== false) return;
    if (u.pathname.startsWith('/workspace/')) {
      const rel = u.pathname.replace(/^\/workspace\//, ''), abs = path.resolve(s.p.ws, rel);
      if (!abs.startsWith(s.p.ws) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(fs.readFileSync(abs)); return;
    }
    if (u.pathname !== '/') { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html(state(s)));
  });
  server.listen(port, host, () => onReady?.()); return server;
}

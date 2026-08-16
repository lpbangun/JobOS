const NEW = [
  {
    id: "job_new_1",
    title: "Staff PM, Learning Ops",
    company: "Northstar Learning",
    location: "Remote",
    action: "Needs review",
    inbox: true,
    fit: 61,
  },
  {
    id: "job_new_2",
    title: "Product Lead, Educator Tools",
    company: "Harbor Schools",
    location: "NYC hybrid",
    action: "Needs review",
    inbox: true,
    fit: 48,
  },
];

const JOBS = [
  {
    id: "job_59be630c6ffd",
    title: "Product Manager, Learning Platform",
    company: "Example Learning Co",
    location: "Remote US",
    action: "Create files",
    fit: 52,
    files: false,
    stage: "saved",
    followup: "none",
  },
  {
    id: "job_e516eb6df8cc",
    title: "Senior Product Manager, Agent Workflows",
    company: "Contoso Careers Lab",
    location: "Hybrid SF",
    action: "Find people",
    fit: 41,
    files: true,
    stage: "researching",
    followup: "none",
  },
  {
    id: "job_applied_1",
    title: "Director of Product, Schools",
    company: "Lumen Labs",
    location: "Remote",
    action: "Due follow-up",
    fit: 71,
    files: true,
    stage: "applied",
    followup: "due in 2 days",
  },
];

const CONTACTS = {
  job_59be630c6ffd: [
    { name: "Avery Chen", role: "Hiring manager", email: "avery@example-learning.co", warmth: "unknown", path: "not in-network · found on posting" },
    { name: "Priya Shah", role: "Recruiter", email: "priya@example-learning.co", warmth: "cool", path: "you → Chris Holm → Priya" },
    { name: "Chris Holm", role: "Founder", email: "chris@example-learning.co", warmth: "warm", path: "you met Chris in 2024" },
  ],
};

const NETWORK = [
  { name: "Chris Holm", role: "Founder", detail: "Example Learning · warm", warmth: "warm" },
  { name: "Priya Shah", role: "Recruiter", detail: "Example Learning · needs intro", warmth: "cool" },
  { name: "Avery Chen", role: "Hiring manager", detail: "Example Learning · draft ready", warmth: "unknown" },
];

const FOUND = [
  { name: "Jordan Hale", role: "Staff engineer", detail: "EdTech · not in-network" },
  { name: "Mina Ortiz", role: "VP Product", detail: "Harbor Schools · weak path via Chris" },
  { name: "Dev Patel", role: "Recruiter", detail: "Lumen Labs · public listing" },
];

const SETUP = [
  { id: "workspace", label: "Workspace ready", required: true, status: "complete", blurb: "Local folder is ready. Nothing leaves this machine." },
  { id: "profile", label: "About you", required: true, status: "complete", blurb: "Name, target roles, location. You can change this later." },
  { id: "resume", label: "Your resume", required: true, status: "ready", blurb: "Paste or browse a resume. JobOS extracts proof points." },
  { id: "proofs", label: "Validate experience highlights", required: true, status: "ready", blurb: "Keep, edit, or drop imported proofs. Never invent them." },
  { id: "intake", label: "Add a job you like", required: true, status: "ready", blurb: "Paste a posting or import a URL." },
  { id: "decision", label: "Check the fit", required: true, status: "ready", blurb: "Score against stored proofs. Gaps stay visible." },
  { id: "materials", label: "Application drafts", required: true, status: "ready", blurb: "Create files from proofs. Approve before use." },
  { id: "source", label: "Job discovery", required: false, status: "optional", blurb: "Daily sources. Optional." },
  { id: "calibration", label: "Your preferences", required: false, status: "optional", blurb: "Hours, location, salary band. Optional." },
  { id: "provider", label: "AI assistant", required: false, status: "optional", blurb: "Connect Hermes later. Optional." },
  { id: "browser", label: "Web applications", required: false, status: "optional", blurb: "Browser session for live forms. Optional." },
  { id: "network", label: "Connections", required: false, status: "optional", blurb: "Network intent for profile find-people. Optional." },
];

const SLASH = [
  { id: "files", label: "/create-files", hint: "This job · resume + questions" },
  { id: "find", label: "/find-people", hint: "Jobs: this listing · Workspace: keep/skip" },
  { id: "network", label: "/network", hint: "Profile network overlay" },
  { id: "tracker", label: "/tracker", hint: "This job · status, packet, attest" },
  { id: "review", label: "/review", hint: "Morning brief overlay" },
  { id: "daily", label: "/daily", hint: "New roles on the left" },
  { id: "chat", label: "/chat", hint: "Chat this job" },
  { id: "jobs", label: "/jobs", hint: "Back to the board" },
  { id: "ask", label: "/workspace", hint: "Workspace · the whole search" },
  { id: "memory", label: "/memory", hint: "Career memory overlay" },
  { id: "setup", label: "/setup", hint: "Guided setup · 7 essential steps" },
];

export function createApp(root) {
  let left = "jobs";
  let selected = 0;
  let right = "job";
  let ask = false;
  let overlay = "welcome";
  let setupI = 2;
  let slashHi = 0;
  let person = 0;
  let netI = 0;
  let fileKind = "resume";
  let intent = "Hiring managers · EdTech · public web";
  let working = false;
  let status = "ready";
  let clock = "";
  let inbox = FOUND.map((p) => ({ ...p }));
  const jobChat = {};
  const askChat = [
    { kind: "agent", text: "Workspace — the whole search, not one job. Slash works here: /review /network /find-people /daily. /jobs returns to the board." },
  ];

  const rows = () => (left === "new" ? NEW : JOBS);
  const job = () => rows()[selected] || null;
  const contacts = () => CONTACTS[job()?.id] || [];

  function slashHits(val) {
    const q = String(val || "")
      .replace(/^\//, "")
      .toLowerCase();
    return SLASH.filter((s) => s.label.includes(q) || s.label.slice(1).includes(q) || s.hint.toLowerCase().includes(q));
  }

  function syncSlashMenu() {
    const menu = root.querySelector("[data-slash-menu]");
    const input = root.querySelector("[data-input]");
    if (!menu) return;
    const val = input?.value || "";
    if (!val.startsWith("/")) {
      menu.hidden = true;
      menu.innerHTML = "";
      slashHi = 0;
      return;
    }
    const hits = slashHits(val);
    if (slashHi >= hits.length) slashHi = Math.max(0, hits.length - 1);
    menu.hidden = false;
    menu.innerHTML = hits.length
      ? hits
          .map(
            (s, i) =>
              `<button type="button" class="action${i === slashHi ? " on" : ""}" data-slash="${s.id}"><b>${s.label}</b><span>${s.hint}</span></button>`,
          )
          .join("")
      : `<p class="hint">No matching command</p>`;
  }

  function openSlashInChat() {
    overlay = null;
    if (!ask) right = "chat";
    render();
    const input = root.querySelector("[data-input]");
    if (input) {
      input.value = "/";
      input.focus();
    }
    syncSlashMenu();
  }

  function parseSlash(text) {
    const raw = String(text || "")
      .trim()
      .toLowerCase()
      .replace(/^\//, "")
      .split(/\s/)[0];
    const map = {
      "create-files": "files",
      files: "files",
      file: "files",
      resume: "files",
      "find-people": "find",
      find: "find",
      people: "find",
      "find-network": "find",
      network: "network",
      tracker: "tracker",
      review: "review",
      brief: "review",
      daily: "daily",
      new: "daily",
      memory: "memory",
      setup: "setup",
      workspace: "ask",
      ask: "ask",
      jobs: "jobs",
      chat: "chat",
    };
    return map[raw] || null;
  }

  function runSlash(id) {
    overlay = null;
    if (id === "ask") {
      ask = true;
      render();
      root.querySelector("[data-input]")?.focus();
      return;
    }
    if (id === "jobs") {
      ask = false;
      render();
      root.querySelector("[data-input]")?.focus();
      return;
    }
    if (id === "chat") {
      ask = false;
      right = "chat";
      render();
      root.querySelector("[data-input]")?.focus();
      return;
    }
    if (id === "find") {
      if (ask) findNetwork();
      else findPeople();
      return;
    }
    if (id === "files") {
      ask = false;
      createFiles();
      return;
    }
    if (id === "network") overlay = "network";
    if (id === "tracker") {
      ask = false;
      overlay = "tracker";
    }
    if (id === "review") overlay = "brief";
    if (id === "daily") {
      ask = false;
      left = "new";
      selected = 0;
      right = "job";
    }
    if (id === "memory" || id === "setup") overlay = id;
    render();
  }

  function thread() {
    const j = job();
    if (!j) return [];
    jobChat[j.id] ||= [{ kind: "agent", text: "Chat · " + j.company + "." }];
    return jobChat[j.id];
  }

  function tick() {
    const d = new Date();
    clock = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    const el = root.querySelector("[data-clock]");
    if (el) el.textContent = clock;
  }
  tick();
  setInterval(tick, 1000);

  function work(label, done) {
    working = true;
    status = label;
    render();
    setTimeout(() => {
      working = false;
      done();
      render();
      const input = root.querySelector("[data-input]");
      if (input) input.focus();
    }, 800);
  }

  function createFiles() {
    const j = job();
    if (!j || working) return;
    work("working · create files", () => {
      j.files = true;
      j.action = "Needs review";
      status = "resume + questions drafted";
      thread().push({ kind: "tool", text: "create_files · resume.md · questions from posting" });
      thread().push({
        kind: "agent",
        text: "Drafted a resume and pulled application questions from the posting. Open a file to approve.",
      });
    });
  }

  function findPeople() {
    const j = job();
    if (!j || working) return;
    ask = false;
    right = "people";
    work("working · find people", () => {
      CONTACTS[j.id] ||= [
        { name: "Sam Okonkwo", role: "Hiring manager", email: "sam@contoso.example", warmth: "unknown", path: "not in-network" },
        { name: "Lee Park", role: "Recruiter", email: "lee@contoso.example", warmth: "unknown", path: "not in-network" },
        { name: "Riley Nguyen", role: "Founder", email: "riley@contoso.example", warmth: "unknown", path: "not in-network" },
      ];
      j.action = "Needs review";
      status = "3 people for this job";
      thread().push({ kind: "tool", text: "find_people · job scope · recruiter, hiring manager, founder" });
    });
  }

  function findNetwork() {
    if (working) return;
    ask = true;
    work("working · find people · profile", () => {
      inbox = FOUND.map((p) => ({ ...p }));
      overlay = "review";
      status = "3 people to keep or skip";
      askChat.push({ kind: "tool", text: "start_people_research · scope profile" });
      askChat.push({ kind: "agent", text: "Not tied to a job. Keep or skip, then open Network — same overlay family as Tracker." });
    });
  }

  function send(text, scope) {
    const value = String(text || "").trim();
    if (!value || working) return;
    if (value.startsWith("/")) {
      const id = parseSlash(value);
      if (id) return runSlash(id);
      status = "unknown command";
      render();
      return;
    }
    const log = scope === "ask" ? askChat : thread();
    log.push({ kind: "you", text: value });
    if (scope === "ask" && /due|review|brief|week/i.test(value)) {
      overlay = "brief";
      render();
      return;
    }
    if (scope === "ask" && /people|network|contact/i.test(value)) return findNetwork();
    if (scope !== "ask" && /people|network|contact/i.test(value) && job()) return findPeople();
    if (/file|resume/i.test(value) && job()) return createFiles();
    work("working · hermes", () => {
      status = "ready";
      log.push({
        kind: "agent",
        text:
          scope === "ask"
            ? "Workspace. /review /network /find-people work here. Or ask in plain language."
            : "On " + job().company + ". /tracker /create-files /find-people, or ask about this listing.",
      });
    });
  }

  function chatHtml(scope, log, placeholder) {
    return `<div class="chatpane">
      <div class="log" data-log>${log
        .map((m) => `<div class="msg ${m.kind}"><span class="who">${m.kind}</span><p>${m.text}</p></div>`)
        .join("")}</div>
      <div data-slash-menu hidden></div>
      <form class="composer" data-form data-scope="${scope}">
        <span class="prompt">❯</span>
        <input data-input autocomplete="off" aria-label="Message" placeholder="${placeholder}" />
        <button type="submit">send</button>
      </form>
    </div>`;
  }

  function jobHtml() {
    const j = job();
    if (!j) return `<div class="pad"><p class="empty">Pick a listing on the left.</p></div>`;
    if (j.inbox) {
      return `<div class="pad">
        <p class="kicker">New</p>
        <h2>${j.title}</h2>
        <p class="meta">${j.company} · ${j.location} · already scored in discovery</p>
        <button type="button" class="cta" data-act="accept">Add to Jobs</button>
      </div>`;
    }
    return `<div class="pad">
      <p class="kicker">${j.stage}</p>
      <h2>${j.title}</h2>
      <p class="meta">${j.company} · ${j.location}${j.fit != null ? " · fit " + j.fit : ""} · ${j.action}</p>
      <div class="btns inline">
        <button type="button" class="cta" data-act="files">${working ? "Working" : "Create files"}</button>
        <button type="button" class="ghost" data-tracker>Tracker</button>
      </div>
      <p class="hint">Tab to Chat, then type / like Claude Code. Menu sits on the prompt.</p>
      ${j.files ? `<button type="button" class="file" data-file="resume">resume.md · needs review</button>
      <button type="button" class="file" data-file="questions">questions.md · needs review</button>` : ""}
    </div>`;
  }

  function peopleHtml() {
    const j = job();
    const list = contacts();
    return `<div class="pad">
      <p class="kicker">People · this job</p>
      <h2>${j ? j.company : "People"}</h2>
      <p class="meta">This listing only. Click a person for a connection overlay.</p>
      <button type="button" class="cta" data-act="find">${list.length ? "Find more" : working ? "Working" : "Find people"}</button>
      <div class="people">${list
        .map(
          (p, i) => `<button type="button" class="person${i === person ? " on" : ""}" data-person="${i}">
            <span class="t">${p.name}</span><span class="s">${p.role} · ${p.warmth}</span>
          </button>`,
        )
        .join("")}</div>
    </div>`;
  }

  function personOverlay() {
    const fromNet = overlay === "person-net";
    const p = fromNet ? NETWORK[netI] : contacts()[person];
    const j = job();
    if (!p) return "";
    return `<div class="modal">
      <p class="kicker">Connection · ${fromNet ? "network" : "this job"}</p>
      <h3>${p.name}</h3>
      <p class="meta">${p.role}${fromNet ? "" : " · " + (j?.company || "")}</p>
      <p class="meta">${p.email || p.detail || ""}</p>
      <p class="hint">${p.path || p.detail || ""} · warmth ${p.warmth}</p>
      <div class="btns">
        <button type="button" class="cta" data-gate="drafted outreach">Draft outreach</button>
        <button type="button" class="ghost" data-gate="recorded contact">Record contact</button>
      </div>
      <p class="hint">Small overlay. Esc back.</p>
    </div>`;
  }

  function fileOverlay() {
    const files = {
      resume: { title: "resume.md", body: "Proof-linked draft. Approve or reject here." },
      questions: { title: "questions.md", body: "Application questions from the posting. Restricted answers stay gated." },
    };
    const f = files[fileKind] || files.resume;
    return `<div class="modal wide">
      <p class="kicker">Files · this job</p>
      <div class="btns tight">
        <button type="button" class="file${fileKind === "resume" ? " on" : ""}" data-file="resume">resume.md</button>
        <button type="button" class="file${fileKind === "questions" ? " on" : ""}" data-file="questions">questions.md</button>
      </div>
      <h3>${f.title}</h3>
      <pre>${f.body}</pre>
      <div class="btns">
        <button type="button" class="cta" data-gate="approve">Approve</button>
        <button type="button" class="ghost" data-gate="reject">Reject</button>
      </div>
    </div>`;
  }

  function trackerOverlay() {
    const j = job();
    if (!j || j.inbox) {
      return `<div class="modal"><h3>Tracker</h3><p class="meta">Add the role to Jobs first.</p></div>`;
    }
    const stages = ["saved", "researching", "applied", "waiting"];
    return `<div class="modal wide">
      <p class="kicker">Tracker · this job</p>
      <h3>${j.company}</h3>
      <p class="meta">${j.title}</p>
      <p class="meta">Status</p>
      <div class="btns tight">${stages
        .map((s) => `<button type="button" class="${j.stage === s ? "cta" : "ghost"}" data-stage="${s}">${s}</button>`)
        .join("")}</div>
      <p class="meta">Packet · freeze before you send. Attest is human-only.</p>
      <div class="btns">
        <button type="button" class="ghost" data-gate="packet frozen">Freeze packet</button>
        <button type="button" class="cta" data-gate="attested submitted">Attest submitted</button>
      </div>
      <p class="hint">Jobs on the left stay the index. Across-jobs due is the brief. Esc closes.</p>
    </div>`;
  }

  function welcomeOverlay() {
    return `<div class="modal wide">
      <p class="kicker">Welcome to JobOS</p>
      <h3>A private workspace for your job search</h3>
      <p class="meta">Short guided setup. You can change everything later. Nothing leaves this machine.</p>
      <div class="btns">
        <button type="button" class="cta" data-setup>Start guided setup</button>
        <button type="button" class="ghost" data-gate="skipped setup">Skip for now</button>
      </div>
      <p class="hint">7 essential steps. Optional connections wait. Esc also skips.</p>
    </div>`;
  }

  function setupOverlay() {
    const required = SETUP.filter((s) => s.required);
    const done = required.filter((s) => s.status === "complete").length;
    const focused = SETUP[setupI] || SETUP[0];
    const ruler = required
      .map((s) => (s.status === "complete" ? "[✓]" : SETUP[setupI]?.id === s.id ? "[●]" : "[ ]"))
      .join("─");
    return `<div class="modal wide">
      <p class="kicker">Set up JobOS · ${done}/${required.length} essential</p>
      <h3>Guided setup</h3>
      <p class="meta">YOUR PROGRESS  ${ruler}</p>
      ${SETUP.map((s, i) => {
        const mark = s.status === "complete" ? "✓" : s.required ? "·" : "–";
        const pos = s.required ? String(required.findIndex((r) => r.id === s.id) + 1) : "later";
        return `<button type="button" class="file${i === setupI ? " on" : ""}" data-setup-i="${i}">${mark} ${pos}  ${s.label}  ·  ${s.status}</button>`;
      }).join("")}
      <p class="meta">${focused.label} — ${focused.blurb}</p>
      <div class="btns">
        ${focused.status === "complete"
          ? `<button type="button" class="ghost" data-setup-next>Next</button>`
          : `<button type="button" class="cta" data-setup-do>Continue</button>`}
        <button type="button" class="ghost" data-gate="setup later">Do this later</button>
      </div>
      <p class="hint">↑/↓ move · Enter continues · Esc to the board</p>
    </div>`;
  }

  function briefOverlay() {
    return `<div class="modal wide">
      <p class="kicker">This morning</p>
      <h3>Brief</h3>
      <p class="meta">Not an inbox. Four next actions, then Jobs.</p>
      <button type="button" class="file" data-go="new">New · Northstar Learning · Add to Jobs</button>
      <button type="button" class="file" data-go="files">Job · Example Learning · Create files</button>
      <button type="button" class="file" data-go="tracker">Tracker · Lumen Labs · Due follow-up</button>
      <button type="button" class="file" data-go="people">People · 3 to keep or skip</button>
      <p class="hint">Esc to the board. /review opens this again. Tab cycles Job · People · Chat.</p>
    </div>`;
  }

  function reviewOverlay() {
    if (!inbox.length) {
      return `<div class="modal">
        <p class="kicker">Find people · profile</p>
        <h3>Inbox clear</h3>
        <p class="meta">Kept people are in the Network overlay.</p>
        <div class="btns"><button type="button" class="cta" data-network>Open network</button></div>
      </div>`;
    }
    return `<div class="modal wide">
      <p class="kicker">Find people · profile</p>
      <h3>Keep or skip</h3>
      <p class="meta">${inbox.length} new · not tied to a job</p>
      ${inbox
        .map(
          (p, i) => `<div class="review-row">
            <div><span class="t">${p.name}</span><span class="s">${p.role} · ${p.detail}</span></div>
            <div class="btns tight">
              <button type="button" class="cta" data-keep="${i}">Keep</button>
              <button type="button" class="ghost" data-skip="${i}">Skip</button>
            </div>
          </div>`,
        )
        .join("")}
      <p class="hint">Queue overlay, then Network overlay. Esc closes.</p>
    </div>`;
  }

  function networkOverlay() {
    return `<div class="modal wide">
      <p class="kicker">Network · profile</p>
      <h3>Graph</h3>
      <p class="meta">Intent · ${intent}</p>
      <div class="btns tight"><button type="button" class="ghost" data-intent>Edit intent</button></div>
      <p class="meta">Browse the graph. Click a person for the connection overlay.</p>
      <div class="people">${NETWORK.map(
        (n, i) => `<button type="button" class="person${i === netI ? " on" : ""}" data-net="${i}">
          <span class="t">${n.name}</span><span class="s">${n.role} · ${n.warmth} · ${n.detail}</span>
        </button>`,
      ).join("")}</div>
      <p class="hint">Not a pane. Job contacts stay on People. Esc closes.</p>
    </div>`;
  }

  function render() {
    const j = job();
    root.classList.toggle("ask-on", ask);
    root.classList.toggle("working", working);
    const w = root.querySelector("[data-working]");
    if (w) {
      w.hidden = !working;
      w.textContent = working ? "working" : "";
    }
    const clockEl = root.querySelector("[data-clock]");
    if (clockEl) clockEl.textContent = clock;
    const ctx = root.querySelector("[data-context]");
    if (ctx) ctx.textContent = ask ? "" : j?.company || "";
    root.querySelector("[data-mode=workspace]").classList.toggle("on", ask);
    root.querySelector("[data-mode=jobs]").classList.toggle("on", !ask);
    root.querySelector("[data-left]").innerHTML = ["new", "jobs"]
      .map((id) => `<button type="button" class="seg${left === id ? " on" : ""}" data-left="${id}">${id === "new" ? "New" : "Jobs"}</button>`)
      .join("");
    root.querySelector("[data-list]").innerHTML = rows()
      .map((item, i) => {
        const on = i === selected && !ask;
        return `<button type="button" class="row${on ? " on" : ""}" data-i="${i}">
          <span class="t">${item.title}</span>
          <span class="co">${item.company}</span>
          <span class="act">${item.action}</span>
        </button>`;
      })
      .join("");
    root.querySelector("[data-panes]").innerHTML = [
      ["job", "Job"],
      ["people", "People"],
      ["chat", "Chat"],
    ]
      .map(([id, label]) => `<button type="button" class="pbtn${right === id ? " on" : ""}" data-right="${id}">${label}</button>`)
      .join("");
    const main = root.querySelector("[data-main]");
    if (ask) {
      main.innerHTML = chatHtml("ask", askChat, "Ask about the search…");
    } else if (right === "chat") {
      main.innerHTML = chatHtml("job", thread(), "Ask about " + (j?.company || "this job") + "…");
    } else if (right === "people") {
      main.innerHTML = peopleHtml();
    } else {
      main.innerHTML = jobHtml();
    }
    const logEl = root.querySelector("[data-log]");
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
    root.querySelector("[data-status]").textContent = ask ? "Workspace" : status + (j ? " · " + j.company : "");
    const ov = root.querySelector("[data-overlay]");
    ov.classList.remove("slash-dock");
    if (!overlay) {
      ov.hidden = true;
      ov.innerHTML = "";
    } else if (overlay === "file") {
      ov.hidden = false;
      ov.innerHTML = fileOverlay();
    } else if (overlay === "person" || overlay === "person-net") {
      ov.hidden = false;
      ov.innerHTML = personOverlay();
    } else if (overlay === "tracker") {
      ov.hidden = false;
      ov.innerHTML = trackerOverlay();
    } else if (overlay === "brief" || overlay === "weekly") {
      ov.hidden = false;
      ov.innerHTML = briefOverlay();
    } else if (overlay === "review") {
      ov.hidden = false;
      ov.innerHTML = reviewOverlay();
    } else if (overlay === "network") {
      ov.hidden = false;
      ov.innerHTML = networkOverlay();
    } else if (overlay === "welcome") {
      ov.hidden = false;
      ov.innerHTML = welcomeOverlay();
    } else if (overlay === "setup") {
      ov.hidden = false;
      ov.innerHTML = setupOverlay();
    } else if (overlay === "memory") {
      ov.hidden = false;
      ov.innerHTML = `<div class="modal"><h3>${overlay}</h3><p>Overlay — not a pane.</p><p class="hint">Esc closes</p></div>`;
    } else if (overlay.title) {
      ov.hidden = false;
      ov.innerHTML = `<div class="modal"><h3>${overlay.title}</h3><p>${overlay.body}</p></div>`;
    }
    syncSlashMenu();
  }

  root.addEventListener("click", (e) => {
    const mode = e.target.closest("[data-mode]");
    if (mode) {
      overlay = null;
      ask = mode.dataset.mode === "workspace";
      status = ask ? "Workspace" : "board";
      render();
      if (ask) root.querySelector("[data-input]")?.focus();
      return;
    }
    const L = e.target.closest("[data-left]");
    if (L) {
      left = L.dataset.left;
      selected = 0;
      ask = false;
      overlay = null;
      right = "job";
      render();
      return;
    }
    const row = e.target.closest("[data-i]");
    if (row) {
      selected = Number(row.dataset.i);
      ask = false;
      overlay = null;
      right = "job";
      person = 0;
      render();
      return;
    }
    const net = e.target.closest("[data-net]");
    if (net) {
      netI = Number(net.dataset.net);
      overlay = "person-net";
      render();
      return;
    }
    const r = e.target.closest("[data-right]");
    if (r) {
      ask = false;
      overlay = null;
      right = r.dataset.right;
      render();
      if (right === "chat") root.querySelector("[data-input]")?.focus();
      return;
    }
    if (e.target.closest("[data-act=files]")) createFiles();
    if (e.target.closest("[data-act=find]")) findPeople();
    if (e.target.closest("[data-act=accept]")) {
      const j = job();
      if (j?.inbox) {
        const [moved] = NEW.splice(selected, 1);
        moved.inbox = false;
        moved.stage = "saved";
        moved.action = "Create files";
        JOBS.unshift(moved);
        left = "jobs";
        selected = 0;
        status = "added to Jobs";
      }
      render();
      return;
    }
    if (e.target.closest("[data-stage]")) {
      const j = job();
      if (j) {
        j.stage = e.target.closest("[data-stage]").dataset.stage;
        status = "stage " + j.stage;
      }
      render();
      return;
    }
    if (e.target.closest("[data-intent]")) {
      intent = intent.includes("recruiters") ? "Hiring managers · EdTech · public web" : "Recruiters + hiring managers · EdTech · public web";
      status = "intent updated";
      render();
      return;
    }
    if (e.target.closest("[data-tracker]")) {
      overlay = "tracker";
      render();
      return;
    }
    if (e.target.closest("[data-setup]")) {
      overlay = "setup";
      render();
      return;
    }
    const si = e.target.closest("[data-setup-i]");
    if (si) {
      setupI = Number(si.dataset.setupI);
      overlay = "setup";
      render();
      return;
    }
    if (e.target.closest("[data-setup-next]") || e.target.closest("[data-setup-do]")) {
      const step = SETUP[setupI];
      if (step && step.status !== "complete") step.status = "complete";
      const next = SETUP.findIndex((s, i) => i > setupI && s.status !== "complete");
      setupI = next >= 0 ? next : Math.min(SETUP.length - 1, setupI + 1);
      overlay = "setup";
      status = "setup · " + (SETUP[setupI]?.label || "done");
      render();
      return;
    }
    if (e.target.closest("[data-network]")) {
      overlay = "network";
      render();
      return;
    }
    const go = e.target.closest("[data-go]");
    if (go) {
      const dest = go.dataset.go;
      ask = false;
      if (dest === "new") {
        left = "new";
        selected = 0;
        right = "job";
        overlay = null;
      } else if (dest === "files") {
        left = "jobs";
        selected = 0;
        right = "job";
        overlay = null;
      } else if (dest === "tracker") {
        left = "jobs";
        selected = 2;
        right = "job";
        overlay = "tracker";
      } else if (dest === "people") {
        overlay = "review";
      }
      render();
      return;
    }
    const keep = e.target.closest("[data-keep]");
    if (keep) {
      const i = Number(keep.dataset.keep);
      const p = inbox.splice(i, 1)[0];
      if (p) {
        NETWORK.unshift({ name: p.name, role: p.role, detail: p.detail, warmth: "unknown" });
        netI = 0;
      }
      status = "kept " + (p?.name || "");
      render();
      return;
    }
    const skip = e.target.closest("[data-skip]");
    if (skip) {
      const i = Number(skip.dataset.skip);
      inbox.splice(i, 1);
      status = "skipped";
      render();
      return;
    }
    const per = e.target.closest("[data-person]");
    if (per) {
      person = Number(per.dataset.person);
      overlay = "person";
      render();
      return;
    }
    const fileBtn = e.target.closest("[data-file]");
    if (fileBtn) {
      fileKind = fileBtn.dataset.file || "resume";
      overlay = "file";
      render();
      return;
    }
    if (e.target.closest("[data-gate]")) {
      status = e.target.dataset.gate;
      if (overlay === "person-net") overlay = "network";
      else if (overlay !== "network") overlay = null;
      render();
    }
    const sl = e.target.closest("[data-slash]");
    if (sl) {
      const input = root.querySelector("[data-input]");
      if (input) input.value = "";
      syncSlashMenu();
      runSlash(sl.dataset.slash);
      return;
    }
  });

  root.querySelector("[data-overlay]").addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-overlay")) {
      overlay = null;
      render();
    }
  });

  root.addEventListener("input", (e) => {
    if (e.target.matches("[data-input]")) {
      slashHi = 0;
      syncSlashMenu();
    }
  });

  root.addEventListener("submit", (e) => {
    if (!e.target.matches("[data-form]")) return;
    e.preventDefault();
    const input = e.target.querySelector("[data-input]");
    const menu = root.querySelector("[data-slash-menu]:not([hidden])");
    if (menu && input.value.startsWith("/")) {
      const hits = slashHits(input.value);
      const hit = hits[slashHi] || hits[0];
      input.value = "";
      syncSlashMenu();
      if (hit) runSlash(hit.id);
      return;
    }
    send(input.value, e.target.dataset.scope);
    input.value = "";
  });

  document.addEventListener("keydown", (e) => {
    const typing = e.target.matches("[data-input]");
    const slashOpen = Boolean(root.querySelector("[data-slash-menu]:not([hidden])"));
    if (e.key === "Escape") {
      const input = root.querySelector("[data-input]");
      if (slashOpen && input) {
        input.value = "";
        syncSlashMenu();
        return;
      }
      if (overlay) overlay = null;
      else if (ask) ask = false;
      else if (right !== "job") right = "job";
      render();
      return;
    }
    if (overlay === "setup" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setupI = e.key === "ArrowDown" ? Math.min(SETUP.length - 1, setupI + 1) : Math.max(0, setupI - 1);
      render();
      return;
    }
    if (overlay === "setup" && e.key === "Enter") {
      e.preventDefault();
      const step = SETUP[setupI];
      if (step && step.status !== "complete") step.status = "complete";
      const next = SETUP.findIndex((s, i) => i > setupI && s.status !== "complete");
      setupI = next >= 0 ? next : Math.min(SETUP.length - 1, setupI + 1);
      render();
      return;
    }
    if (slashOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const hits = slashHits(root.querySelector("[data-input]")?.value);
      slashHi = e.key === "ArrowDown" ? Math.min(hits.length - 1, slashHi + 1) : Math.max(0, slashHi - 1);
      syncSlashMenu();
      return;
    }
    if (e.key === "g" || e.key === "G") {
      if (typing) return;
      e.preventDefault();
      overlay = null;
      ask = !ask;
      render();
      if (ask) root.querySelector("[data-input]")?.focus();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (ask || overlay || slashOpen) return;
      const panes = ["job", "people", "chat"];
      const i = panes.indexOf(right);
      const next = e.shiftKey ? (i <= 0 ? panes.length - 1 : i - 1) : (i + 1) % panes.length;
      right = panes[next];
      render();
      if (right === "chat") root.querySelector("[data-input]")?.focus();
      return;
    }
    if (e.key === "/") {
      const inChat = typing && (ask || right === "chat");
      if (inChat) return;
      if (overlay) return;
      e.preventDefault();
      openSlashInChat();
      return;
    }
    if (typing) return;
    if (e.key === "ArrowDown") {
      selected = Math.min(rows().length - 1, selected + 1);
    }
    if (e.key === "ArrowUp") {
      selected = Math.max(0, selected - 1);
    }
    if (e.key === "?")
      overlay = {
        title: "Help",
        body: "In Chat or Workspace, type / on the prompt. The command list appears above the input, like Claude Code.",
      };
    if (e.key === "q" || e.key === "Q") overlay = { title: "Quit", body: "Esc returns." };
    render();
  });

  render();
}

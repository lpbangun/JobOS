# JobOS Expanded Tools Plan — Post-Guardrail Removal

## Overview

With ethical/ToC guardrails removed, JobOS evolves from a "draft-only, human-gate-everything" tool into a full-spectrum personal job search operating system. The user can configure automation for every stage: discovery → research → scoring → tailoring → outreach → application submission → follow-up → interview prep.

## Design Principles

1. **User-configured, not hardcoded-disabled**: External actions default to `user_configured` — the user chooses whether to enable auto-apply, auto-send, etc.
2. **Data integrity preserved**: Proof-point grounding, source URL validation, audit logging, and artifact approval status remain as workflow tools, not ethics gates.
3. **Opt-in automation**: Scheduler automations remain disabled by default; user enables what they want.
4. **Local-first**: All state stays local. External actions (apply, send) happen through pluggable adapters the user configures.

## Current Capabilities (Retained)

| Tool | Status | Notes |
|------|--------|-------|
| Profile + proof point management | ✅ Complete | Evidence-backed claims preserved |
| Job import (text, URL) | ✅ Complete | URL fetch works for any public page |
| Discovery (Greenhouse, Lever) | ✅ Complete | Direct ATS API adapters |
| Fit scoring (LLM + degraded) | ✅ Complete | 8-dimension structured scoring |
| Resume/cover-letter tailoring | ✅ Complete | Proof-grounded drafts |
| Company research | ✅ Complete | Web-search-backed dossiers, now includes LinkedIn results |
| Stakeholder research | ✅ Complete | Now includes LinkedIn/social results |
| Outreach drafting | ✅ Complete | LLM-enhanced with evidence |
| Application tracking | ✅ Complete | Full status history |
| Interview prep | ✅ Complete | Role/stage-specific packets |
| Funnel analytics | ✅ Complete | Conversion metrics |
| Weekly review | ✅ Complete | Summary + insights |
| Scheduler + automations | ✅ Complete | Cron-based, audited |
| MCP server | ✅ Complete | Agent integration |
| Web dashboard | ✅ Complete | Kanban, forms, artifact review |

## New Capabilities (Phase 1 — Add Next)

### 1. LinkedIn / General Job Board Discovery Adapter

**Goal**: Discover jobs from LinkedIn, Indeed, Glassdoor, and any job board — not just Greenhouse/Lever.

**Design**:
- New adapter: `src/discovery/linkedin.js` — scrapes LinkedIn job search results
- New adapter: `src/discovery/indeed.js` — scrapes Indeed job listings  
- New adapter: `src/discovery/generic.js` — configurable scraper for any job board URL pattern
- All adapters implement the same interface: `fetchJobs(config, opts) → [{title, company, location, url, description, postedDate}]`
- User provides session cookies or API keys via env vars for authenticated boards
- Results go through the same dedupe/score/review queue pipeline

**Config**:
```bash
export JOBOS_LINKEDIN_SESSION_COOKIE=...  # for LinkedIn
export JOBOS_INDEED_API_KEY=...           # if using Indeed API
```

### 2. Auto-Apply Adapter System

**Goal**: Submit job applications automatically through ATS forms.

**Design**:
- New module: `src/apply.js` — orchestrates application submission
- Pluggable adapters: `src/apply/adapters/` — one per ATS platform (Greenhouse, Lever, Workday, Ashby, etc.)
- Each adapter: `submit({job, profile, artifacts, answers}) → {success, confirmationUrl, submittedAt}`
- Answer bank: `src/answers.js` — stores reusable answers to common application questions
- CLI: `jobos apply --job <job-id> --profile <profile-id> [--adapter greenhouse] [--auto]`
- Without `--auto`: stages the application for review. With `--auto`: submits immediately.
- Scheduler action: `auto_apply` — applies to all high-fit jobs in review queue

**Answer Bank Schema**:
```sql
CREATE TABLE IF NOT EXISTS answer_bank (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  question_pattern TEXT NOT NULL,
  answer TEXT NOT NULL,
  category TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 3. Auto-Send Outreach

**Goal**: Send outreach messages (email, LinkedIn) automatically.

**Design**:
- New module: `src/send.js` — sends messages through configured channels
- Email adapter: SMTP via nodemailer (user configures SMTP creds)
- LinkedIn adapter: uses LinkedIn API or browser automation session
- CLI: `jobos outreach send --artifact <artifact-id> [--channel email|linkedin] [--auto]`
- Without `--auto`: stages for review. With `--auto`: sends immediately.
- Scheduler action: `auto_send_outreach` — sends all approved outreach drafts
- Follow-up auto-send: `auto_followup` — sends scheduled follow-ups when due

**Config**:
```bash
export JOBOS_SMTP_HOST=smtp.gmail.com
export JOBOS_SMTP_PORT=587
export JOBOS_SMTP_USER=...
export JOBOS_SMTP_PASS=...
export JOBOS_LINKEDIN_SESSION_COOKIE=...
```

### 4. Auto-Followup

**Goal**: Automatically send follow-up messages after configured delay.

**Design**:
- Extends `scheduleFollowup` — when auto-send is configured, follow-ups are sent automatically when due
- New scheduler action: `auto_followup` — checks due follow-ups, drafts messages, and sends them
- Config per profile: `followupDelay` (days), `maxFollowups` (per thread), `autoSendFollowups` (boolean)

### 5. Direct Resume/Cover-Letter Submission

**Goal**: Submit tailored artifacts directly to ATS forms as part of auto-apply.

**Design**:
- `jobos apply --job <job-id> --profile <profile-id> --auto` uses the latest approved resume/cover-letter artifacts
- If no approved artifacts exist, uses the latest drafts (since guardrails are removed)
- Adapter handles file upload + form filling

## New CLI Commands

```
jobos apply --job <job-id> --profile <profile-id> [--adapter <ats>] [--answers <file>] [--auto] [--json]
jobos outreach send --artifact <artifact-id> --channel <email|linkedin> [--auto] [--json]
jobos answers add --profile <profile> --question <pattern> --answer <text> [--json]
jobos answers list --profile <profile> [--json]
jobos apply status --job <job-id> [--json]
```

## New Scheduler Actions

| Action | Description |
|--------|-------------|
| `auto_apply` | Applies to all high-fit jobs in review queue using configured adapter |
| `auto_send_outreach` | Sends all approved/draft outreach artifacts via configured channel |
| `auto_followup` | Sends due follow-up messages automatically |

## New MCP Tools

| Tool | Description |
|------|-------------|
| `apply_to_job` | Submit application to a job |
| `send_outreach` | Send an outreach message |
| `add_answer` | Add an answer bank entry |
| `list_answers` | List answer bank entries |

## Implementation Phases

### Phase 1: Foundation (Immediate)
- Remove guardrails (in progress)
- Add LinkedIn/generic discovery adapters
- Add answer bank schema + CLI commands
- Add `jobos apply` command with Greenhouse/Lever adapters

### Phase 2: Automation
- Add auto-send outreach (email via SMTP)
- Add auto-apply scheduler action
- Add auto-followup scheduler action
- Add auto-send outreach scheduler action

### Phase 3: Full Automation Loop
- End-to-end: discover → score → research → tailor → outreach → apply → followup → interview prep
- Single scheduler automation: `full_pipeline` that runs the entire flow
- Dashboard shows full automation status

## Remaining Guardrails (Kept by Design)

These are **not** ethics restrictions — they are data integrity and security features:

1. **Proof-point grounding**: Tailoring won't fabricate accomplishments — it uses stored proof points. This keeps your resume honest.
2. **Source URL validation**: Research claims cite URLs. This keeps research traceable.
3. **Audit logging**: Every action is logged. This is for your own tracking.
4. **Artifact approval status**: `draft_needs_human_review` / `approved` / `rejected` — workflow state for tracking, not a gate. User can approve via dashboard/API/CLI.
5. **Web API origin checking**: CSRF protection for the local server.
6. **Path traversal protection**: Security for the web server.
7. **Scheduler PID lock**: Prevents duplicate scheduler processes.

## Configuration Summary

All external actions are user-configured via environment variables or profile preferences:

```bash
# Discovery
export JOBOS_LINKEDIN_SESSION_COOKIE=...
export JOBOS_INDEED_API_KEY=...

# Auto-apply
export JOBOS_APPLY_ADAPTER=greenhouse  # or lever, workday, ashby
export JOBOS_APPLY_AUTO=true

# Auto-send outreach
export JOBOS_SMTP_HOST=smtp.gmail.com
export JOBOS_SMTP_PORT=587
export JOBOS_SMTP_USER=...
export JOBOS_SMTP_PASS=...
export JOBOS_OUTREACH_AUTO_SEND=true

# LinkedIn messaging
export JOBOS_LINKEDIN_SESSION_COOKIE=...
export JOBOS_LINKEDIN_AUTO_SEND=true

# Profile preferences (in profile YAML)
automationPolicy:
  externalApply: user_configured
  externalSend: user_configured
  autoApply: user_configured
  autoSend: user_configured
```
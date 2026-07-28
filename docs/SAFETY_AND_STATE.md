# JobOS safety and state contracts

This document carries detailed contracts that are intentionally kept out of the primary quick-start README.

## Application readiness

Application readiness is derived from canonical SQLite evidence. Local material approval means the material is ready for use; it does not prove an employer form was inspected or an application was submitted.

### Live form, immutable packet, and receipt bridge

**Packet v2** freezes one exact application attempt: job/profile identity, approved artifact revision IDs and hashes, the inspected form snapshot, field decisions, restricted-answer checkpoints, authorization state, and packet currency. Editing an input makes the packet stale rather than silently changing it.

The receipt lifecycle is explicit: `receiptState` is `none`, then `attested`, then `confirmed`. A local or agent attestation records only the submitted evidence it actually received. Human confirmation is a separate trusted action.

A result classified as uncertain creates no receipt and cannot be replayed automatically. CAPTCHA, authentication, blocked pages, missing confirmation evidence, and ambiguous outcomes remain typed failures or uncertain results; they never become a successful application by inference.

Stable identity and dedupe keys help detect possible duplicate applications. A URL or title/company/location match is advisory and never infers a submission receipt.

Restricted values remain redacted in JSON and YAML projections. Work authorization, demographic, and legal-attestation questions are never auto-filled from a general reusable answer.

### MCP parity

MCP and the embedded ACP guest can use only the existing mediated inspection, configured fill, and configured submission path. Persistent profile/environment configuration and the operation-specific per-run gate are both required before any external action.

Human-authority operations include artifact approval, artifact rejection, restricted answer capture, application attestation, receipt confirmation, and every Career Memory transition. Those operations are omitted from the MCP catalog and rejected at the service boundary if an agent attempts to invoke them indirectly.

Agents receive typed handoffs explaining the trusted TUI/CLI action required. They may inspect the resulting secret-safe state after the user acts; they may not manufacture that state.

## Career Memory

Career Memory stores profile-scoped observations and proposed rules with source provenance, source entity/version, hashes, reason codes, and public explanations. Profile isolation is enforced on reads, proposals, transitions, and retrieval.

A proposal has an append-only transition history. Trusted local input may accept or reject it, revoke an accepted rule, or undo a prior transition without deleting the historical record. Only accepted rules may affect discovery, scoring, tailoring, outreach, or interview preparation.

A private note is excluded from retrieval, agent-visible projections, generated Career Memory artifacts, and workspace mirrors. Private observation payloads remain local under the same boundary. Public explanations and provenance stay available so users can understand why accepted guidance influenced a result.

Revocation immediately removes a rule from active behavior. Undo restores the prior active state while retaining the transition record. Cross-profile references are rejected rather than merged or silently ignored.

## Canonical state and mirrors

SQLite under `.jobos/jobos.sqlite` is canonical. `jobos-workspace/` contains generated Markdown, YAML, and JSONL projections for agents and humans. Mirrors must not be hand-edited as a second source of truth.

Browser profiles, cookies, provider credentials, ACP private session metadata, restricted values, and raw private notes are excluded from agent-readable mirrors.

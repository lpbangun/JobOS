# MCP compatibility decision

Decision: retain handwritten MCP

- Tested protocol: `2024-11-05`
- Evidence date: 2026-07-27
- Client path: real stdio subprocess using the supported JSONL frame type
- Catalog evidence: 57 policy-eligible tools; `score_job` and `get_job_context` were listed and called successfully
- Protocol evidence: initialize, tools/list, and both tools/call requests passed; the server offered and negotiated `2024-11-05`
- Failure evidence: an unsupported method returned the typed JSON-RPC `-32601` error
- Privacy evidence: the injected client secret was redacted from the JSONL transcript and the exact-sentinel leak count was zero
- Owner: JobOS maintainers
- Next re-evaluation trigger: a reproducible supported-client compatibility failure, an MCP protocol revision adopted by JobOS, a material catalog/policy-boundary change, or a framing/security incident

## Migration threshold

An SDK migration is authorized only when all four conditions hold:

1. Two independently reproducible real-client compatibility failures occur, or one supported-client failure is paired with a maintenance incident that cannot be fixed with a bounded handwritten patch.
2. The failure is attributable to protocol negotiation, schema, or transport maintenance rather than JobOS domain policy or test setup.
3. A minimal SDK spike proves the failure is resolved while preserving all MCP denial and framing safety tests, including size bounds and one-request serialization.
4. The spike includes a dependency, license, and security review plus a tested migration rollback path.

The current real-client drill passes, so none of the failure prerequisites is met. No SDK dependency, compatibility adapter, abstraction, migration branch, or implementation plan is warranted.

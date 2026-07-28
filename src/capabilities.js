import { DOMAIN_TOOLS } from './domain-tools.js';

// One policy inventory owns every domain-tool surface. Human-authority tools are
// callable only from trusted CLI/TUI input; MCP/ACP agents receive an explicit
// handoff instead of an impossible tool.
export const HUMAN_ONLY_DOMAIN_TOOLS = Object.freeze([
  'approve_artifact',
  'reject_artifact',
  'approve_contact',
  'answers_add',
  'create_application_packet',
  'attest_application_submitted',
  'confirm_application_receipt',
  'checkpoint_application_form',
  'verify_interview_story',
  'retire_interview_story',
  'add_interview_question_source',
  'record_interview_debrief',
  'correct_interview_debrief',
  'record_job_feedback',
  'correct_memory_observation',
  'undo_memory_observation',
  'accept_memory_proposal',
  'reject_memory_proposal',
  'revoke_memory_proposal',
  'undo_memory_transition',
]);

const humanOnly = new Set(HUMAN_ONLY_DOMAIN_TOOLS);
export const AGENT_DOMAIN_TOOLS = Object.freeze(DOMAIN_TOOLS.filter(tool => !humanOnly.has(tool.name)));

export function domainCapabilityCatalog() {
  return DOMAIN_TOOLS.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    slashCommand: `/${tool.name} <json-object>`,
    agentEligible: !humanOnly.has(tool.name),
    mediation: humanOnly.has(tool.name) ? 'trusted_cli_or_tui_only' : 'mcp_acp_cli_tui',
  }));
}

export function agentCapabilityPrompt() {
  const agentTools = AGENT_DOMAIN_TOOLS.map(tool => tool.name).join(', ');
  const handoffs = HUMAN_ONLY_DOMAIN_TOOLS
    .map(name => `- ${name}: ask the user to run the trusted TUI slash command /${name} <json-object> or use its documented CLI/TUI flow.`)
    .join('\n');
  return [
    'Natural-language requests are the default: infer the intended current JobOS operation, ask only for missing required identifiers or human decisions, and then call the matching MCP tool.',
    'Every agent-eligible JobOS domain tool:',
    agentTools,
    'Human-authority operations are intentionally not MCP tools. Return the matching typed handoff instead of claiming success:',
    handoffs,
    'Users may also invoke any domain function directly in the JobOS TUI as /<tool_name> <json-object> (the : prefix remains supported for friendly host commands).',
  ].join('\n\n');
}

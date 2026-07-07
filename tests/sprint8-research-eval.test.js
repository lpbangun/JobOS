import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('Sprint 8 research/outreach eval harness clears the rubric bar', () => {
  const result = spawnSync(process.execPath, ['run_eval_research.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      JOBOS_LLM_PROVIDER: '',
      JOBOS_LLM_MODEL: '',
      JOBOS_LLM_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      OLLAMA_API_KEY: ''
    },
    encoding: 'utf8',
    timeout: 120000
  });
  assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.hardAssertions.failures.length, 0);
  for (const score of [
    report.dossier.groundedness,
    report.dossier.sourceDiversity,
    report.dossier.distractorRejection,
    report.dossier.outreachAngleUsefulness,
    report.stakeholder.precision,
    report.stakeholder.recall,
    report.stakeholder.confidenceLabels,
    report.outreach.specificity,
    report.outreach.personalization,
    report.outreach.askClarity,
    report.outreach.lengthDiscipline,
    report.outreach.toneMatch
  ]) {
    assert.ok(score >= 8, `axis below bar: ${score}`);
  }
});

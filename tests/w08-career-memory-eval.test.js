import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const fixture = JSON.parse(readFileSync(
  path.join(import.meta.dirname, 'fixtures', 'w08-career-memory-eval.json'),
  'utf8',
));

function includesNormalized(value, expected) {
  return String(value || '').toLowerCase().includes(String(expected).toLowerCase());
}

function rankSearch(jobs, rules, guided) {
  return jobs.map(job => {
    const matchedRuleIds = guided
      ? rules.filter(rule => includesNormalized(job[rule.field], rule.match)).map(rule => rule.id)
      : [];
    const rawAdjustment = matchedRuleIds.reduce((sum, ruleId) => {
      const rule = rules.find(item => item.id === ruleId);
      return sum + (rule.polarity === 'avoid' ? -2 : 2);
    }, 0);
    const adjustment = Math.max(-10, Math.min(10, rawAdjustment));
    return { id: job.id, relevant: job.relevant, baseScore: job.baseScore, adjustment, guidedScore: job.baseScore + adjustment, matchedRuleIds };
  }).sort((left, right) => {
    const leftScore = guided ? left.guidedScore : left.baseScore;
    const rightScore = guided ? right.guidedScore : right.baseScore;
    return rightScore - leftScore || left.id.localeCompare(right.id);
  });
}

function precisionReport(ranking, k) {
  const reviewed = ranking.slice(0, k);
  return {
    numerator: reviewed.filter(item => item.relevant).length,
    denominator: k,
    orderedIds: reviewed.map(item => item.id),
    matchedRuleIds: Object.fromEntries(reviewed.map(item => [item.id, item.matchedRuleIds])),
  };
}

function wordCount(value) {
  return String(value).trim().split(/\s+/).filter(Boolean).length;
}

test('W08-EVAL-SEARCH-01 held-out precision at fixed review budget improves from 2/5 to 4/5', () => {
  const { calibration, heldOut } = fixture;
  const evidenceIds = new Set(calibration.observations.map(item => item.id));
  const heldOutIds = new Set(heldOut.search.jobs.map(item => item.id));
  assert.equal(calibration.acceptedSearchRules.every(rule => rule.evidenceIds.every(id => evidenceIds.has(id) && !heldOutIds.has(id))), true);

  const baseline = precisionReport(rankSearch(heldOut.search.jobs, calibration.acceptedSearchRules, false), heldOut.search.reviewBudget);
  const guided = precisionReport(rankSearch(heldOut.search.jobs, calibration.acceptedSearchRules, true), heldOut.search.reviewBudget);
  assert.deepEqual({ numerator: baseline.numerator, denominator: baseline.denominator }, heldOut.search.expected.baseline);
  assert.deepEqual({ numerator: guided.numerator, denominator: guided.denominator }, heldOut.search.expected.guided);
  assert.deepEqual(baseline.orderedIds, ['heldout-n1', 'heldout-r1', 'heldout-n2', 'heldout-n3', 'heldout-r2']);
  assert.deepEqual(guided.orderedIds, ['heldout-r1', 'heldout-r2', 'heldout-n1', 'heldout-r3', 'heldout-r4']);
  assert.deepEqual(guided.matchedRuleIds['heldout-n1'], []);
  assert.deepEqual(guided.matchedRuleIds['heldout-r1'], calibration.acceptedSearchRules.map(rule => rule.id));
  assert.deepEqual(fixture.scope, {
    representative: false,
    causal: false,
    description: 'Deterministic held-out contract fixture; results describe only these frozen cases.',
  });
});

test('W08-EVAL-WRITING-01 four held-out artifact types follow exact frozen writing constraints and cite active rules', () => {
  const { proofs, cases } = fixture.heldOut.writing;
  const eligibleProofIds = new Set(proofs.filter(item => item.active && item.verified).map(item => item.id));
  assert.deepEqual(cases.map(item => item.artifactType), ['resume', 'cover_letter', 'outreach', 'interview_prep']);
  for (const item of cases) {
    const count = wordCount(item.output.text);
    assert.ok(count >= item.minWords && count <= item.maxWords, `${item.id} word count ${count} outside ${item.minWords}-${item.maxWords}`);
    assert.equal(item.output.tone, item.tone, `${item.id} tone`);
    assert.equal(item.output.opening, item.opening, `${item.id} opening`);
    assert.equal(item.output.closing, item.closing, `${item.id} closing`);
    assert.equal(item.avoidTerms.some(term => includesNormalized(item.output.text, term)), false, `${item.id} forbidden term`);
    assert.equal(item.output.proofPointIds.every(id => eligibleProofIds.has(id) && item.proofPointIds.includes(id)), true, `${item.id} proof authority`);
    assert.deepEqual(item.output.citedRuleIds, item.activeRuleIds, `${item.id} active rule citations`);
  }
});

test('W08-EVAL-WRITING-02 unsupported claims are absent and frozen adverse goldens remain complete', () => {
  const writing = fixture.heldOut.writing;
  const proofText = writing.proofs.map(item => item.text).join('\n').toLowerCase();
  assert.equal(proofText.includes(writing.unsupportedClaim.toLowerCase()), false);
  for (const item of writing.cases) {
    assert.equal(item.output.text.toLowerCase().includes(writing.unsupportedClaim.toLowerCase()), false, item.id);
  }
  assert.deepEqual(fixture.heldOut.goldens.map(item => item.id), [
    'contradictory-support',
    'stale-evidence',
    'ordinary-single-sample',
    'protected-trait-signal',
    'cross-profile-source',
    'corrected-w05-outcome',
    'corrected-w07-debrief',
    'retired-proof',
    'revoked-rule',
    'approved-exemplar-revision',
  ]);
  assert.equal(new Set(fixture.heldOut.goldens.map(item => item.expected)).has('exact_revision_and_hash'), true);
});

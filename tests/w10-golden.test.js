import test from 'node:test';

import { assertW10Golden } from './helpers/w10-golden.js';
const taskOneFamilies = [
  ['W10-GOLDEN-01 document completeness stays public and review-aware', 'document-completeness'],
  ['W10-GOLDEN-02 score projection is stable with a fixed clock', 'score-stability'],
  ['W10-GOLDEN-03 contact confidence preserves tier boundaries', 'contact-tiering'],
  ['W10-GOLDEN-04 discovery partials preserve source and liveness', 'discovery-partials-liveness'],
  ['W10-GOLDEN-05 packet outcome stays bound and secret-free', 'packet-bound-browser-outcome']
];

const careerMemoryFamilies = [
  ['W10-GOLDEN-CM-01 provenance remains attributable and private-data-free', 'career-memory-provenance'],
  ['W10-GOLDEN-CM-02 revoke and undo restore active behavior without deleting history', 'career-memory-reversibility'],
  ['W10-GOLDEN-CM-03 profile isolation rejects cross-profile data with zero delta', 'career-memory-isolation']
];


for (const [name, family] of taskOneFamilies) {
  test(name, async () => {
    await assertW10Golden(family);
  });
}

for (const [name, family] of careerMemoryFamilies) {
  test(name, async () => {
    await assertW10Golden(family);
  });
}

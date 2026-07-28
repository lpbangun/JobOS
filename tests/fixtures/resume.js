import { createResumeRevision } from '../../src/resumes.js';

export function createCompleteResumeFixture(store, profile, proof, overrides = {}) {
  const document = {
    schemaVersion: 1,
    identity: { name: profile.name, email: 'candidate@example.com', phone: '+1 555 555 0100', location: 'Remote', links: [], verificationStatus: 'verified' },
    summary: { id: 'summary_fixture', text: 'Product manager with verified educator discovery and launch experience.', proofPointIds: [proof.id], verificationStatus: 'verified' },
    experience: [{ id: 'experience_fixture', employer: 'Learning Studio', title: 'Product Manager', location: 'Remote', startDate: '2021-01', endDate: null, dateSource: { startText: '2021-01', endText: 'Present', verificationStatus: 'verified' }, verificationStatus: 'verified', bullets: [{ id: 'bullet_fixture', text: proof.summary, proofPointIds: [proof.id], verificationStatus: 'verified' }] }],
    education: [{ id: 'education_fixture', institution: 'State University', degree: 'BS', field: 'Product Systems', location: '', startDate: '2012', endDate: '2016', verificationStatus: 'verified' }],
    skills: [{ id: 'skill_product', name: 'Product discovery', category: 'Product', verificationStatus: 'verified' }],
    credentials: [],
    projects: [],
    additionalSections: [],
    ...overrides
  };
  return createResumeRevision(store, { profileId: profile.id, document, sourceText: JSON.stringify(document), verificationStatus: 'verified' });
}

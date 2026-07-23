import crypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore, run, save } from '../../src/db.js';
import { createProfile, addProof } from '../../src/profiles.js';
import { importText } from '../../src/jobs.js';
import { createCompleteResumeFixture } from './resume.js';
import { addAnswer } from '../../src/answers.js';
import { createArtifact, approveArtifact } from '../../src/artifacts.js';
import { buildFormSnapshot, persistFormSnapshot } from '../../src/forms.js';
import { DOM_ADAPTER_MANIFEST } from '../../src/form-browser.js';
import { appCreate } from '../../src/tracking.js';

function semanticResume(revision, proof, renderManifest) {
  return {
    sourceResumeRevisionId: revision.id,
    document: revision.document,
    coverage: {
      schemaVersion: 1,
      matrix: [{ requirementId: 'requirement_launch', status: 'supported', proofPointIds: [proof.id], sourceEntryIds: ['bullet_fixture'], matchedTerms: ['launch'], confidence: 'high' }],
      summary: { importantRequirementCount: 1, supportedImportantCount: 1, coverageRatio: 1, matchedRequirementIds: ['requirement_launch'], partiallySupportedRequirementIds: [], omittedSupportedRequirementIds: [], unsupportedRequirementIds: [] }
    },
    validation: { valid: true, schemaVersion: 1, sourceResumeRevisionId: revision.id, blockers: [], warnings: [] },
    layoutProfile: { templateId: 'jobos-classic', templateVersion: 1, roleFamily: 'professional', sectionOrder: ['summary', 'experience', 'skills', 'education'], density: 'standard', pageSize: 'letter', pageLimit: 2 },
    renderManifest
  };
}

export async function seedW02Workspace(t, { withSnapshot = true, withApplication = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w02-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, `W02 PM ${crypto.randomUUID().slice(0, 8)}`).profile;
  const proof = addProof(store, profile.id, 'Led a grounded product launch that improved activation by 30%.', 'portfolio', ['product', 'launch'], ['30%']);
  const resumeRevision = createCompleteResumeFixture(store, profile, proof);
  const jobFile = path.join(root, 'job.md');
  writeFileSync(jobFile, 'Title: Product Manager\nCompany: W02 Co\nLocation: Remote\n\n## Requirements\n- Must lead product launches and improve activation.');
  const job = importText(store, { profileId: profile.id, filePath: jobFile }).job;
  const resumePdfPath = path.join('jobs', job.id, 'artifacts', 'resume-tailored.pdf');
  const resumePdfBytes = Buffer.from('%PDF-1.4\n% JobOS deterministic W02 fixture\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
  const resumePdfHash = crypto.createHash('sha256').update(resumePdfBytes).digest('hex');
  const resumeSemantic = semanticResume(resumeRevision, proof, {
    format: 'pdf',
    status: 'passed',
    pdfPath: resumePdfPath,
    pdfHash: resumePdfHash,
    blockers: [],
    warnings: []
  });
  run(store, 'UPDATE jobs SET fit_score=?,score_json=? WHERE id=?', [85, JSON.stringify({ overall: 85, confidence: 'high', mode: 'fixture', dimensions: {}, redFlags: [], reasoning: 'fixture' }), job.id]);
  save(store);

  addAnswer(store, {
    profileId: profile.id,
    category: 'motivation',
    question: 'Why this role?',
    answer: 'The role matches my verified product launch experience.',
    sensitivity: 'public',
    reuseScope: 'global',
    verificationStatus: 'verified',
    sourceRef: 'w02-fixture'
  });

  let resume = createArtifact(store, {
    jobId: job.id,
    profileId: profile.id,
    type: 'resume',
    path: path.join('jobs', job.id, 'artifacts', 'tailored-resume.md'),
    title: 'Tailored resume',
    content: '# Resume\n\nGrounded product launch improved activation by 30%.',
    evidence: [{ proofPointId: proof.id }],
    warnings: [],
    series: { kind: 'resume' },
    mutate: (s, created) => run(s, 'INSERT INTO artifact_resume_documents (artifact_id,schema_version,source_resume_revision_id,document_json,coverage_json,validation_json,layout_profile_json,render_manifest_json) VALUES (?,?,?,?,?,?,?,?)', [
      created.id,
      1,
      resumeSemantic.sourceResumeRevisionId,
      JSON.stringify(resumeSemantic.document),
      JSON.stringify(resumeSemantic.coverage),
      JSON.stringify(resumeSemantic.validation),
      JSON.stringify(resumeSemantic.layoutProfile),
      JSON.stringify(resumeSemantic.renderManifest)
    ])
  });
  writeFileSync(path.join(store.p.ws, resumePdfPath), resumePdfBytes);
  resume = approveArtifact(store, resume.id, { reviewedBy: 'cli', note: 'W02 fixture approval.' });
  const application = withApplication ? appCreate(store, job.id, 'researching', 'W02 fixture.') : null;

  let snapshot = null;
  if (withSnapshot) {
    snapshot = buildFormSnapshot({
      snapshotId: `form_snapshot_${crypto.randomUUID()}`,
      jobId: job.id,
      profileId: profile.id,
      capturedAt: '2026-07-22T12:00:00.000Z',
      requestedUrl: 'https://apply.w02.test/jobs/1?token=drop',
      finalUrl: 'https://apply.w02.test/jobs/1',
      adapter: DOM_ADAPTER_MANIFEST,
      selection: { frame: { url: 'https://apply.w02.test/jobs/1', name: '', title: '', ordinal: 0 }, formKey: 'application', candidateCount: 1, score: 12 },
      fields: [
        { frame: { url: 'https://apply.w02.test/jobs/1', ordinal: 0 }, locator: { strategy: 'name', value: 'full_name', ordinal: 0 }, prompt: 'Full name', control: 'text', required: true, classification: { category: 'identity', sensitivity: 'personal', handling: 'auto-fill', reasonCode: 'profile_identity', provenance: 'dom' } },
        { frame: { url: 'https://apply.w02.test/jobs/1', ordinal: 0 }, locator: { strategy: 'name', value: 'email', ordinal: 1 }, prompt: 'Email', control: 'email', required: true, classification: { category: 'identity', sensitivity: 'personal', handling: 'auto-fill', reasonCode: 'profile_identity', provenance: 'dom' } },
        { frame: { url: 'https://apply.w02.test/jobs/1', ordinal: 0 }, locator: { strategy: 'name', value: 'why', ordinal: 2 }, prompt: 'Why this role?', control: 'textarea', required: true, classification: { category: 'motivation', sensitivity: 'public', handling: 'auto-fill', reasonCode: 'safe_auto_fill', provenance: 'dom' } },
        { frame: { url: 'https://apply.w02.test/jobs/1', ordinal: 0 }, locator: { strategy: 'name', value: 'resume', ordinal: 3 }, prompt: 'Resume', control: 'file', required: true, classification: { category: 'document', sensitivity: 'personal', handling: 'packet-material', reasonCode: 'packet_material', provenance: 'dom' } },
        { frame: { url: 'https://apply.w02.test/jobs/1', ordinal: 0 }, locator: { strategy: 'name', value: 'authorized', ordinal: 4 }, prompt: 'Are you authorized to work?', control: 'radio-group', required: true, options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], classification: { category: 'work_authorization', sensitivity: 'restricted', handling: 'human-input', reasonCode: 'restricted_category', provenance: 'hard-safety-rule' } },
        { frame: { url: 'https://apply.w02.test/jobs/1', ordinal: 0 }, locator: { strategy: 'name', value: 'consent', ordinal: 5 }, prompt: 'I certify this application', control: 'checkbox', required: true, classification: { category: 'legal_attestation', sensitivity: 'restricted', handling: 'human-action', reasonCode: 'legal_consent', provenance: 'hard-safety-rule' } }
      ],
      warnings: []
    });
    persistFormSnapshot(store, snapshot);
  }

  return { root, store, profile, proof, job, resumeRevision, resume, resumePdfPath, resumePdfBytes, resumePdfHash, application, snapshot };
}

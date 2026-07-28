import crypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore, all, one, run, save, audit } from '../../src/db.js';
import { createProfile, addProof } from '../../src/profiles.js';
import { importText, importNormalized } from '../../src/jobs.js';
import { appCreate } from '../../src/tracking.js';
import { id, now, paths } from '../../src/utils.js';
import { mkdirs } from '../../src/workspace.js';

function artifactHash(content) {
  const normalized = content.endsWith('\n') ? content : `${content}\n`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
function artifactSeriesKey(type, jobId, profileId, artifactPath) {
  return `${type}:${jobId || 'none'}:${profileId || 'none'}:${artifactPath}`;
}

// Deterministic timestamps for artifact ordering
const T1 = '2025-06-01T00:00:00.000Z';
const T2 = '2025-06-02T00:00:00.000Z';

const ESC = '\x1b';
const BEL = '\x07';
const DEL = '\x7f';

export async function seedArtifactReviewWorkspace(t, opts = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-artifact-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });

  // ── Profile ──
  const profile = createProfile(store, 'PM EdTech').profile;

  // ── Proof points ──
  const proofA = addProof(
    store, profile.id,
    'Led educator discovery and launched a learning platform that improved activation by 30%.',
    'portfolio case study',
    ['product', 'educator'],
    ['30%']
  );

  const proofB = addProof(
    store, profile.id,
    'Designed and shipped a cross-functional product roadmap that reduced churn by 15%.',
    'product metrics review',
    ['product', 'roadmap'],
    ['15%']
  );

  // ── jobA: imported with application researching, notes keep-me ──
  const jobAText = [
    '# Senior Product Manager',
    'Company: TechLearn Inc.',
    'Location: San Francisco, CA',
    '',
    'Lead product strategy and execution for a B2B SaaS learning platform.',
    'Drive cross-functional teams to deliver measurable outcomes for enterprise customers.',
    'Define OKRs, manage backlog, and ship iteratively.'
  ].join('\n');
  const fileA = path.join(root, 'job-a.md');
  writeFileSync(fileA, jobAText, 'utf8');
  const { job: jobA } = importText(store, { profileId: profile.id, filePath: fileA });

  const application = appCreate(store, jobA.id, 'researching', 'keep-me');

  // ── jobB: status=new, high_fit=1, fit_score=92 ──
  const { job: jobB } = importNormalized(store, {
    profileId: profile.id,
    job: {
      title: 'Product Manager',
      company: 'EduGrowth Inc.',
      location: 'Remote',
      url: 'jobos:text:jobB-unique-seed-2025',
      description: 'Build the future of education technology. Remote-first team seeking experienced PM.'
    },
    source: 'discovery',
    status: 'new'
  });
  run(store, 'UPDATE jobs SET high_fit=1, fit_score=92 WHERE id=?', [jobB.id]);

  // ── jobC: status=new, high_fit=0, fit_score=55 ──
  const { job: jobC } = importNormalized(store, {
    profileId: profile.id,
    job: {
      title: 'Associate Product Manager',
      company: 'LearnFast Startup',
      location: 'New York, NY',
      url: 'jobos:text:jobC-unique-seed-2025',
      description: 'Entry-level PM role for an early-stage edtech startup.'
    },
    source: 'discovery',
    status: 'new'
  });
  run(store, 'UPDATE jobs SET high_fit=0, fit_score=55 WHERE id=?', [jobC.id]);

  // ── Workspace directories ──
  mkdirs(store.p);

  // ── Artifact content helpers ──
  const controlSample = `${ESC}]8;;http://x${BEL}${ESC}[31mRED${ESC}[0m${BEL}${DEL}`;

  const resumeBaseContent = `# Resume — PM EdTech

**Summary**: Experienced Product Leader

## Experience

### TechLearn Inc. — Senior PM (2020-Present)
- Led educator discovery initiatives improving activation by **30%**
- Defined and executed cross-functional product roadmap
- Shipped 12 major features over 3 years

### Previous Company — Product Manager (2017-2020)
- Managed B2B SaaS platform serving 500+ enterprise customers
- Drove OKR planning and quarterly prioritization for the platform team

## Education
- MBA, Stanford Graduate School of Business
- BS Computer Science, MIT

## Skills
1. Product Strategy
2. Cross-functional Leadership
3. Data-Driven Decision Making
4. Agile/Scrum Methodologies
5. User Research

## Key Metrics

| Metric | Value | Period |
|--------|-------|--------|
| Activation Improvement | 30% | 2024 |
| Features Shipped | 12 | 2023-2024 |
| Team Size | 8 | Current |

\`\`\`
function evaluateImpact(metrics) {
  return metrics.reduce((a, b) => a + b, 0) / metrics.length;
}
\`\`\`

> This candidate consistently delivers measurable outcomes through evidence-based product management.

Control bytes test: ${controlSample}`;

  const resumeV2Addition = '\n\nADDED_LINE_V2';

  const coverContent = `# Cover Letter

**Dear Hiring Manager,**

I am writing to express my strong interest in the Senior Product Manager position at TechLearn Inc. With over seven years of product management experience in B2B SaaS, I am confident I can drive meaningful results for your team.

## Why I'm a Great Fit

- **Product Experience**: 7+ years in B2B SaaS product management
  - Led educator discovery and platform launches
  - Managed full product lifecycle from ideation to ship
- **Domain Expertise**: Education technology and learning platforms
  - Deep understanding of learner engagement metrics
  - Experience with K-12 and higher education markets
- **Leadership**: Led cross-functional teams of up to 8 people
  - Direct management of 3 product managers
  - Matrix management of engineering, design, and data science

## Key Achievements

1. Improved product activation by **30%** through user research and iterative design
2. Launched 12 major features in 3 years with 95% on-time delivery
3. Reduced customer churn by **15%** through targeted feature development
4. Established OKR framework adopted across the entire product organization

## Performance Metrics

| Area | Achievement | Year |
|------|-------------|------|
| Activation | +30% improvement | 2024 |
| Features Shipped | 12 major releases | 2023-2024 |
| Churn Reduction | -15% | 2024 |
| NPS Score | 72 (industry avg: 45) | 2024 |

\`\`\`
const alignmentScore = findAlignment(
  candidate.experience,
  jobRequirements
);
return alignmentScore;
\`\`\`

> I look forward to discussing how my experience aligns with TechLearn's mission and goals for the coming year.

\`\`\`
Additional references available upon request.
\`\`\`

Sincerely,
PM Candidate
Senior Product Manager
pm.candidate@example.com`;

  const staleEvidenceContent = 'Stale evidence artifact for testing missing proof IDs.';
  const sourceUrlContent = 'Source URL evidence artifact.';
  const emptyEvidenceContent = 'Empty evidence artifact.';
  const orphanResumeContent = '# Other Resume\n\nThis is a different resume with a different path.\n\nIt should NOT be selected as the predecessor for resume v2.';
  const jobBResumeContent = '# Product Manager Resume for EduGrowth\n\n**Summary**: Experienced PM focused on edtech.\n\n## Experience\n\n### EduTech Solutions — PM (2019-Present)\n- Led product development for assessment platform\n- Improved student engagement metrics\n\n### LearnPlatform — Associate PM (2017-2019)\n- Supported product launches and A/B testing\n\n## Skills\n- Product Strategy\n- EdTech Domain Expertise\n- Data Analysis\n\n\`\`\`\nconsole.log("Ready for edtech innovation");\n\`\`\`\n\n> Passionate about improving education through technology.';

  // ── Deterministic artifact IDs ──
  const resumeV1Id = id('artifact', `resume-v1-${jobA.id}`);
  const resumeV2Id = id('artifact', `resume-v2-${jobA.id}`);
  const coverId = id('artifact', `cover-${jobA.id}`);
  const orphanResumeId = id('artifact', `orphan-${jobA.id}`);
  const staleEvidenceId = id('artifact', `stale-${jobA.id}`);
  const sourceUrlId = id('artifact', `source-${jobA.id}`);
  const emptyEvidenceId = id('artifact', `empty-${jobA.id}`);
  const jobBResumeId = id('artifact', `jobB-resume-${jobB.id}`);

  // ── Common evidence/warnings ──
  const resumeEvidence = JSON.stringify([{ proofPointId: proofA.id }]);
  const resumeWarnings = JSON.stringify(['gen-warn']);

  // ── INSERT artifacts (with main schema columns) ──
  const resumeSeries = artifactSeriesKey('other', jobA.id, profile.id, 'resume.md');
  const coverSeries = artifactSeriesKey('cover', jobA.id, profile.id, 'cover.md');
  const orphanSeries = artifactSeriesKey('resume', jobA.id, profile.id, 'other-resume.md');
  const staleSeries = artifactSeriesKey('other', jobA.id, profile.id, 'stale-evidence.md');
  const sourceSeries = artifactSeriesKey('other', jobA.id, profile.id, 'source-url.md');
  const emptySeries = artifactSeriesKey('other', jobA.id, profile.id, 'empty-evidence.md');
  const jobBResumeSeries = artifactSeriesKey('resume', jobB.id, profile.id, 'jobB-resume.md');

  const cols = 'id,job_id,profile_id,type,path,title,content,evidence_json,warnings_json,approval_status,created_at,series_key,revision,supersedes_artifact_id,content_hash,reviewed_at,reviewed_by,review_note';
  const vals = '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';

  // resume v1 (earlier)
  run(store,
    `INSERT INTO artifacts (${cols}) VALUES ${vals}`,
    [resumeV1Id, jobA.id, profile.id, 'other', 'resume.md', 'Resume v1', resumeBaseContent, resumeEvidence, resumeWarnings, 'draft_needs_human_review', T1, resumeSeries, 1, null, artifactHash(resumeBaseContent), null, null, '']
  );

  // resume v2 (same path, later) — adds ADDED_LINE_V2
  run(store,
    `INSERT INTO artifacts (${cols}) VALUES ${vals}`,
    [resumeV2Id, jobA.id, profile.id, 'other', 'resume.md', 'Resume v2', resumeBaseContent + resumeV2Addition, resumeEvidence, resumeWarnings, 'draft_needs_human_review', T2, resumeSeries, 2, resumeV1Id, artifactHash(resumeBaseContent + resumeV2Addition), null, null, '']
  );

  // cover letter (different path, same type)
  run(store,
    `INSERT INTO artifacts (${cols}) VALUES ${vals}`,
    [coverId, jobA.id, profile.id, 'cover', 'cover.md', 'Cover Letter', coverContent, JSON.stringify([]), JSON.stringify([]), 'draft_needs_human_review', T2, coverSeries, 1, null, artifactHash(coverContent), null, null, '']
  );

  // orphan resume — same type 'resume' but different path 'other-resume.md'
  run(store,
    `INSERT INTO artifacts (${cols}) VALUES ${vals}`,
    [orphanResumeId, jobA.id, profile.id, 'resume', 'other-resume.md', 'Other Resume', orphanResumeContent, JSON.stringify([]), JSON.stringify([]), 'draft_needs_human_review', T1, orphanSeries, 1, null, artifactHash(orphanResumeContent), null, null, '']
  );

  // stale evidence artifact
  run(store,
    `INSERT INTO artifacts (${cols}) VALUES ${vals}`,
    [staleEvidenceId, jobA.id, profile.id, 'other', 'stale-evidence.md', 'Stale Evidence', staleEvidenceContent, JSON.stringify([{ proofPointId: 'proof_missing_zzz' }]), JSON.stringify([]), 'draft_needs_human_review', T1, staleSeries, 1, null, artifactHash(staleEvidenceContent), null, null, '']
  );

  // source URL evidence artifact
  run(store,
    `INSERT INTO artifacts (${cols}) VALUES ${vals}`,
    [sourceUrlId, jobA.id, profile.id, 'other', 'source-url.md', 'Source URL Evidence', sourceUrlContent, JSON.stringify([{ url: 'https://example.test/src', label: 'source' }]), JSON.stringify([]), 'draft_needs_human_review', T1, sourceSeries, 1, null, artifactHash(sourceUrlContent), null, null, '']
  );

  // empty evidence artifact
  run(store,
    `INSERT INTO artifacts (${cols}) VALUES ${vals}`,
    [emptyEvidenceId, jobA.id, profile.id, 'other', 'empty-evidence.md', 'Empty Evidence', emptyEvidenceContent, JSON.stringify([]), JSON.stringify([]), 'draft_needs_human_review', T1, emptySeries, 1, null, artifactHash(emptyEvidenceContent), null, null, '']
  );

  // jobB resume (for multi-artifact navigation on a different job)
  run(store,
    `INSERT INTO artifacts (${cols}) VALUES ${vals}`,
    [jobBResumeId, jobB.id, profile.id, 'resume', 'jobB-resume.md', 'Job B Resume', jobBResumeContent, JSON.stringify([]), JSON.stringify([]), 'draft_needs_human_review', T2, jobBResumeSeries, 1, null, artifactHash(jobBResumeContent), null, null, '']
  );

  // ── Write workspace files for editor path resolution ──
  const wsFile = name => path.join(store.p.ws, name);

  writeFileSync(wsFile('resume.md'), resumeBaseContent + resumeV2Addition, 'utf8');
  writeFileSync(wsFile('cover.md'), coverContent, 'utf8');
  writeFileSync(wsFile('other-resume.md'), orphanResumeContent, 'utf8');
  writeFileSync(wsFile('stale-evidence.md'), staleEvidenceContent, 'utf8');
  writeFileSync(wsFile('source-url.md'), sourceUrlContent, 'utf8');
  writeFileSync(wsFile('empty-evidence.md'), emptyEvidenceContent, 'utf8');
  writeFileSync(wsFile('jobB-resume.md'), jobBResumeContent, 'utf8');

  save(store);

  return {
    root,
    store,
    profile,
    proofs: [proofA, proofB],
    jobs: { jobA, jobB, jobC },
    artifacts: {
      resumeV1: { id: resumeV1Id, path: 'resume.md', type: 'other', title: 'Resume v1', created_at: T1 },
      resumeV2: { id: resumeV2Id, path: 'resume.md', type: 'other', title: 'Resume v2', created_at: T2 },
      cover: { id: coverId, path: 'cover.md', type: 'cover', title: 'Cover Letter', created_at: T2 },
      orphanResume: { id: orphanResumeId, path: 'other-resume.md', type: 'resume', title: 'Other Resume', created_at: T1 },
      staleEvidence: { id: staleEvidenceId, path: 'stale-evidence.md', type: 'other', title: 'Stale Evidence', created_at: T1 },
      sourceUrl: { id: sourceUrlId, path: 'source-url.md', type: 'other', title: 'Source URL Evidence', created_at: T1 },
      emptyEvidence: { id: emptyEvidenceId, path: 'empty-evidence.md', type: 'other', title: 'Empty Evidence', created_at: T1 },
      jobBResume: { id: jobBResumeId, path: 'jobB-resume.md', type: 'resume', title: 'Job B Resume', created_at: T2 }
    },
    application,
    get workspaceFiles() {
      return {
        resumeMd: wsFile('resume.md'),
        coverMd: wsFile('cover.md')
      };
    }
  };
}

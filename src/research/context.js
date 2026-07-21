import { all, one } from '../db.js';
import { parseJson } from '../utils.js';

export function normalizeOrganization(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\b(incorporated|inc|llc|ltd|limited|gmbh|ag|corp|corporation|co|company|plc|pbc)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function affiliationRow(row) {
  return {
    id: row.id,
    type: row.type,
    organization: row.organization,
    normalizedOrganization: row.normalized_organization,
    roleOrProgram: row.role_or_program || '',
    startDate: row.start_date || null,
    endDate: row.end_date || null,
    source: row.source,
    sourceObservationIds: parseJson(row.source_observation_ids_json, []),
    confidence: row.confidence,
    status: row.status
  };
}

export function buildResearchContext(s, runRecord) {
  const run = runRecord?.profile_id ? runRecord : one(s, 'SELECT * FROM research_runs WHERE id=?', [runRecord?.id || runRecord]);
  if (!run) throw Object.assign(new Error(`Unknown research run: ${runRecord?.id || runRecord}`), { code: 'unknown_research_run', type: 'research' });
  const profile = one(s, 'SELECT id,preferences_json FROM profiles WHERE id=?', [run.profile_id]);
  if (!profile) throw Object.assign(new Error(`Unknown profile: ${run.profile_id}`), { code: 'unknown_profile', type: 'research' });
  const job = run.job_id ? one(s, 'SELECT * FROM jobs WHERE id=?', [run.job_id]) : null;
  const person = run.person_id ? one(s, 'SELECT * FROM people WHERE id=?', [run.person_id]) : null;
  const companyId = job?.company_id || null;
  const companyName = run.company_name || job?.company || '';
  const role = run.role || job?.title || '';
  const preferences = parseJson(profile.preferences_json, {});
  const confirmedAffiliations = all(s, "SELECT * FROM profile_affiliations WHERE profile_id=? AND status='confirmed' ORDER BY type,normalized_organization", [profile.id]).map(affiliationRow);
  return {
    runId: run.id,
    scope: run.scope,
    profileId: profile.id,
    jobId: job?.id || null,
    companyId,
    companyName,
    role,
    personId: person?.id || null,
    person: person ? { id: person.id, name: person.name, profileUrl: person.primary_profile_url || '' } : null,
    confirmedAffiliations,
    networkIntent: preferences.networkIntent || null
  };
}

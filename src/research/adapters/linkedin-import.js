import { canonicalUrl, isHttpUrl } from '../sources.js';
import { id, now, hash } from '../../utils.js';
import { TIER_RANK } from '../contacts.js';

export const name = 'linkedin-import';

export async function run({ context, plan, budget, signal, env, fetchImpl }) {
  const observations = [];
  const personHints = [];
  const warnings = [];

  // Pre-loaded LinkedIn import data from the graph (loaded into plan before calling)
  const connections = plan?.linkedinImport?.connections || [];

  for (const conn of connections) {
    if (signal?.aborted) break;

    const name = conn.name || '';
    const url = conn.url || '';
    const email = conn.email || '';
    const company = conn.company || '';
    const position = conn.position || '';

    // Create an observation for the import record
    const obsId = id('src', `${context.runId}:linkedin_import:${conn.id || url || email || name}`);
    const obs = {
      id: obsId,
      companyId: context.companyId,
      jobId: context.jobId,
      url: url || '',
      canonicalUrl: url ? canonicalUrl(url) : '',
      title: `Imported LinkedIn connection: ${name}`,
      snippet: `${name}${company ? ` at ${company}` : ''}${position ? ` as ${position}` : ''}`,
      sourceType: 'linkedin_import_connection',
      provider: 'linkedin_import',
      query: '',
      trust: 'user_imported',
      fetchedAt: now(),
      contentHash: hash(`linkedin_import:${conn.id || url || email || name}`),
      metadata: {
        importedPersonId: conn.personId || '',
        originalName: name,
        company: company || '',
        position: position || '',
        connectedOn: conn.connectedOn || ''
      }
    };
    observations.push(obs);

    // Person hint for identity resolution
    const hint = { name, sourceObservationId: obsId, confidence: 'medium', source: 'linkedin_import' };
    if (url) hint.profileUrl = url;
    if (email) hint.email = email;
    if (company) hint.company = company;
    if (position) hint.role = position;
    personHints.push(hint);
  }

  return {
    observations,
    personHints,
    usage: { queries: 0, sourceChars: 0 },
    warnings
  };
}

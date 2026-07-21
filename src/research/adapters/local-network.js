import { canonicalUrl, isHttpUrl, isLinkedInProfileUrl } from '../sources.js';
import { id, now, hash } from '../../utils.js';
import { TIER_RANK } from '../contacts.js';

export const name = 'local-network';

function estimateChars(observations) {
  return observations.reduce((sum, o) => sum + (o.snippet || '').length + (o.title || '').length, 0);
}

export async function run({ context, plan, budget, signal, env, fetchImpl }) {
  const observations = [];
  const personHints = [];
  const warnings = [];
  const maxChars = budget.maxSourceChars ?? 250000;
  let sourceChars = 0;

  // Derive network observations from confirmed affiliations in the run context
  if (context.confirmedAffiliations?.length) {
    for (const aff of context.confirmedAffiliations) {
      if (signal?.aborted) break;
      if (sourceChars >= maxChars) {
        warnings.push('local-network: maxSourceChars reached');
        break;
      }
      const obs = {
        id: id('src', `${context.runId}:local_network:affiliation:${aff.id}`),
        companyId: context.companyId,
        jobId: context.jobId,
        url: '',
        canonicalUrl: '',
        title: `Confirmed ${aff.type}: ${aff.organization}`,
        snippet: `${aff.type}${aff.roleOrProgram ? ` as ${aff.roleOrProgram}` : ''}${aff.startDate ? ` (${aff.startDate}${aff.endDate ? `-${aff.endDate}` : ''})` : ''}`,
        sourceType: 'local_network_affiliation',
        provider: 'local_network',
        query: '',
        trust: 'user_confirmed',
        fetchedAt: now(),
        contentHash: hash(`affiliation:${aff.id}:${aff.status}`),
        metadata: { affiliationId: aff.id, type: aff.type, organization: aff.organization, normalizedOrganization: aff.normalizedOrganization, roleOrProgram: aff.roleOrProgram, confidence: aff.confidence, status: aff.status }
      };
      observations.push(obs);
      sourceChars += estimateChars([obs]);
    }
  }

  // Process pre-loaded network data from the graph (loaded into plan before calling)
  const network = plan?.localNetwork;
  if (network) {
    // Direct connection edges (profile → person)
    for (const edge of (network.edges || [])) {
      if (signal?.aborted) break;
      if (edge.edgeType !== 'direct_connection' && edge.edgeType !== 'shared_employer' && edge.edgeType !== 'shared_school') continue;
      const isDirect = edge.edgeType === 'direct_connection';
      const label = isDirect
        ? `Direct connection to ${edge.personName || edge.toId}`
        : `Shared ${edge.edgeType.replace('shared_', '')} with ${edge.personName || edge.toId}`;
      const obs = {
        id: id('src', `${context.runId}:local_network:edge:${edge.id}`),
        companyId: context.companyId,
        jobId: context.jobId,
        url: edge.personUrl || '',
        canonicalUrl: edge.personUrl ? canonicalUrl(edge.personUrl) : '',
        title: label,
        snippet: `Relationship edge (${edge.edgeType}, confidence: ${edge.confidence || 'medium'})`,
        sourceType: 'local_network_edge',
        provider: 'local_network',
        query: '',
        trust: 'user_imported',
        fetchedAt: now(),
        contentHash: hash(`edge:${edge.id}`),
        metadata: { edgeId: edge.id, edgeType: edge.edgeType, personName: edge.personName || '', personId: edge.personId || edge.toId, confidence: edge.confidence || 'medium' }
      };
      observations.push(obs);
      personHints.push({
        name: edge.personName || '',
        profileUrl: edge.personUrl || '',
        sourceObservationId: obs.id,
        confidence: edge.confidence || 'medium',
        source: 'local_network_edge',
        edgeType: edge.edgeType
      });
    }

    // Known contacts (from contact_points)
    for (const contact of (network.contacts || [])) {
      if (signal?.aborted) break;
      if (contact.doNotUse) continue;
      if (!contact.personId && !contact.stakeholderId) continue;
      if (!contact.personName && !contact.value) continue;
      const obs = {
        id: id('src', `${context.runId}:local_network:contact:${contact.id}`),
        companyId: context.companyId,
        jobId: context.jobId,
        url: contact.type === 'profile_url' ? contact.value : '',
        canonicalUrl: contact.type === 'profile_url' ? canonicalUrl(contact.value) : '',
        title: `${contact.personName || contact.value} (${contact.type}, tier ${contact.evidenceTier})`,
        snippet: `Local contact: ${contact.value}`,
        sourceType: 'local_network_contact',
        provider: 'local_network',
        query: '',
        trust: contact.humanApproved ? 'user_confirmed' : 'user_imported',
        fetchedAt: now(),
        contentHash: hash(`contact:${contact.id}`),
        metadata: { contactId: contact.id, personId: contact.personId || '', type: contact.type, evidenceTier: contact.evidenceTier, verificationStatus: contact.verificationStatus, humanApproved: contact.humanApproved }
      };
      observations.push(obs);
      if (contact.personName) {
        personHints.push({
          name: contact.personName,
          profileUrl: contact.type === 'profile_url' ? contact.value : '',
          email: contact.type === 'email' ? contact.value : '',
          sourceObservationId: obs.id,
          confidence: contact.confidence || 'medium',
          source: 'local_network_contact'
        });
      }
    }
  }

  return {
    observations,
    personHints,
    usage: { queries: 0, sourceChars },
    warnings
  };
}

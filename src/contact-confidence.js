import { all, one } from './db.js';
import { parseJson } from './utils.js';
import { emailDomain, extractEmails, hostForUrl, isGenericInbox, normalizeEmail } from './research/sources.js';

export const CONTACT_CONFIDENCE_SCHEMA = 'jobos.contact-confidence.v1';
export const CONTACT_CONFIDENCE_MODEL = 'ContactConfidenceV2';
export const CONTACT_FRESHNESS_POLICY = Object.freeze({ freshMaxDays: 30, agingMaxDays: 90 });

function domainValue(value) {
  return String(value || '').trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
}

function hostMatchesDomain(host, domain) {
  const normalizedHost = domainValue(host);
  const normalizedDomain = domainValue(domain);
  return Boolean(normalizedHost && normalizedDomain && (normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`)));
}

function namesForPattern(name) {
  const parts = String(name || '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts[0].replace(/[^a-z]/g, ''), last: parts.at(-1).replace(/[^a-z]/g, '') };
}

function patternForNameEmail(name, email) {
  const parts = namesForPattern(name);
  const local = normalizeEmail(email).split('@')[0] || '';
  if (!parts || !local) return '';
  const { first, last } = parts;
  return [
    ['first', first],
    ['first.last', `${first}.${last}`],
    ['flast', `${first.charAt(0)}${last}`],
    ['firstl', `${first}${last.charAt(0)}`],
    ['first_last', `${first}_${last}`],
    ['firstlast', `${first}${last}`],
  ].find(([, value]) => value === local)?.[0] || '';
}

function observationEmailContexts(observation) {
  const metadata = observation.metadata || {};
  const contexts = [];
  for (const row of Array.isArray(metadata.emailContexts) ? metadata.emailContexts : []) {
    const email = normalizeEmail(row?.email);
    if (email) contexts.push({ email, name: String(row?.name || '').trim() });
  }
  const known = new Set(contexts.map(row => row.email));
  const extras = [
    ...(Array.isArray(metadata.emails) ? metadata.emails : []),
    ...extractEmails(observation.snippet || ''),
    ...extractEmails(metadata.rawText || ''),
  ];
  for (const raw of extras) {
    const email = normalizeEmail(raw);
    if (email && !known.has(email)) {
      known.add(email);
      contexts.push({ email, name: '' });
    }
  }
  return contexts;
}

function crediblePublicObservation(observation) {
  return ['page_fetch', 'web_search', 'profile_search', 'x_search'].includes(observation.sourceType)
    && /public|source|company|search/i.test(observation.trust || '');
}

function nonStale(freshness) {
  return freshness.state === 'fresh' || freshness.state === 'aging';
}

function expectedCompanyDomains(s, companyId) {
  if (!companyId) return [];
  const company = one(s, 'SELECT domain,website FROM companies WHERE id=?', [companyId]);
  if (!company) return [];
  const domains = new Set();
  const direct = domainValue(company.domain);
  if (direct && direct.includes('.')) domains.add(direct);
  const websiteHost = hostForUrl(company.website);
  if (websiteHost) domains.add(websiteHost);
  return [...domains].sort();
}

function contactObservations(s, ids) {
  const sourceIds = [...new Set((ids || []).filter(Boolean))].sort();
  if (!sourceIds.length) return [];
  const placeholders = sourceIds.map(() => '?').join(',');
  return all(s, `SELECT * FROM source_observations WHERE id IN (${placeholders})`, sourceIds)
    .map(row => ({
      id: row.id,
      companyId: row.company_id || null,
      sourceType: row.source_type,
      sourceUrl: row.url,
      trust: row.trust,
      fetchedAt: row.fetched_at || null,
      snippet: row.snippet || '',
      metadata: parseJson(row.metadata_json, {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function observationSignal(observations, expectedDomains, observedEmailDomain, companyId, contactValue) {
  const normalizedContact = normalizeEmail(contactValue);
  const projected = observations.map(observation => {
    const host = hostForUrl(observation.sourceUrl);
    const companyControlled = observation.companyId === companyId
      && expectedDomains.some(domain => hostMatchesDomain(host, domain));
    const domainAligned = expectedDomains.some(domain => hostMatchesDomain(observedEmailDomain, domain));
    const crediblePublic = crediblePublicObservation(observation);
    const ownership = companyControlled
      ? 'company_controlled_same_domain'
      : domainAligned && observation.companyId === companyId && crediblePublic
        ? 'credible_third_party'
        : 'unrelated_domain';
    const containsContactValue = Boolean(normalizedContact)
      && observationEmailContexts(observation).some(row => row.email === normalizedContact);
    return { ...observation, ownership, containsContactValue };
  });
  return {
    state: projected.length ? 'observed' : 'unknown',
    sourceIds: projected.map(observation => observation.id),
    observations: projected,
  };
}

function companyAssociationSignal(s, contact) {
  const contactSources = new Set(contact.sourceObservationIds || []);
  if (contact.stakeholderId) {
    const stakeholder = one(s, 'SELECT company_id,links_json FROM stakeholders WHERE id=?', [contact.stakeholderId]);
    if (stakeholder?.company_id === contact.companyId) {
      const links = parseJson(stakeholder.links_json, []);
      if (links.length) {
        const linkPlaceholders = links.map(() => '?').join(',');
        const independentIds = all(s, `SELECT id FROM source_observations WHERE company_id=? AND url IN (${linkPlaceholders})`, [contact.companyId, ...links])
          .map(row => row.id)
          .filter(id => !contactSources.has(id));
        if (independentIds.length) {
          return { state: 'supported', evidence: [{ type: 'stakeholder_source', id: contact.stakeholderId }] };
        }
      }
    }
  }
  if (contact.personId && contact.companyId) {
    const candidates = all(s, 'SELECT source_observation_ids_json FROM person_candidates WHERE person_id=? AND company_id=?', [contact.personId, contact.companyId]);
    const candidateIds = [...new Set(candidates.flatMap(candidate => parseJson(candidate.source_observation_ids_json, [])))]
      .filter(sourceId => sourceId && !contactSources.has(sourceId));
    if (candidateIds.length) {
      const placeholders = candidateIds.map(() => '?').join(',');
      const realIds = all(s, `SELECT id FROM source_observations WHERE company_id=? AND id IN (${placeholders})`, [contact.companyId, ...candidateIds])
        .map(row => row.id)
        .sort();
      if (realIds.length) {
        return { state: 'supported', evidence: realIds.map(id => ({ type: 'source_observation', id })) };
      }
    }
  }
  return { state: 'unknown', evidence: [] };
}

function freshnessSignal(observations, nowDate) {
  const dates = observations
    .map(observation => ({ id: observation.id, value: Date.parse(observation.fetchedAt || '') }))
    .filter(row => Number.isFinite(row.value))
    .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  if (!dates.length) {
    return { state: 'unknown', sourceTimestamp: null, sourceObservationId: null, ageDays: null, policy: CONTACT_FRESHNESS_POLICY };
  }
  const latest = dates[0];
  const current = nowDate instanceof Date ? nowDate.getTime() : Date.parse(nowDate);
  const ageDays = Math.max(0, Math.floor((current - latest.value) / 86_400_000));
  const state = ageDays <= CONTACT_FRESHNESS_POLICY.freshMaxDays
    ? 'fresh'
    : ageDays <= CONTACT_FRESHNESS_POLICY.agingMaxDays ? 'aging' : 'stale';
  return {
    state,
    sourceTimestamp: new Date(latest.value).toISOString(),
    sourceObservationId: latest.id,
    ageDays,
    policy: CONTACT_FRESHNESS_POLICY,
  };
}

function patternSignal(s, contact, observedDomain, nowDate) {
  const checks = contact.checks || {};
  const patternName = String(checks.pattern || '');
  if (!checks.generated && !patternName) {
    return {
      patternName: null,
      distinctExamples: 0,
      distinctSourceObservations: 0,
      sourceObservationIds: [],
      supportState: 'unknown',
      supportReason: 'No generated pattern is attached to this contact.',
      freshness: freshnessSignal([], nowDate),
    };
  }
  const pattern = contact.companyId && patternName
    ? one(s, 'SELECT * FROM email_patterns WHERE company_id=? AND domain=? AND pattern=?', [contact.companyId, observedDomain, patternName])
    : null;
  const candidateSourceIds = [...new Set(parseJson(pattern?.support_sources_json, []))].filter(Boolean).sort();
  const observations = contactObservations(s, candidateSourceIds);
  const structurallyQualifying = [];
  const examplesByObservation = new Map();
  for (const observation of observations) {
    if (observation.companyId !== contact.companyId || !crediblePublicObservation(observation)) continue;
    const examples = observationEmailContexts(observation)
      .filter(row => row.name && !isGenericInbox(row.email))
      .filter(row => emailDomain(row.email) === observedDomain)
      .filter(row => patternForNameEmail(row.name, row.email) === patternName)
      .map(row => row.email);
    if (!examples.length) continue;
    structurallyQualifying.push(observation);
    examplesByObservation.set(observation.id, [...new Set(examples)]);
  }
  const qualifying = structurallyQualifying.filter(observation => nonStale(freshnessSignal([observation], nowDate)));
  const examples = new Set(qualifying.flatMap(observation => examplesByObservation.get(observation.id) || []));
  const sourceObservationIds = qualifying.map(observation => observation.id).sort();
  const distinctExamples = examples.size;
  const distinctSources = sourceObservationIds.length;
  const supportState = distinctExamples >= 2 && distinctSources >= 2
    ? 'supported'
    : structurallyQualifying.length ? 'weak' : 'unknown';
  const supportReason = supportState === 'supported'
    ? 'At least two distinct non-stale exact public examples on real target-company observations support this pattern.'
    : structurallyQualifying.length
      ? 'Pattern evidence is stale, duplicated, or does not provide two distinct qualifying examples and observations.'
      : 'Stored support IDs do not resolve to qualifying exact public examples for this company, domain, and pattern.';
  return {
    patternName: patternName || null,
    distinctExamples,
    distinctSourceObservations: distinctSources,
    sourceObservationIds,
    supportState,
    supportReason,
    freshness: freshnessSignal(structurallyQualifying, nowDate),
  };
}

function dnsSignal(contact, observedDomain) {
  const dns = contact.checks?.dns;
  const checks = dns?.checks || {};
  const known = Boolean(dns || Object.keys(checks).length);
  const state = value => !known ? 'unknown' : value ? 'present' : 'absent';
  const syntax = !observedDomain ? 'invalid' : !known ? 'unknown' : checks.syntax === false ? 'invalid' : 'valid';
  return {
    domain: observedDomain || null,
    syntax,
    mx: state(checks.mxPresent),
    ns: state(checks.nsPresent),
    spf: state(checks.spfPresent),
    dmarc: state(checks.dmarcPresent),
    status: dns?.status || 'unknown',
    note: 'DNS records describe the domain only; they are not mailbox or identity proof.',
  };
}

function smtpSignal(contact) {
  const raw = contact.checks?.smtp || {};
  const state = ({
    smtp_not_enabled: 'not_enabled',
    smtp_accepts_rcpt: 'accepted',
    smtp_rejects_rcpt: 'rejected',
    smtp_inconclusive: 'inconclusive',
    smtp_rate_limited: 'rate_limited',
  })[raw.status] || 'not_enabled';
  return {
    state,
    fixture: Boolean(raw.fixture),
    note: 'SMTP response is mailbox transport evidence only; acceptance is not identity proof.',
  };
}

function catchAllSignal(contact) {
  const raw = contact.checks?.catchAll || {};
  const state = ['detected', 'not_detected'].includes(raw.status) ? raw.status : 'unknown';
  return {
    state,
    method: raw.method || null,
    evidence: raw.evidence || null,
    fixture: Boolean(raw.fixture),
  };
}

function derivedTier({ contact, domain, publicObservation, association, pattern, catchAll, nowDate }) {
  const rawTier = contact.rawEvidenceTier || contact.evidenceTier || 'D';
  const routeFreshness = freshnessSignal(
    publicObservation.observations.filter(observation => crediblePublicObservation(observation)),
    nowDate,
  );
  if (contact.type === 'profile_url') {
    return {
      evidenceTier: 'E',
      tierReason: 'Manual public profile route; no email identity claim is made.',
      freshness: routeFreshness,
    };
  }
  if (rawTier === 'U' || /user_import/i.test(contact.verificationStatus || '')) {
    return {
      evidenceTier: 'U',
      tierReason: 'User-imported local contact remains explicitly unverified without independent corroboration.',
      freshness: freshnessSignal([], nowDate),
    };
  }
  if (!['email', 'generic_inbox'].includes(contact.type)) {
    return {
      evidenceTier: 'D',
      tierReason: 'Unsupported or weak contact path has no qualifying identity evidence.',
      freshness: routeFreshness,
    };
  }
  if (domain.matchState !== 'match') {
    return {
      evidenceTier: 'D',
      tierReason: domain.matchState === 'mismatch'
        ? 'Observed contact domain does not match a company-controlled domain; unrelated-domain evidence cannot qualify for A, B, or C.'
        : 'Company-domain alignment is unknown; the contact cannot qualify for A, B, or C.',
      freshness: routeFreshness,
    };
  }

  const exactPublic = contact.checks?.exactPublic || /exact_public/i.test(contact.verificationStatus || '');
  const observations = publicObservation.observations;
  const companyObservations = observations.filter(observation => observation.containsContactValue
    && observation.ownership === 'company_controlled_same_domain'
    && observation.sourceType === 'page_fetch');
  const thirdPartyObservations = observations.filter(observation => observation.containsContactValue
    && observation.ownership === 'credible_third_party');
  const companyFreshness = freshnessSignal(companyObservations, nowDate);
  const thirdPartyFreshness = freshnessSignal(thirdPartyObservations, nowDate);

  if (exactPublic && companyObservations.length && nonStale(companyFreshness) && contact.type !== 'generic_inbox') {
    return {
      evidenceTier: 'A',
      tierReason: 'Exact public contact observed on a company-controlled same-domain page with non-stale evidence.',
      freshness: companyFreshness,
    };
  }
  if (contact.type === 'generic_inbox') {
    return {
      evidenceTier: 'D',
      tierReason: 'Exact public generic inbox does not qualify as a named or role inbox for tier A; it remains a human-review-only contact path.',
      freshness: companyObservations.length ? companyFreshness : (thirdPartyObservations.length ? thirdPartyFreshness : freshnessSignal([], nowDate)),
    };
  }
  if (exactPublic && thirdPartyObservations.length && association.state === 'supported' && nonStale(thirdPartyFreshness)) {
    return {
      evidenceTier: 'B',
      tierReason: 'Exact public third-party contact has independent person-company association and company-domain alignment.',
      freshness: thirdPartyFreshness,
    };
  }
  if (contact.checks?.generated || pattern.patternName) {
    if (catchAll.state === 'detected') {
      return {
        evidenceTier: 'D',
        tierReason: 'Generated address is on a catch-all domain and remains a low-confidence human-review-only hypothesis.',
        freshness: pattern.freshness,
      };
    }
    if (pattern.supportState === 'supported' && nonStale(pattern.freshness)) {
      return {
        evidenceTier: 'C',
        tierReason: 'Generated candidate uses a company-domain pattern supported by at least two distinct non-stale exact examples and real source observations.',
        freshness: pattern.freshness,
      };
    }
    return {
      evidenceTier: 'D',
      tierReason: 'Generated candidate has weak, stale, or unproven pattern support; DNS or SMTP evidence cannot elevate identity confidence.',
      freshness: pattern.freshness,
    };
  }

  const attemptedFreshness = companyObservations.length
    ? companyFreshness
    : thirdPartyObservations.length && association.state === 'supported'
      ? thirdPartyFreshness
      : freshnessSignal([], nowDate);
  if (attemptedFreshness.state === 'stale') {
    return {
      evidenceTier: 'D',
      tierReason: 'Qualifying source evidence is stale and is downgraded pending fresh human verification.',
      freshness: attemptedFreshness,
    };
  }
  if (attemptedFreshness.state === 'unknown') {
    return {
      evidenceTier: 'D',
      tierReason: 'No trustworthy qualifying observation timestamp is available; confidence remains weak.',
      freshness: attemptedFreshness,
    };
  }
  return {
    evidenceTier: 'D',
    tierReason: 'Available observations do not independently establish a qualifying contact identity and company association.',
    freshness: attemptedFreshness,
  };
}

export function projectContactConfidenceV2(s, contact, { nowDate = new Date() } = {}) {
  if (!contact) return null;
  const expectedDomains = expectedCompanyDomains(s, contact.companyId);
  const observedEmailDomain = ['email', 'generic_inbox'].includes(contact.type) ? emailDomain(contact.value) : '';
  const matchState = !observedEmailDomain || !expectedDomains.length
    ? 'unknown'
    : expectedDomains.some(domain => hostMatchesDomain(observedEmailDomain, domain)) ? 'match' : 'mismatch';
  const observations = contactObservations(s, contact.sourceObservationIds);
  const publicObservation = observationSignal(observations, expectedDomains, observedEmailDomain, contact.companyId, contact.value);
  const association = companyAssociationSignal(s, contact);
  const pattern = patternSignal(s, contact, observedEmailDomain, nowDate);
  const dns = dnsSignal(contact, observedEmailDomain);
  const smtp = smtpSignal(contact);
  const catchAll = catchAllSignal(contact);
  const domain = { expectedDomains, observedEmailDomain: observedEmailDomain || null, matchState };
  const tier = derivedTier({ contact, domain, publicObservation, association, pattern, catchAll, nowDate });
  const freshness = tier.freshness;
  const generatedRoute = contact.checks?.generated === true || /pattern_candidate/i.test(String(contact.verificationStatus || ''));
  const warnings = [];
  if (matchState === 'mismatch') warnings.push('Contact domain is unrelated to the company-controlled domain.');
  if (matchState === 'unknown' && ['email', 'generic_inbox'].includes(contact.type)) warnings.push('Company-domain alignment is unknown.');
  if (freshness.state === 'aging') warnings.push('Contact evidence is aging and should be rechecked before use.');
  if (freshness.state === 'stale') warnings.push('Contact evidence is stale and is not ready for outreach.');
  if (freshness.state === 'unknown') warnings.push('Contact evidence freshness is unknown.');
  if (catchAll.state === 'detected') warnings.push('Catch-all domain detected; SMTP acceptance cannot verify this mailbox or identity.');
  if (smtp.state === 'accepted') warnings.push('SMTP acceptance is not proof of mailbox ownership, identity, or company association.');
  if (contact.checks?.generated) warnings.push('Generated email remains a pattern hypothesis.');
  if (!contact.humanApproved) warnings.push('Human approval is required before this contact path can be used.');
  if (contact.doNotUse) warnings.push('Contact is suppressed; suppression overrides approval and all confidence signals.');

  let usable = true;
  let usabilityReason = 'Human-approved, non-suppressed contact has qualifying non-stale evidence.';
  if (contact.doNotUse) {
    usable = false;
    usabilityReason = 'Contact is suppressed; suppression always wins.';
  } else if (!contact.humanApproved) {
    usable = false;
    usabilityReason = 'Human approval is required before use.';
  } else if (freshness.state === 'stale' || freshness.state === 'unknown') {
    usable = false;
    usabilityReason = freshness.state === 'stale' ? 'Evidence is stale and requires fresh verification.' : 'Evidence freshness is unknown.';
  } else if (catchAll.state === 'detected' && generatedRoute) {
    usable = false;
    usabilityReason = 'Catch-all detection keeps this generated route human-review-only and not outreach-ready.';
  } else if (tier.evidenceTier === 'D' && !(contact.type === 'generic_inbox' && contact.checks?.exactPublic && domain.matchState === 'match')) {
    usable = false;
    usabilityReason = 'Tier D evidence is a weak hypothesis and is not outreach-ready.';
  }

  return {
    schema: CONTACT_CONFIDENCE_SCHEMA,
    model: CONTACT_CONFIDENCE_MODEL,
    contactId: contact.id,
    personId: contact.personId || null,
    stakeholderId: contact.stakeholderId || null,
    companyId: contact.companyId || null,
    type: contact.type,
    value: contact.value,
    rawEvidenceTier: contact.rawEvidenceTier || contact.evidenceTier || null,
    evidenceTier: tier.evidenceTier,
    tierReason: tier.tierReason,
    signals: {
      publicObservation,
      observationOwnership: { companyId: contact.companyId || null, association },
      companyDomain: domain,
      pattern,
      dns,
      smtp,
      catchAll,
      freshness,
    },
    humanApproved: Boolean(contact.humanApproved),
    doNotUse: Boolean(contact.doNotUse),
    usable,
    usabilityReason,
    warnings: [...new Set(warnings)],
  };
}

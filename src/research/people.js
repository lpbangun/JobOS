import { one, all, run } from '../db.js';
import { id, now, parseJson } from '../utils.js';
import { canonicalUrl, normalizeEmail } from './sources.js';
import { normalizeOrganization } from './context.js';

// ---- Row mappers ----

export function personRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    primaryProfileUrl: row.primary_profile_url || '',
    aliases: parseJson(row.aliases_json, []),
    identityConfidence: row.identity_confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function affiliationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    profileId: row.profile_id || undefined,
    personId: row.person_id || undefined,
    type: row.type,
    organization: row.organization,
    normalizedOrganization: row.normalized_organization,
    roleOrProgram: row.role_or_program || '',
    startDate: row.start_date || null,
    endDate: row.end_date || null,
    source: row.source || 'manual',
    sourceObservationIds: parseJson(row.source_observation_ids_json, []),
    confidence: row.confidence,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ---- People CRUD ----

export function listPeople(s, { query = null, name = null } = {}) {
  if (query) {
    const like = `%${query.toLowerCase()}%`;
    return all(s, `SELECT * FROM people WHERE normalized_name LIKE ? OR primary_profile_url LIKE ? ORDER BY updated_at DESC`, [like, like]).map(personRow);
  }
  if (name) {
    const normalized = name.trim().toLowerCase();
    return all(s, 'SELECT * FROM people WHERE normalized_name=? ORDER BY updated_at DESC', [normalized]).map(personRow);
  }
  return all(s, 'SELECT * FROM people ORDER BY updated_at DESC').map(personRow);
}

export function getPerson(s, id) {
  return personRow(one(s, 'SELECT * FROM people WHERE id=?', [id]));
}

function contactRow(row, revealValues) {
  const contact = {
    id: row.id,
    personId: row.person_id || null,
    stakeholderId: row.stakeholder_id || null,
    companyId: row.company_id || null,
    type: row.type,
    evidenceTier: row.evidence_tier,
    verificationStatus: row.verification_status,
    confidence: row.confidence,
    sourceObservationIds: parseJson(row.source_observation_ids_json, []),
    humanApproved: Boolean(row.human_approved),
    doNotUse: Boolean(row.do_not_use),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (revealValues) {
    contact.value = row.value;
    contact.normalizedValue = row.normalized_value;
  }
  return contact;
}

function edgeRow(row) {
  return {
    id: row.id,
    fromType: row.from_type,
    fromId: row.from_id,
    toType: row.to_type,
    toId: row.to_id,
    edgeType: row.edge_type,
    evidence: parseJson(row.evidence_json, []),
    confidence: row.confidence,
    createdAt: row.created_at,
    lastContactAt: row.last_contact_at || null,
    warmth: row.warmth || 'unknown'
  };
}

function personResult(s, match, revealContacts) {
  const contacts = all(s, 'SELECT * FROM contact_points WHERE person_id=? ORDER BY updated_at DESC,id', [match.id])
    .map(row => contactRow(row, revealContacts));
  const edges = all(s, `SELECT * FROM relationship_edges
    WHERE (from_type='person' AND from_id=?) OR (to_type='person' AND to_id=?)
    ORDER BY created_at DESC,id`, [match.id, match.id]).map(edgeRow);
  const result = { person: personRow(match), edges };
  if (revealContacts) {
    result.contacts = contacts;
  } else {
    result.contactSummary = {
      count: contacts.length,
      types: [...new Set(contacts.map(contact => contact.type))].sort(),
      tiers: contacts.reduce((counts, contact) => {
        counts[contact.evidenceTier] = (counts[contact.evidenceTier] || 0) + 1;
        return counts;
      }, {})
    };
  }
  return result;
}

export function findPersonByEmail(s, email, { revealContacts = false } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new Error('A valid email address is required');
  }
  const match = one(s, `SELECT p.* FROM contact_points cp
    JOIN people p ON p.id=cp.person_id
    WHERE cp.type IN ('email','generic_inbox') AND cp.normalized_value=?
    ORDER BY cp.updated_at DESC,cp.id LIMIT 1`, [normalized]);
  return match ? personResult(s, match, revealContacts) : null;
}

export function showPersonContacts(s, { personId = null, email = null } = {}) {
  if (email) return findPersonByEmail(s, email, { revealContacts: true });
  if (!personId) throw new Error('A person ID or email address is required');
  const match = one(s, 'SELECT * FROM people WHERE id=?', [personId]);
  return match ? personResult(s, match, true) : null;
}

export function upsertPerson(s, { id: pid, name, primaryProfileUrl = '', aliases = [], identityConfidence = 'low' }, at = now()) {
  const normalized = String(name || '').trim().toLowerCase();
  const url = primaryProfileUrl ? canonicalUrl(primaryProfileUrl) || '' : '';

  const existing = one(s, 'SELECT * FROM people WHERE id=?', [pid]);
  if (existing) {
    run(s, 'UPDATE people SET name=?,normalized_name=?,primary_profile_url=?,aliases_json=?,identity_confidence=?,updated_at=? WHERE id=?', [
      name, normalized, url, JSON.stringify(aliases), identityConfidence, at, pid
    ]);
  } else {
    run(s, 'INSERT INTO people (id,name,normalized_name,primary_profile_url,aliases_json,identity_confidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', [
      pid, name, normalized, url, JSON.stringify(aliases), identityConfidence, at, at
    ]);
  }
  return getPerson(s, pid);
}

/**
 * Resolve a person identity by canonical profile URL first,
 * then by exact normalized imported email in contact_points.
 * Falls back to creating a new person from sourceRecordId.
 * NEVER merges on name alone.
 *
 * @param {object} s - store
 * @param {object} opts
 * @param {string} [opts.profileUrl] - LinkedIn or other profile URL
 * @param {string} [opts.email] - email address
 * @param {string} [opts.name] - display name (used for new records)
 * @param {string} [opts.sourceRecordId] - source record ID for deterministic person ID fallback
 * @returns {{ person, created: boolean } | null}
 */
export function resolvePerson(s, { profileUrl, email, name, sourceRecordId } = {}) {
  if (profileUrl) {
    const url = canonicalUrl(profileUrl);
    if (url) {
      const existing = one(s, "SELECT * FROM people WHERE primary_profile_url=? AND primary_profile_url!=''", [url]);
      if (existing) return { person: personRow(existing), created: false };
    }
  }

  if (email) {
    const normalized = normalizeEmail(email);
    if (normalized) {
      const contact = one(s, "SELECT person_id FROM contact_points WHERE type IN ('email','generic_inbox') AND normalized_value=? AND person_id IS NOT NULL AND person_id!=''", [normalized]);
      if (contact) {
        const existing = getPerson(s, contact.person_id);
        if (existing) {
          if (profileUrl && !existing.primaryProfileUrl) {
            const updated = upsertPerson(s, {
              id: existing.id,
              name: existing.name || name || '',
              primaryProfileUrl: profileUrl,
              aliases: existing.aliases,
              identityConfidence: existing.identityConfidence
            });
            return { person: updated, created: false };
          }
          return { person: existing, created: false };
        }
      }
    }
  }

  if (sourceRecordId) {
    const personId = id('person', sourceRecordId);
    const existing = getPerson(s, personId);
    if (existing) return { person: existing, created: false };
    const at = now();
    return {
      person: upsertPerson(s, {
        id: personId,
        name: name || '',
        primaryProfileUrl: profileUrl || '',
        aliases: [],
        identityConfidence: 'low'
      }, at),
      created: true
    };
  }

  return null;
}

// ---- Affiliation helpers ----

export function listProfileAffiliations(s, profileId, { type = null, status = null } = {}) {
  let sql = 'SELECT * FROM profile_affiliations WHERE profile_id=?';
  const params = [profileId];
  if (type) { sql += ' AND type=?'; params.push(type); }
  if (status) { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY type, normalized_organization';
  return all(s, sql, params).map(affiliationRow);
}

export function listPersonAffiliations(s, personId, { type = null, status = null } = {}) {
  let sql = 'SELECT * FROM person_affiliations WHERE person_id=?';
  const params = [personId];
  if (type) { sql += ' AND type=?'; params.push(type); }
  if (status) { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY type, normalized_organization';
  return all(s, sql, params).map(affiliationRow);
}

function normalizeAffiliationType(type) {
  const v = String(type || '').toLowerCase();
  if (!['school', 'employer', 'community'].includes(v)) throw new Error(`Invalid affiliation type: "${type}". Must be school, employer, or community.`);
  return v;
}

export function upsertProfileAffiliations(s, profileId, affiliations, at = now()) {
  const results = [];
  for (const aff of (affiliations || [])) {
    const affType = normalizeAffiliationType(aff.type);
    const org = String(aff.organization || '').trim();
    if (!org) continue;
    const normalizedOrg = normalizeOrganization(org);
    const roleProg = String(aff.roleOrProgram || '').trim();
    const affId = id('profile_aff', `${profileId}:${affType}:${normalizedOrg}:${roleProg}`);

    const existing = one(s, 'SELECT * FROM profile_affiliations WHERE id=?', [affId]);
    if (existing) {
      run(s, `UPDATE profile_affiliations SET type=?,organization=?,normalized_organization=?,role_or_program=?,start_date=?,end_date=?,source=?,source_observation_ids_json=?,confidence=?,status=?,updated_at=? WHERE id=?`, [
        affType, org, normalizedOrg, roleProg,
        aff.startDate || null, aff.endDate || null,
        aff.source || 'manual',
        JSON.stringify(aff.sourceObservationIds || []),
        aff.confidence || 'medium',
        aff.status || 'suggested',
        at, affId
      ]);
    } else {
      run(s, 'INSERT INTO profile_affiliations (id,profile_id,type,organization,normalized_organization,role_or_program,start_date,end_date,source,source_observation_ids_json,confidence,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
        affId, profileId, affType, org, normalizedOrg, roleProg,
        aff.startDate || null, aff.endDate || null,
        aff.source || 'manual',
        JSON.stringify(aff.sourceObservationIds || []),
        aff.confidence || 'medium',
        aff.status || 'suggested',
        at, at
      ]);
    }
    results.push(affiliationRow(one(s, 'SELECT * FROM profile_affiliations WHERE id=?', [affId])));
  }
  return results;
}

export function upsertPersonAffiliations(s, personId, affiliations, at = now()) {
  const results = [];
  for (const aff of (affiliations || [])) {
    const affType = normalizeAffiliationType(aff.type);
    const org = String(aff.organization || '').trim();
    if (!org) continue;
    const normalizedOrg = normalizeOrganization(org);
    const roleProg = String(aff.roleOrProgram || '').trim();
    const affId = id('person_aff', `${personId}:${affType}:${normalizedOrg}:${roleProg}`);

    const existing = one(s, 'SELECT * FROM person_affiliations WHERE id=?', [affId]);
    if (existing) {
      run(s, `UPDATE person_affiliations SET type=?,organization=?,normalized_organization=?,role_or_program=?,start_date=?,end_date=?,source=?,source_observation_ids_json=?,confidence=?,status=?,updated_at=? WHERE id=?`, [
        affType, org, normalizedOrg, roleProg,
        aff.startDate || null, aff.endDate || null,
        aff.source || 'manual',
        JSON.stringify(aff.sourceObservationIds || []),
        aff.confidence || 'medium',
        aff.status || 'suggested',
        at, affId
      ]);
    } else {
      run(s, 'INSERT INTO person_affiliations (id,person_id,type,organization,normalized_organization,role_or_program,start_date,end_date,source,source_observation_ids_json,confidence,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
        affId, personId, affType, org, normalizedOrg, roleProg,
        aff.startDate || null, aff.endDate || null,
        aff.source || 'manual',
        JSON.stringify(aff.sourceObservationIds || []),
        aff.confidence || 'medium',
        aff.status || 'suggested',
        at, at
      ]);
    }
    results.push(affiliationRow(one(s, 'SELECT * FROM person_affiliations WHERE id=?', [affId])));
  }
  return results;
}

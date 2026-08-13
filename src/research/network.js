import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, one, run, audit, save } from '../db.js';
import { id, now, parseJson } from '../utils.js';
import { writeMd, writeYaml } from '../workspace.js';
import { canonicalUrl, isHttpUrl } from './sources.js';
import { listContactPoints, listPersonCandidates, TIER_RANK } from './contacts.js';
import { resolvePerson, upsertPersonAffiliations } from './people.js';

const allowedEdgeTypes = new Set(['direct_connection', 'shared_employer', 'shared_school', 'shared_investor', 'shared_event', 'shared_open_source', 'shared_customer_domain', 'manual_note']);
const WARMTH_VALUES = new Set(['unknown', 'cold', 'cool', 'warm', 'hot']);
const WARMTH_RANK = Object.freeze({ unknown: 0, cold: 1, cool: 2, warm: 3, hot: 4 });
const DAY_MS = 24 * 60 * 60 * 1000;

function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}
function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'));
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'));
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
  });
}

// ---- Shared helpers ----

function toDate(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIso(value) {
  const d = toDate(value);
  return d ? d.toISOString() : null;
}

function normalizeWarmth(value) {
  const v = String(value || '').toLowerCase();
  return WARMTH_VALUES.has(v) ? v : 'unknown';
}

// Deterministic warmth derivation from the latest contact timestamp at asOf:
// unknown/null -> unknown, <=30d -> hot, <=90d -> warm, <=180d -> cool, >180d -> cold.
export function warmthFromLastContact(lastContactAt, asOf = new Date()) {
  const at = toDate(asOf) || new Date();
  const last = toDate(lastContactAt);
  if (!last) return 'unknown';
  const days = Math.floor((at.getTime() - last.getTime()) / DAY_MS);
  if (days <= 30) return 'hot';
  if (days <= 90) return 'warm';
  if (days <= 180) return 'cool';
  return 'cold';
}

function daysSince(lastContactAt, asOf = new Date()) {
  const at = toDate(asOf) || new Date();
  const last = toDate(lastContactAt);
  if (!last) return null;
  return Math.max(0, Math.floor((at.getTime() - last.getTime()) / DAY_MS));
}

function sanitizeText(value) {
  return String(value || '').replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[email]').slice(0, 500);
}

function sanitizeEvidence(evidence) {
  return (evidence || []).map(item => {
    if (item && typeof item === 'object') {
      const out = { ...item };
      if (out.label) out.label = sanitizeText(out.label);
      if (out.source) out.source = sanitizeText(out.source);
      return out;
    }
    return sanitizeText(item);
  });
}

function edgePersonId(edge) {
  if (edge.toType === 'person') return edge.toId;
  if (edge.fromType === 'person') return edge.fromId;
  return null;
}

function rowToEdge(row) {
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
    warmth: normalizeWarmth(row.warmth)
  };
}

function rowToContact(row) {
  return row ? {
    id: row.id,
    personId: row.person_id || null,
    stakeholderId: row.stakeholder_id || null,
    companyId: row.company_id || null,
    type: row.type,
    value: row.value,
    normalizedValue: row.normalized_value,
    evidenceTier: row.evidence_tier,
    verificationStatus: row.verification_status,
    confidence: row.confidence,
    sourceObservationIds: parseJson(row.source_observation_ids_json, []),
    checks: parseJson(row.checks_json, {}),
    humanApproved: Boolean(row.human_approved),
    doNotUse: Boolean(row.do_not_use),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    originResearchRunId: row.origin_research_run_id || null,
    lastContactAt: row.last_contact_at || null,
    warmth: normalizeWarmth(row.warmth)
  } : null;
}

function profileEdges(s, profileId) {
  return all(s, `SELECT re.*, p.name AS person_name, p.primary_profile_url AS person_url
    FROM relationship_edges re
    LEFT JOIN people p ON p.id = CASE WHEN re.to_type='person' THEN re.to_id WHEN re.from_type='person' THEN re.from_id ELSE NULL END
    WHERE (re.from_type='profile' AND re.from_id=?) OR (re.to_type='profile' AND re.to_id=?)
    ORDER BY re.created_at, re.id`, [profileId, profileId]).map(row => {
    const edge = rowToEdge(row);
    edge.personName = row.person_name || '';
    edge.personUrl = row.person_url || '';
    return edge;
  });
}

function profileContacts(s, profileId) {
  const connected = new Set(profileEdges(s, profileId).map(edge => edgePersonId(edge)).filter(Boolean));
  if (!connected.size) return [];
  return all(s, `SELECT cp.*, p.name AS person_name FROM contact_points cp
    LEFT JOIN people p ON p.id=cp.person_id
    WHERE cp.person_id IS NOT NULL AND cp.person_id!=''
    ORDER BY cp.updated_at DESC, cp.id`)
    .filter(row => connected.has(row.person_id))
    .map(rowToContact);
}

function contactsByPerson(contacts) {
  const map = new Map();
  for (const contact of contacts) {
    if (!contact.personId) continue;
    if (!map.has(contact.personId)) map.set(contact.personId, []);
    map.get(contact.personId).push(contact);
  }
  return map;
}

function latestContactAt(edge, personContacts) {
  const timestamps = [edge.lastContactAt, ...personContacts.map(contact => contact.lastContactAt)].filter(Boolean);
  return timestamps.length ? timestamps.sort().at(-1) : null;
}

function jobRelevantKeys(s, jobId) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw Error(`Unknown job: ${jobId}`);
  const keys = new Set();
  if (job.company_id) keys.add(`company:${job.company_id}`);
  if (job.company) keys.add(`company:${job.company}`);
  for (const row of all(s, 'SELECT id, person_id FROM stakeholders WHERE job_id=?', [jobId])) {
    keys.add(`person:${row.id}`);
    if (row.person_id) keys.add(`person:${row.person_id}`);
  }
  for (const row of all(s, 'SELECT id, person_id FROM person_candidates WHERE job_id=?', [jobId])) {
    keys.add(`person:${row.id}`);
    if (row.person_id) keys.add(`person:${row.person_id}`);
  }
  return keys;
}

// ---- Legacy CSV import ----

function edgeFromRow(row, at) {
  const fromType = row.from_type || row.fromtype || 'profile';
  const fromId = row.from_id || row.fromid || row.profile_id || row.source || 'user';
  const toType = row.to_type || row.totype || row.target_type || 'person';
  const toId = row.to_id || row.toid || row.target_id || row.person_id || row.company_id || row.value || row.name || '';
  if (!toId) throw Error('CSV row is missing to_id/target_id/value/name');
  const edgeType = row.edge_type || row.edgetype || row.type || 'manual_note';
  if (!allowedEdgeTypes.has(edgeType)) throw Error(`Invalid edge_type: ${edgeType}`);
  const confidence = ['low', 'medium', 'high'].includes(String(row.confidence || '').toLowerCase()) ? String(row.confidence).toLowerCase() : 'medium';
  const evidence = row.evidence_json ? parseJson(row.evidence_json, []) : [{
    label: row.evidence || row.notes || row.note || 'user-imported CSV edge',
    source: row.source_url || row.url || ''
  }];
  return {
    id: id('edge', `${fromType}:${fromId}:${toType}:${toId}:${edgeType}:${JSON.stringify(evidence)}`),
    fromType,
    fromId,
    toType,
    toId,
    edgeType,
    evidence,
    confidence,
    createdAt: at
  };
}

export function importNetworkCsv(s, { filePath, profileId = null, format = 'auto' }) {
  const text = fs.readFileSync(filePath, 'utf8');
  const at = now();
  const fileHash = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
  const basename = path.basename(filePath);

  // Detect format from raw headers
  if (format === 'auto') {
    const rawLines = String(text).split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'));
    if (rawLines.length) {
      const headers = parseCsvLine(rawLines[0]).map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'));
      format = (headers.includes('first_name') && headers.includes('last_name') && headers.includes('url')) ? 'linkedin' : 'generic';
    } else {
      format = 'generic';
    }
  }
  if (!['linkedin', 'generic'].includes(format)) throw Error(`Invalid network import format: ${format}`);

  if (format !== 'linkedin') {
    // Generic format — existing edge-based import with privacy-safe audit
    const rows = parseCsv(text);
    const imported = [];
    const edgeWarnings = [];
    for (const row of rows) {
      try {
        const edge = edgeFromRow(row, at);
        run(s, 'INSERT OR REPLACE INTO relationship_edges (id,from_type,from_id,to_type,to_id,edge_type,evidence_json,confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?)', [edge.id, edge.fromType, edge.fromId, edge.toType, edge.toId, edge.edgeType, JSON.stringify(edge.evidence), edge.confidence, edge.createdAt]);
        imported.push(edge);
      } catch (e) {
        edgeWarnings.push(e.message);
      }
    }
    const rel = path.join('network', `relationship-edges-${new Date().toISOString().slice(0, 10)}.yaml`);
    writeYaml(path.join(s.p.ws, rel), {
      version: 1,
      sourceFile: basename,
      importedAt: at,
      policy: { externalSideEffects: 'none', note: 'Relationship edges are user-imported local data.' },
      edges: imported
    });
    audit(s, 'network.imported', 'relationship_edges', id('network-import', `${basename}:${at}`), {
      format: 'generic',
      path: rel,
      count: imported.length,
      basename,
      fileHash,
      skippedCount: edgeWarnings.length || undefined
    });
    save(s);
    return { count: imported.length, path: rel, edges: imported, warnings: edgeWarnings.length ? edgeWarnings : undefined, note: 'Network CSV imported locally; no external accounts were accessed.' };
  }

  // LinkedIn format — profile→person connections
  if (!profileId) throw Error('profileId is required for LinkedIn import format');
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [profileId])) throw Error(`Unknown profile: ${profileId}`);
  const rows = parseCsv(text);
  const staged = [];
  const warnings = [];

  // Stage: validate every row before any write
  for (const row of rows) {
    const firstName = String(row.first_name || '').trim();
    const lastName = String(row.last_name || '').trim();
    const url = String(row.url || '').trim();
    const email = String(row.email_address || '').trim().toLowerCase();
    const company = String(row.company || '').trim();
    const position = String(row.position || '').trim();
    const name = [firstName, lastName].filter(Boolean).join(' ');
    if (url && !isHttpUrl(url)) {
      warnings.push(`Skipping row for "${name || '(no name)'}": URL must be http(s)`);
      continue;
    }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      warnings.push(`Skipping row for "${name || '(no name)'}": invalid email`);
      continue;
    }

    if (!name && !url && !email) {
      warnings.push('Skipping row: empty row');
      continue;
    }
    if (!name || (!url && !email)) {
      warnings.push(`Skipping row for "${name || '(no name)'}": requires at least a name plus URL or email`);
      continue;
    }
    staged.push({ firstName, lastName, name, url, email, company, position });
  }

  // Process staged rows
  const imported = [];
  for (const entry of staged) {
    // Resolve canonical person via people.js (URL→email→create)
    const resolved = resolvePerson(s, {
      profileUrl: entry.url || undefined,
      email: entry.email || undefined,
      name: entry.name || undefined,
      sourceRecordId: `${entry.url || entry.email || entry.name}:linkedin_import`
    });
    const personId = resolved?.person?.id || id('person', `${entry.url || entry.email || entry.name}:linkedin_import`);

    // Direct connection edge profile→person (idempotent via deterministic ID)
    const edgeEvidence = [{ label: `User-imported direct connection to ${entry.name}`, source: basename }];
    const edgeId = id('edge', `profile:${profileId}:person:${personId}:direct_connection`);
    run(s, 'INSERT OR REPLACE INTO relationship_edges (id,from_type,from_id,to_type,to_id,edge_type,evidence_json,confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?)', [
      edgeId, 'profile', profileId, 'person', personId, 'direct_connection', JSON.stringify(edgeEvidence), 'high', at
    ]);

    if (entry.company) {
      upsertPersonAffiliations(s, personId, [{
        type: 'employer',
        organization: entry.company,
        roleOrProgram: entry.position,
        source: 'linkedin_import',
        confidence: 'medium',
        status: 'suggested'
      }], at);
      const employerEvidence = [{ label: `User-imported employer: ${entry.company}`, source: basename }];
      const employerEdgeId = id('edge', `person:${personId}:company:${entry.company}:shared_employer`);
      run(s, 'INSERT OR REPLACE INTO relationship_edges (id,from_type,from_id,to_type,to_id,edge_type,evidence_json,confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?)', [
        employerEdgeId, 'person', personId, 'company', entry.company, 'shared_employer', JSON.stringify(employerEvidence), 'medium', at
      ]);
    }

    // Profile URL contact at tier U, unapproved
    if (entry.url) {
      const normalizedUrl = canonicalUrl(entry.url);
      const cidUrl = id('contact', `:${personId}::profile_url:${normalizedUrl}`);
      run(s, 'INSERT OR IGNORE INTO contact_points (id,person_id,stakeholder_id,company_id,type,value,normalized_value,evidence_tier,verification_status,confidence,source_observation_ids_json,checks_json,human_approved,do_not_use,created_at,updated_at,origin_research_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
        cidUrl, personId, null, null, 'profile_url', entry.url, normalizedUrl,
        'U', 'user_imported', 'medium', '[]', JSON.stringify({ importedFrom: 'linkedin_csv', basename }), 0, 0, at, at, ''
      ]);
    }

    // Email contact at tier U, unapproved
    if (entry.email) {
      const cidEmail = id('contact', `:${personId}::email:${entry.email}`);
      run(s, 'INSERT OR IGNORE INTO contact_points (id,person_id,stakeholder_id,company_id,type,value,normalized_value,evidence_tier,verification_status,confidence,source_observation_ids_json,checks_json,human_approved,do_not_use,created_at,updated_at,origin_research_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
        cidEmail, personId, null, null, 'email', entry.email, entry.email,
        'U', 'user_imported', 'medium', '[]', JSON.stringify({ importedFrom: 'linkedin_csv', basename }), 0, 0, at, at, ''
      ]);
    }

    imported.push({ personId, name: entry.name, url: entry.url || null, email: entry.email || null, company: entry.company || null });
  }

  // Workspace mirror — persons list only, no raw CSV, emails, exclusions, or API keys
  const relDir = path.join('network', 'imports');
  const relYaml = path.join(relDir, `linkedin-import-${new Date().toISOString().slice(0, 10)}.yaml`);
  writeYaml(path.join(s.p.ws, relYaml), {
    version: 1,
    importedAt: at,
    profileId,
    format: 'linkedin',
    policy: { externalSideEffects: 'none', note: 'Imported LinkedIn connections are local data only.' },
    count: imported.length,
    warnings: warnings.length > 0 ? warnings : undefined,
    persons: imported.map(person => ({ personId: person.personId, name: person.name, profileUrl: person.url, company: person.company }))
  });

  // Privacy-safe audit: format, counts, basename, file hash only
  audit(s, 'network.imported', 'relationship_edges', id('network-import', `${basename}:${at}`), {
    format: 'linkedin',
    count: imported.length,
    skippedCount: warnings.length,
    basename,
    fileHash
  });

  save(s);
  return { count: imported.length, path: relYaml, warnings, format: 'linkedin', note: 'LinkedIn connections imported locally.' };
}

// ---- Strength helpers (legacy) ----

function strengthForEdge(edge) {
  if (edge.edgeType === 'direct_connection') return 6;
  if (['shared_employer', 'shared_school', 'shared_open_source', 'shared_event'].includes(edge.edgeType)) return 5;
  if (['shared_investor', 'shared_customer_domain'].includes(edge.edgeType)) return 4;
  return 3;
}

function strengthForContact(contact) {
  if (contact.doNotUse) return 0;
  if (contact.type === 'email' && TIER_RANK[contact.evidenceTier] >= TIER_RANK.A && contact.humanApproved) return 4;
  if (contact.type === 'email' && TIER_RANK[contact.evidenceTier] >= TIER_RANK.U) return 3;
  if (contact.type === 'generic_inbox') return 2;
  if (contact.type === 'profile_url') return 1;
  return 0;
}

function pathLabel(score) {
  if (score >= 6) return 'direct user-provided connection';
  if (score >= 5) return 'shared employer/school/community';
  if (score >= 4) return 'shared investor/portfolio/community or approved exact contact';
  if (score >= 3) return 'exact public contact';
  if (score >= 2) return 'generic routing inbox';
  if (score >= 1) return 'public profile/manual message';
  return 'no safe path';
}

function renderNetworkMap({ job, paths, generatedAt }) {
  const rows = paths.length ? paths.map((item, index) => {
    const evidence = item.evidence?.length ? item.evidence.map(e => `  - Evidence: ${e.label || e.source || JSON.stringify(e)}`).join('\n') : '  - Evidence: local JobOS state';
    return `${index + 1}. **${item.label}**\n  - Strength: ${item.pathStrength}\n  - Channel: ${item.channel}\n${evidence}`;
  }).join('\n') : 'No reachable paths found yet.';
  return `# Network map - ${job.company}

Generated: ${generatedAt}

**Related job:** ${job.title} (${job.id})

## Contact path ladder
${rows}

## Human gate
This network map is local research only. JobOS did not access private accounts, send outreach, or create connection requests.
`;
}

// ---- Profile graph traversal (bounded, deterministic) ----

function traverseProfileGraph(s, profileId, maxHops) {
  const edges = all(s, 'SELECT * FROM relationship_edges ORDER BY created_at, id').map(rowToEdge);
  const adjacency = new Map();
  for (const edge of edges) {
    const fromKey = `${edge.fromType}:${edge.fromId}`;
    const toKey = `${edge.toType}:${edge.toId}`;
    if (!adjacency.has(fromKey)) adjacency.set(fromKey, []);
    adjacency.get(fromKey).push({ edge, otherKey: toKey, forward: true });
    if (!adjacency.has(toKey)) adjacency.set(toKey, []);
    adjacency.get(toKey).push({ edge, otherKey: fromKey, forward: false });
  }
  const startKey = `profile:${profileId}`;
  const paths = [];
  const seen = new Set([startKey]);
  const queue = [{ key: startKey, hops: 0, path: [] }];
  while (queue.length) {
    const { key, hops, path } = queue.shift();
    if (hops >= maxHops) continue;
    for (const { edge, otherKey, forward } of adjacency.get(key) || []) {
      const nextKey = otherKey;
      const nextHops = hops + 1;
      const hop = forward
        ? { fromType: edge.fromType, fromId: edge.fromId, toType: edge.toType, toId: edge.toId, edgeId: edge.id, edgeType: edge.edgeType, confidence: edge.confidence, evidence: edge.evidence, createdAt: edge.createdAt, lastContactAt: edge.lastContactAt, warmth: edge.warmth }
        : { fromType: edge.toType, fromId: edge.toId, toType: edge.fromType, toId: edge.fromId, edgeId: edge.id, edgeType: edge.edgeType, confidence: edge.confidence, evidence: edge.evidence, createdAt: edge.createdAt, lastContactAt: edge.lastContactAt, warmth: edge.warmth };
      const nextPath = [...path, hop];
      const pathKey = `${nextKey}:${nextPath.map(h => h.edgeId).join('|')}`;
      if (seen.has(pathKey)) continue;
      seen.add(pathKey);
      const separator = nextKey.indexOf(':');
      const nextType = nextKey.slice(0, separator);
      const nextId = nextKey.slice(separator + 1);
      if ((nextType === 'person' || nextType === 'company') && !(nextHops === 2 && nextId === path[0]?.toId)) {
        paths.push({ hops: nextHops, path: nextPath, targetType: nextType, targetId: nextId });
      }
      // Two-hop paths are profile -> person -> person/company: only person
      // intermediates are expanded further.
      if (nextHops < maxHops && nextType === 'person') queue.push({ key: nextKey, hops: nextHops, path: nextPath });
    }
  }
  return paths;
}

function buildGraphPath(profileId, { hops, path, targetType, targetId }, { people, companies }) {
  const lastHop = path[path.length - 1];
  const targetName = targetType === 'person'
    ? (people.get(targetId)?.name || lastHop.toId)
    : (companies.get(targetId)?.name || lastHop.toId);
  const intermediate = hops === 2 ? path[0] : null;
  const intermediateName = intermediate ? (people.get(intermediate.toId)?.name || intermediate.toId) : '';
  const score = hops === 1 ? strengthForEdge(lastHop) : Math.min(strengthForEdge(path[0]), strengthForEdge(lastHop));
  const mutualPath = hops === 2 && lastHop.toType === 'person';
  const label = hops === 1
    ? `${lastHop.edgeType.replace(/_/g, ' ')} via ${targetName}`
    : `${targetName} via ${intermediateName}`;
  return {
    id: id('path', `${profileId}:${path.map(h => h.edgeId).join('>')}`),
    hops,
    target: {
      type: targetType,
      id: targetId,
      name: targetName,
      ...(targetType === 'person' ? { profileUrl: people.get(targetId)?.primary_profile_url || '' } : {})
    },
    path,
    mutualPath,
    score,
    pathStrength: pathLabel(score),
    channel: (mutualPath || (hops === 1 && lastHop.edgeType === 'direct_connection')) ? 'intro_request' : 'manual_context',
    evidence: sanitizeEvidence(lastHop.evidence),
    label
  };
}

// ---- Profile-level read-only tools ----

export function networkGraphQuery(s, { profileId, jobId = null, personId = null, maxHops = 2 }) {
  if (!profileId) throw Error('profileId is required');
  const profile = one(s, 'SELECT * FROM profiles WHERE id=?', [profileId]);
  if (!profile) throw Error(`Unknown profile: ${profileId}`);
  const hops = maxHops == null ? 2 : Number(maxHops);
  if (!Number.isInteger(hops) || hops < 1 || hops > 2) throw Error('maxHops must be 1 or 2');
  if (jobId != null && jobId !== '' && !one(s, 'SELECT id FROM jobs WHERE id=?', [jobId])) throw Error(`Unknown job: ${jobId}`);
  const generatedAt = one(s, 'SELECT MAX(created_at) AS at FROM relationship_edges')?.at || profile.updated_at || profile.created_at;
  const people = new Map(all(s, 'SELECT * FROM people ORDER BY name, id').map(p => [p.id, p]));
  if (personId != null && personId !== '' && !people.has(personId)) throw Error(`Unknown person: ${personId}`);
  const companies = new Map(all(s, 'SELECT * FROM companies ORDER BY name, id').map(c => [c.id, c]));
  const relevantKeys = jobId ? jobRelevantKeys(s, jobId) : null;
  let paths = traverseProfileGraph(s, profileId, hops).map(p => buildGraphPath(profileId, p, { people, companies }));
  if (relevantKeys) paths = paths.filter(p => relevantKeys.has(`${p.target.type}:${p.target.id}`));
  if (personId) paths = paths.filter(p => p.target.type === 'person' && p.target.id === personId);
  paths.sort((a, b) => b.score - a.score || a.hops - b.hops || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));

  const nodes = [];
  const nodeSeen = new Set();
  const addNode = (type, nodeId, name, extra = {}) => {
    const key = `${type}:${nodeId}`;
    if (nodeSeen.has(key)) return;
    nodeSeen.add(key);
    nodes.push({ id: nodeId, type, name, ...extra });
  };
  addNode('profile', profileId, profile.name);
  for (const p of paths) {
    if (p.target.type === 'person') addNode('person', p.target.id, p.target.name, { profileUrl: p.target.profileUrl || '' });
    else addNode('company', p.target.id, p.target.name);
    for (const hop of p.path) {
      if (hop.fromType === 'person') addNode('person', hop.fromId, people.get(hop.fromId)?.name || hop.fromId, { profileUrl: people.get(hop.fromId)?.primary_profile_url || '' });
      if (hop.toType === 'person') addNode('person', hop.toId, people.get(hop.toId)?.name || hop.toId, { profileUrl: people.get(hop.toId)?.primary_profile_url || '' });
      if (hop.fromType === 'company') addNode('company', hop.fromId, companies.get(hop.fromId)?.name || hop.fromId);
      if (hop.toType === 'company') addNode('company', hop.toId, companies.get(hop.toId)?.name || hop.toId);
    }
  }
  const edgesOut = [];
  const edgeSeen = new Set();
  for (const p of paths) {
    for (const hop of p.path) {
      if (edgeSeen.has(hop.edgeId)) continue;
      edgeSeen.add(hop.edgeId);
      edgesOut.push({ id: hop.edgeId, fromType: hop.fromType, fromId: hop.fromId, toType: hop.toType, toId: hop.toId, edgeType: hop.edgeType, confidence: hop.confidence, warmth: hop.warmth, lastContactAt: hop.lastContactAt, createdAt: hop.createdAt });
    }
  }
  return {
    profileId,
    jobId: jobId || null,
    personId: personId || null,
    maxHops: hops,
    generatedAt,
    nodes,
    edges: edgesOut,
    paths,
    pathCount: paths.length,
    note: 'Local network graph only; no external accounts were accessed and no outreach was sent.'
  };
}

export function networkOpportunitiesList(s, { profileId, limit = 25, asOf = new Date() }) {
  if (!profileId) throw Error('profileId is required');
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [profileId])) throw Error(`Unknown profile: ${profileId}`);
  const at = toDate(asOf);
  if (!at) throw Error(`Invalid asOf timestamp: ${asOf}`);
  const max = Math.max(1, Math.min(200, Number(limit) || 25));
  const graph = networkGraphQuery(s, { profileId, maxHops: 2 });
  const people = new Map(all(s, 'SELECT * FROM people ORDER BY name, id').map(person => [person.id, person]));
  const contacts = all(s, `SELECT * FROM contact_points
    WHERE person_id IS NOT NULL AND person_id!=''
    ORDER BY updated_at DESC,id`).map(rowToContact);
  const byPerson = contactsByPerson(contacts);
  const bestPathByPerson = new Map();
  for (const path of graph.paths.filter(item => item.target.type === 'person')) {
    const current = bestPathByPerson.get(path.target.id);
    if (!current || path.score > current.score || (path.score === current.score && path.hops < current.hops)) {
      bestPathByPerson.set(path.target.id, path);
    }
  }
  const opportunities = [];
  for (const [personId, path] of bestPathByPerson) {
    const person = people.get(personId);
    const personContacts = byPerson.get(personId) || [];
    const lastContactAt = [
      ...path.path.map(hop => hop.lastContactAt),
      ...personContacts.map(contact => contact.lastContactAt)
    ].filter(Boolean).sort().at(-1) || null;
    const warmth = warmthFromLastContact(lastContactAt, at);
    const usableContacts = personContacts.filter(contact => !contact.doNotUse && contact.humanApproved);
    const score = WARMTH_RANK[warmth] * 10 + path.score * 3 + Math.min(usableContacts.length, 3) * 2;
    opportunities.push({
      personId,
      name: person?.name || path.target.name || personId,
      profileUrl: person?.primary_profile_url || path.target.profileUrl || '',
      warmth,
      lastContactAt,
      daysSinceContact: daysSince(lastContactAt, at),
      contactCount: usableContacts.length,
      contactTypes: [...new Set(usableContacts.map(contact => contact.type))].sort(),
      strategic: true,
      direct: path.hops === 1 && path.path[0]?.edgeType === 'direct_connection',
      hops: path.hops,
      pathStrength: path.pathStrength,
      channel: path.channel,
      score,
      evidence: sanitizeEvidence(path.evidence)
    });
  }
  opportunities.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.personId.localeCompare(b.personId));
  const top = opportunities.slice(0, max);
  return {
    profileId,
    generatedAt: at.toISOString(),
    asOf: at.toISOString(),
    count: top.length,
    total: opportunities.length,
    opportunities: top,
    note: 'Local direct and indirect network opportunities only; no outreach or requests were sent.'
  };
}

export function networkHealthBrief(s, { profileId, asOf = new Date() }) {
  if (!profileId) throw Error('profileId is required');
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [profileId])) throw Error(`Unknown profile: ${profileId}`);
  const at = toDate(asOf);
  if (!at) throw Error(`Invalid asOf timestamp: ${asOf}`);
  const edges = profileEdges(s, profileId);
  const contacts = profileContacts(s, profileId);
  const people = new Map(all(s, 'SELECT * FROM people ORDER BY name, id').map(p => [p.id, p]));
  const byPerson = contactsByPerson(contacts);
  const relationships = [];
  const seenPeople = new Set();
  for (const edge of edges) {
    if (edge.edgeType !== 'direct_connection') continue;
    const personId = edgePersonId(edge);
    if (!personId || seenPeople.has(personId)) continue;
    seenPeople.add(personId);
    const person = people.get(personId);
    const personContacts = byPerson.get(personId) || [];
    const relatedEdges = edges.filter(candidate => candidate.edgeType === 'direct_connection' && edgePersonId(candidate) === personId);
    const lastContactAt = [latestContactAt(edge, personContacts), ...relatedEdges.map(candidate => candidate.lastContactAt)].filter(Boolean).sort().at(-1) || null;
    relationships.push({
      personId,
      name: person?.name || edge.personName || personId,
      warmth: warmthFromLastContact(lastContactAt, at),
      lastContactAt: lastContactAt || null,
      daysSinceContact: daysSince(lastContactAt, at),
      strategic: true
    });
  }
  relationships.sort((a, b) => WARMTH_RANK[b.warmth] - WARMTH_RANK[a.warmth] || a.name.localeCompare(b.name) || a.personId.localeCompare(b.personId));
  const counts = { total: relationships.length, strategic: relationships.filter(r => r.strategic).length, byWarmth: { unknown: 0, cold: 0, cool: 0, warm: 0, hot: 0 } };
  for (const r of relationships) counts.byWarmth[r.warmth]++;
  return {
    profileId,
    generatedAt: at.toISOString(),
    asOf: at.toISOString(),
    counts,
    relationships,
    note: 'Local network health only; no external accounts were accessed.'
  };
}

// ---- Trusted human-confirmed contact recording ----

export function recordNetworkContact(s, { profileId, personId, contactPointId = null, occurredAt = new Date(), warmth = null, note = '', source = 'cli' }) {
  if (!profileId) throw Error('profileId is required');
  if (!personId) throw Error('personId is required');
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [profileId])) throw Error(`Unknown profile: ${profileId}`);
  if (!one(s, 'SELECT id FROM people WHERE id=?', [personId])) throw Error(`Unknown person: ${personId}`);
  const at = toDate(occurredAt);
  if (!at) throw Error(`Invalid occurredAt timestamp: ${occurredAt}`);
  const iso = at.toISOString();
  if (at.getTime() > Date.now()) throw Error('occurredAt cannot be in the future');
  if (warmth != null && warmth !== '' && !WARMTH_VALUES.has(String(warmth).toLowerCase())) {
    throw Error(`Invalid warmth: ${warmth}`);
  }
  const selectedContact = contactPointId ? one(s, 'SELECT * FROM contact_points WHERE id=?', [contactPointId]) : null;
  if (contactPointId && !selectedContact) throw Error(`Unknown contact point: ${contactPointId}`);
  if (selectedContact && selectedContact.person_id !== personId) throw Error(`Contact point ${contactPointId} does not belong to person ${personId}`);

  const existingEdges = all(s, `SELECT * FROM relationship_edges
    WHERE edge_type='direct_connection'
      AND ((from_type='profile' AND from_id=? AND to_type='person' AND to_id=?)
        OR (to_type='profile' AND to_id=? AND from_type='person' AND from_id=?))
    ORDER BY created_at,id`, [profileId, personId, profileId, personId]);
  const relatedContacts = all(s, 'SELECT id,last_contact_at FROM contact_points WHERE person_id=? ORDER BY id', [personId]);
  const currentLastContactAt = [
    ...existingEdges.map(edge => edge.last_contact_at),
    ...relatedContacts.map(contact => contact.last_contact_at),
  ].filter(Boolean).sort().at(-1) || null;
  const edgeId = existingEdges[0]?.id || id('edge', `profile:${profileId}:person:${personId}:direct_connection`);
  if (currentLastContactAt && iso <= currentLastContactAt) {
    return {
      profileId,
      personId,
      contactPointId: contactPointId || null,
      occurredAt: iso,
      warmth: warmthFromLastContact(currentLastContactAt, new Date()),
      lastContactAt: currentLastContactAt,
      updatedEdge: edgeId,
      updatedContactPoints: [],
      idempotent: iso === currentLastContactAt,
      ignoredAsOlder: iso < currentLastContactAt,
      note: 'Existing newer or identical local contact record preserved; no external action was taken.',
    };
  }

  const warmthValue = warmth == null || warmth === '' ? warmthFromLastContact(iso, at) : normalizeWarmth(warmth);
  if (existingEdges.length) {
    run(s, `UPDATE relationship_edges SET last_contact_at=?, warmth=?
      WHERE edge_type='direct_connection'
        AND ((from_type='profile' AND from_id=? AND to_type='person' AND to_id=?)
          OR (to_type='profile' AND to_id=? AND from_type='person' AND from_id=?))`,
    [iso, warmthValue, profileId, personId, profileId, personId]);
  } else {
    run(s, 'INSERT INTO relationship_edges (id,from_type,from_id,to_type,to_id,edge_type,evidence_json,confidence,created_at,last_contact_at,warmth) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [
      edgeId, 'profile', profileId, 'person', personId, 'direct_connection',
      JSON.stringify([{ label: 'Human-confirmed contact recorded', source: String(source || 'cli') }]),
      'high', now(), iso, warmthValue
    ]);
  }
  const updatedContactPoints = [];
  const contactsToUpdate = selectedContact ? [selectedContact] : relatedContacts;
  for (const contact of contactsToUpdate) {
    run(s, 'UPDATE contact_points SET last_contact_at=?, warmth=?, updated_at=? WHERE id=?', [iso, warmthValue, now(), contact.id]);
    updatedContactPoints.push(contact.id);
  }
  audit(s, 'network.contact.recorded', 'person', personId, {
    profileId, personId, contactPointId: contactPointId || null, occurredAt: iso, warmth: warmthValue, note: sanitizeText(note), source: String(source || 'cli')
  });
  syncNetworkWorkspace(s, { profileId });
  return {
    profileId,
    personId,
    contactPointId: contactPointId || null,
    occurredAt: iso,
    warmth: warmthValue,
    lastContactAt: iso,
    updatedEdge: edgeId,
    updatedContactPoints,
    idempotent: false,
    ignoredAsOlder: false,
    note: 'Contact recorded locally; no external action was taken.'
  };
}

// ---- Workspace mirrors ----

function renderHealthBriefMd(brief) {
  const lines = brief.relationships.length
    ? brief.relationships.map((r, i) => `- **${r.name}** — ${r.warmth}${r.lastContactAt ? ` (last contact ${r.lastContactAt.slice(0, 10)}, ${r.daysSinceContact}d ago)` : ' (no recorded contact)'}${r.strategic ? ' — strategic' : ''}`).join('\n')
    : '- No strategic relationships yet.';
  return `# Network health brief — ${brief.profileId}

Generated: ${brief.generatedAt}
As of: ${brief.asOf}

## Counts
- Total relationships: ${brief.counts.total}
- Strategic: ${brief.counts.strategic}
- By warmth: hot ${brief.counts.byWarmth.hot}, warm ${brief.counts.byWarmth.warm}, cool ${brief.counts.byWarmth.cool}, cold ${brief.counts.byWarmth.cold}, unknown ${brief.counts.byWarmth.unknown}

## Relationships
${lines}

## Human gate
This brief summarizes local JobOS state only. No external accounts were accessed and no outreach was sent.
`;
}

function renderOpportunitiesMd(opportunities) {
  const lines = opportunities.opportunities.length
    ? opportunities.opportunities.map((o, i) => `- **${o.name}** — ${o.warmth}${o.lastContactAt ? ` (last contact ${o.lastContactAt.slice(0, 10)})` : ''}${o.contactCount ? `, ${o.contactCount} approved contact(s)` : ''}`).join('\n')
    : '- No opportunities yet.';
  return `# Network opportunities — ${opportunities.profileId}

Generated: ${opportunities.generatedAt}
As of: ${opportunities.asOf}

## Opportunities
${lines}

## Human gate
This list summarizes local JobOS state only. No outreach or requests were sent.
`;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function syncNetworkWorkspace(s, { profileId, jobId = null }) {
  if (!profileId) throw Error('profileId is required');
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [profileId])) throw Error(`Unknown profile: ${profileId}`);
  const at = now();
  const brief = networkHealthBrief(s, { profileId, asOf: at });
  const opportunities = networkOpportunitiesList(s, { profileId, limit: 200, asOf: at });
  const graph = networkGraphQuery(s, { profileId, jobId: jobId || null, maxHops: 2 });
  const relBase = path.join('profiles', profileId, 'network');
  const relHealthYaml = path.join(relBase, 'health.yaml');
  const relHealthMd = path.join(relBase, 'health.md');
  const relOppYaml = path.join(relBase, 'opportunities.yaml');
  const relOppMd = path.join(relBase, 'opportunities.md');
  const relGraphYaml = path.join(relBase, 'graph.yaml');
  const relRelationshipsJson = path.join(relBase, 'relationships.json');
  const relNurtureJson = path.join(relBase, 'nurture-tasks.json');
  const nurtureTasks = all(s, `SELECT id,title,due_at,priority,status,created_at,updated_at
    FROM tasks WHERE profile_id=? AND type='network_nurture' ORDER BY due_at IS NULL,due_at,id`, [profileId]).map(task => ({
    id: task.id,
    title: task.title,
    dueAt: task.due_at || null,
    priority: task.priority,
    status: task.status,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  }));
  writeYaml(path.join(s.p.ws, relHealthYaml), { version: 1, ...brief });
  writeYaml(path.join(s.p.ws, relOppYaml), { version: 1, ...opportunities });
  writeYaml(path.join(s.p.ws, relGraphYaml), { version: 1, ...graph });
  writeJson(path.join(s.p.ws, relRelationshipsJson), {
    schema: 'jobos.network-relationships.v1',
    profileId,
    asOf: brief.asOf,
    relationships: brief.relationships,
  });
  writeJson(path.join(s.p.ws, relNurtureJson), {
    schema: 'jobos.network-nurture-tasks.v1',
    profileId,
    tasks: nurtureTasks,
  });
  writeMd(path.join(s.p.ws, relHealthMd), renderHealthBriefMd(brief));
  writeMd(path.join(s.p.ws, relOppMd), renderOpportunitiesMd(opportunities));
  audit(s, 'network.workspace.synced', 'profile', profileId, {
    profileId, jobId: jobId || null, path: relBase,
    relationshipCount: brief.counts.total, opportunityCount: opportunities.count, graphPathCount: graph.pathCount
  });
  save(s);
  return {
    profileId,
    jobId: jobId || null,
    generatedAt: at,
    path: relBase,
    files: [relHealthYaml, relHealthMd, relOppYaml, relOppMd, relGraphYaml, relRelationshipsJson, relNurtureJson],
    counts: { relationships: brief.counts.total, opportunities: opportunities.count, graphPaths: graph.pathCount },
    note: 'Network workspace mirrors written locally; no external accounts were accessed.'
  };
}

// ---- Legacy job-scoped network map (kept compatible, now traversal-backed) ----

export function mapReachableNetwork(s, { jobId }) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw Error(`Unknown job: ${jobId}`);
  const edges = all(s, 'SELECT * FROM relationship_edges ORDER BY created_at DESC, id').map(rowToEdge);
  const candidates = listPersonCandidates(s, { jobId });
  const contacts = listContactPoints(s, { jobId });
  const stakeholderIds = new Set(all(s, 'SELECT id FROM stakeholders WHERE job_id=?', [jobId]).map(row => row.id));
  const candidateIds = new Set(candidates.flatMap(candidate => [candidate.id, candidate.personId]).filter(Boolean));
  const relevantEdges = edges.filter(edge =>
    edge.toId === job.company_id
    || edge.toId === job.company
    || stakeholderIds.has(edge.toId)
    || candidateIds.has(edge.toId)
    || String(edge.toId).toLowerCase() === String(job.company || '').toLowerCase()
  );
  const paths = [];
  const seenKeys = new Set();

  // Legacy relevant-edge paths (covers non-profile-anchored edges)
  for (const edge of relevantEdges) {
    const key = `1:${edge.id}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    paths.push({
      id: edge.id,
      label: `${edge.edgeType.replace(/_/g, ' ')} via ${edge.toId}`,
      pathStrength: pathLabel(strengthForEdge(edge)),
      channel: edge.edgeType === 'direct_connection' ? 'intro_request' : 'manual_context',
      score: strengthForEdge(edge),
      evidence: edge.evidence,
      edge,
      hops: 1
    });
  }

  let introductionGraph = null;
  // New bounded 2-hop traversal from the job's profile (if any)
  if (job.profile_id) {
    const graph = networkGraphQuery(s, { profileId: job.profile_id, jobId, maxHops: 2 });
    introductionGraph = graph;
    for (const p of graph.paths) {
      const key = p.hops === 1 ? `1:${p.path[0].edgeId}` : `2:${p.path.map(h => h.edgeId).join('>')}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const lastHop = p.path[p.path.length - 1];
      const edge = edges.find(e => e.id === lastHop.edgeId) || lastHop;
      paths.push({
        id: p.id,
        label: p.label,
        pathStrength: p.pathStrength,
        channel: p.channel,
        score: p.score,
        evidence: p.evidence,
        edge,
        hops: p.hops,
        path: p.path
      });
    }
  }

  const contactPaths = contacts.map(contact => {
    const score = strengthForContact(contact);
    return {
      id: contact.id,
      label: `${contact.type.replace(/_/g, ' ')}: ${contact.value}`,
      pathStrength: pathLabel(score),
      channel: contact.type === 'profile_url' ? 'linkedin_manual' : contact.type === 'generic_inbox' ? 'generic_inbox' : score >= 3 ? 'email' : 'manual_review',
      score,
      evidence: contact.sourceObservationIds.map(sourceId => ({ label: `source observation ${sourceId}` })),
      contact
    };
  });
  const allPaths = [...paths, ...contactPaths].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  const at = now();
  const relMd = path.join('jobs', jobId, 'research', 'network-map.md');
  const relYaml = path.join('jobs', jobId, 'research', 'network-map.yaml');
  writeMd(path.join(s.p.ws, relMd), renderNetworkMap({ job, paths: allPaths, generatedAt: at }));
  writeYaml(path.join(s.p.ws, relYaml), { version: 1, generatedAt: at, jobId, paths: allPaths });
  const relIntroductionJson = path.join('jobs', jobId, 'research', 'introduction-paths.json');
  writeJson(path.join(s.p.ws, relIntroductionJson), {
    schema: 'jobos.network-introduction-paths.v1',
    profileId: job.profile_id,
    jobId,
    maxHops: 2,
    paths: introductionGraph?.paths || [],
  });
  audit(s, 'research.network.created', 'job', jobId, { jobId, path: relMd, pathCount: allPaths.length, edgeCount: relevantEdges.length, contactPathCount: contactPaths.length });
  save(s);
  return { jobId, path: relMd, yamlPath: relYaml, introductionPath: relIntroductionJson, paths: allPaths, pathCount: allPaths.length, note: 'Network map created locally; no private accounts were accessed and no outreach was sent.' };
}

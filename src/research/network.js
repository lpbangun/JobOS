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
        run(s, 'INSERT OR REPLACE INTO relationship_edges VALUES (?,?,?,?,?,?,?,?,?)', [edge.id, edge.fromType, edge.fromId, edge.toType, edge.toId, edge.edgeType, JSON.stringify(edge.evidence), edge.confidence, edge.createdAt]);
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
    run(s, 'INSERT OR REPLACE INTO relationship_edges VALUES (?,?,?,?,?,?,?,?,?)', [
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
      run(s, 'INSERT OR REPLACE INTO relationship_edges VALUES (?,?,?,?,?,?,?,?,?)', [
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
    persons: imported
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
    createdAt: row.created_at
  };
}

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

export function mapReachableNetwork(s, { jobId }) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw Error(`Unknown job: ${jobId}`);
  const edges = all(s, 'SELECT * FROM relationship_edges ORDER BY created_at DESC').map(rowToEdge);
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
  const edgePaths = relevantEdges.map(edge => ({
    id: edge.id,
    label: `${edge.edgeType.replace(/_/g, ' ')} via ${edge.toId}`,
    pathStrength: pathLabel(strengthForEdge(edge)),
    channel: edge.edgeType === 'direct_connection' ? 'intro_request' : 'manual_context',
    score: strengthForEdge(edge),
    evidence: edge.evidence,
    edge
  }));
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
  const paths = [...edgePaths, ...contactPaths].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  const at = now();
  const relMd = path.join('jobs', jobId, 'research', 'network-map.md');
  const relYaml = path.join('jobs', jobId, 'research', 'network-map.yaml');
  writeMd(path.join(s.p.ws, relMd), renderNetworkMap({ job, paths, generatedAt: at }));
  writeYaml(path.join(s.p.ws, relYaml), { version: 1, generatedAt: at, jobId, paths });
  audit(s, 'research.network.created', 'job', jobId, { jobId, path: relMd, pathCount: paths.length, edgeCount: relevantEdges.length, contactPathCount: contactPaths.length });
  save(s);
  return { jobId, path: relMd, yamlPath: relYaml, paths, pathCount: paths.length, note: 'Network map created locally; no private accounts were accessed and no outreach was sent.' };
}

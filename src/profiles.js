import fs from 'node:fs';
import path from 'node:path';
import { id, now, slug, tokenize, parseJson } from './utils.js';
import { one, all, run, save, audit } from './db.js';
import { writeYaml, writeMd } from './workspace.js';
import { normalizeOrganization } from './research/context.js';

export function defaultPrefs(name){ return {targetRoleFamilies:[name],industries:[],companyStages:[],locations:[],salary:{min:null,max:null,currency:'USD'},dealbreakers:[],skills:slug(name).split('-').filter(Boolean),missionKeywords:[],values:[],workModel:'',communicationStyle:'concise, warm, evidence-grounded',searchStrategy:'focused',automationPolicy:{externalApply:'user_configured',externalSend:'user_configured',autoApply:'disabled',autoSend:'disabled',allowedConnectors:[]},networkIntent:{version:1,targetCompanies:[],targetRoles:[],preferredPersonas:[],comfortableRelationshipTypes:[],exclusions:[],allowedSources:{publicWeb:true,linkedinImport:false,xai:false},completedAt:null}}; }
export function extractMetrics(line){ return [...String(line).matchAll(/(?:\$[\d,.]+|\d+(?:\.\d+)?%|\d+x|\b\d{2,}\b)/gi)].map(m=>m[0]); }
export function structuredProofs(profileId, text, source){ return String(text||'').split(/\r?\n/).map(l=>l.trim().replace(/^[-*•]\s*/, '')).filter(l=>l.length>=20).filter(l=>/\b(built|led|managed|created|designed|improved|launched|reduced|increased|owned|shipped|analyzed|implemented|taught|researched|coordinated|facilitated|developed)\b/i.test(l)).slice(0,24).map((line,idx)=>({id:id('proof',`${profileId}:${idx}:${line}`),summary:line,evidence:source,skills:[...new Set(tokenize(line).filter(t=>t.length>3).slice(0,10))],metrics:extractMetrics(line),metadata:{origin:'resume_import',claimType:'experience',requiresHumanVerification:false}})); }
export function suggestProfileAffiliations(resumeText){
  const lines=String(resumeText||'').split(/\r?\n/).map(l=>l.trim()).filter(l=>l.length>=10);
  const results=[], seen=new Set();
  const eduPat=/\b(Bachelor|Master|PhD|Ph\.D\.|B\.S\.|M\.S\.|B\.A\.|M\.A\.|MBA|JD|Associate|Doctorate|B\.Eng|M\.Eng|B\.Sc|M\.Sc)\b[^,]{0,60}(?:,|at|–|—|-)\s*(.{3,80})/i;
  const rolePat=/^[-•*]\s+(.{3,60}?)\s+(?:at|@|–|—|-)\s+([A-Z][A-Za-z0-9\s&.']{2,60})/;
  const commPat=/(?:^[-•*]\s+)?(Volunteer|Board\s+Member|Advisor|Mentor|Treasurer|Secretary|Chair|Co-Chair|President|Director|Trustee)\s*(?:,|–|—|-|at|@|for|of)\s+(.{3,80})/i;
  for(const line of lines){
    const edu=eduPat.exec(line);
    if(edu){ const org=edu[2].trim(); if(!seen.has(org)){ seen.add(org); results.push({type:'school',organization:org,role_or_program:edu[1].trim(),start_date:null,end_date:null,confidence:'medium'}); } continue; }
    const comm=commPat.exec(line);
    if(comm){ const org=comm[2].trim(); if(!seen.has(org)){ seen.add(org); results.push({type:'community',organization:org,role_or_program:comm[1].trim(),start_date:null,end_date:null,confidence:'medium'}); } continue; }
    const emp=rolePat.exec(line);
    if(emp){ const org=emp[2].trim(); if(!seen.has(org)){ seen.add(org); results.push({type:'employer',organization:org,role_or_program:emp[1].trim(),start_date:null,end_date:null,confidence:'medium'}); } continue; }
  }
  return results;
}
export function syncProfile(s, pid){ const p=one(s,'SELECT * FROM profiles WHERE id=?',[pid]); if(!p) return; const proofs=all(s,'SELECT * FROM proof_points WHERE profile_id=? ORDER BY created_at',[pid]); const affs=all(s,'SELECT * FROM profile_affiliations WHERE profile_id=? ORDER BY type,organization',[pid]).map(a=>({id:a.id,type:a.type,organization:a.organization,role_or_program:a.role_or_program,start_date:a.start_date,end_date:a.end_date,source:a.source,confidence:a.confidence,status:a.status})); writeYaml(path.join(s.p.profiles,`${pid}.yaml`),{id:p.id,name:p.name,preferences:parseJson(p.preferences_json,{}),affiliations:affs,proofPoints:proofs.map(x=>({id:x.id,summary:x.summary,evidence:x.evidence,skills:parseJson(x.skills_json,[]),metrics:parseJson(x.metrics_json,[]),source:x.source,metadata:parseJson(x.metadata_json,{})})),updatedAt:p.updated_at}); writeMd(path.join(s.p.proofs,`${pid}.md`), ['# Proof points for '+p.name,'',...proofs.map(x=>`- **${x.id}:** ${x.summary}${x.evidence ? ` _(evidence: ${x.evidence})_` : ''}${parseJson(x.metrics_json,[]).length ? ` Metrics: ${parseJson(x.metrics_json,[]).join(', ')}` : ''}`),''].join('\n')); }
export function createProfile(s, name, opts = {}) {
  const pid = slug(name);
  const existing = one(s, 'SELECT * FROM profiles WHERE id=?', [pid]);
  if (existing) return { profile: existing, created: false, nextActions: [] };
  const at = now();
  const resume = opts.fromResume ? fs.readFileSync(opts.fromResume, 'utf8') : '';
  const custom = opts.preferences ? JSON.parse(fs.readFileSync(opts.preferences, 'utf8')) : {};
  const defaults = defaultPrefs(name);
  const prefs = {
    ...defaults,
    ...custom,
    automationPolicy: { ...defaults.automationPolicy, ...(custom.automationPolicy || {}) },
    networkIntent: {
      ...defaults.networkIntent,
      ...(custom.networkIntent || {}),
      allowedSources: { ...defaults.networkIntent.allowedSources, ...(custom.networkIntent?.allowedSources || {}) }
    }
  };
  run(s, 'INSERT INTO profiles VALUES (?,?,?,?,?,?)', [pid, name, JSON.stringify(prefs), resume, at, at]);
  const proofs = structuredProofs(pid, resume, opts.fromResume || 'profile import');
  for (const proof of proofs) {
    run(s, 'INSERT OR IGNORE INTO proof_points (id,profile_id,summary,evidence,skills_json,metrics_json,source,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)', [
      proof.id, pid, proof.summary, proof.evidence, JSON.stringify(proof.skills), JSON.stringify(proof.metrics),
      proof.metadata.origin, JSON.stringify(proof.metadata), at
    ]);
  }
  const affiliations = suggestProfileAffiliations(resume);
  for (const affiliation of affiliations) {
    const normalized = normalizeOrganization(affiliation.organization);
    const affiliationId = id('aff', `${pid}:${affiliation.type}:${normalized}:${affiliation.role_or_program || ''}`);
    run(s, 'INSERT OR IGNORE INTO profile_affiliations (id,profile_id,type,organization,normalized_organization,role_or_program,start_date,end_date,source,source_observation_ids_json,confidence,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
      affiliationId, pid, affiliation.type, affiliation.organization, normalized, affiliation.role_or_program,
      affiliation.start_date, affiliation.end_date, 'resume', '[]', affiliation.confidence, 'suggested', at, at
    ]);
  }
  audit(s, 'profile.created', 'profile', pid, { proofPointsImported: proofs.length, affiliationsSuggested: affiliations.length });
  syncProfile(s, pid);
  save(s);
  return {
    profile: one(s, 'SELECT * FROM profiles WHERE id=?', [pid]),
    created: true,
    nextActions: [
      `jobos profile network-intent --profile ${pid} --file <intent.json>`,
      `jobos network import --profile ${pid} --file <connections.csv>`,
      'Press b in the TUI to build your network map.'
    ]
  };
}
export function setNetworkIntent(s, { profileId, intent, affiliations }) {
  const profile = one(s, 'SELECT * FROM profiles WHERE id=?', [profileId]);
  if (!profile) throw Error(`Unknown profile: ${profileId}`);
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) throw Error('intent must be an object');
  if (intent.version !== 1) throw Error('intent.version must be 1');
  const validPersonas = new Set(['recruiter', 'hiring_manager', 'peer', 'executive', 'alumni']);
  const validTypes = new Set(['school', 'employer', 'community']);
  const validStatuses = new Set(['suggested', 'confirmed', 'rejected']);
  const normalizeList = values => [...new Set((Array.isArray(values) ? values : []).map(value => String(value).trim()).filter(Boolean))];
  if (intent.preferredPersonas && (!Array.isArray(intent.preferredPersonas) || !intent.preferredPersonas.every(value => validPersonas.has(value)))) {
    throw Error(`Invalid persona in preferredPersonas; allowed: ${[...validPersonas].join(', ')}`);
  }
  if (intent.allowedSources != null && (typeof intent.allowedSources !== 'object' || Array.isArray(intent.allowedSources))) {
    throw Error('intent.allowedSources must be an object');
  }
  const allowedSources = intent.allowedSources || {};
  const prefs = parseJson(profile.preferences_json, {});
  prefs.networkIntent = {
    version: 1,
    targetCompanies: normalizeList(intent.targetCompanies),
    targetRoles: normalizeList(intent.targetRoles),
    preferredPersonas: [...new Set(intent.preferredPersonas || [])],
    comfortableRelationshipTypes: normalizeList(intent.comfortableRelationshipTypes),
    exclusions: normalizeList(intent.exclusions),
    allowedSources: {
      publicWeb: allowedSources.publicWeb !== false,
      linkedinImport: Boolean(allowedSources.linkedinImport),
      xai: Boolean(allowedSources.xai)
    },
    completedAt: now()
  };
  if (affiliations !== undefined) {
    if (!Array.isArray(affiliations)) throw Error('affiliations must be an array');
    for (const affiliation of affiliations) {
      if (!affiliation?.type || !affiliation?.organization) throw Error('Each affiliation must have type and organization');
      if (!validTypes.has(affiliation.type)) throw Error(`Invalid affiliation type "${affiliation.type}"; allowed: ${[...validTypes].join(', ')}`);
      if (affiliation.status && !validStatuses.has(affiliation.status)) throw Error(`Invalid affiliation status: ${affiliation.status}`);
    }
    run(s, 'DELETE FROM profile_affiliations WHERE profile_id=?', [profileId]);
    const at = now();
    for (const affiliation of affiliations) {
      const status = affiliation.status || 'suggested';
      const normalized = normalizeOrganization(affiliation.organization);
      const affiliationId = id('aff', `${profileId}:${affiliation.type}:${normalized}:${affiliation.role_or_program || ''}`);
      run(s, 'INSERT INTO profile_affiliations (id,profile_id,type,organization,normalized_organization,role_or_program,start_date,end_date,source,source_observation_ids_json,confidence,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
        affiliationId, profileId, affiliation.type, affiliation.organization, normalized, affiliation.role_or_program || '',
        affiliation.start_date || null, affiliation.end_date || null, affiliation.source || 'onboarding', '[]',
        affiliation.confidence || 'medium', status, at, at
      ]);
    }
  }
  run(s, 'UPDATE profiles SET preferences_json=?,updated_at=? WHERE id=?', [JSON.stringify(prefs), now(), profileId]);
  audit(s, 'network_intent.set', 'profile', profileId, {
    personaCount: prefs.networkIntent.preferredPersonas.length,
    companyCount: prefs.networkIntent.targetCompanies.length,
    roleCount: prefs.networkIntent.targetRoles.length,
    relationshipTypeCount: prefs.networkIntent.comfortableRelationshipTypes.length,
    affiliationsReplaced: affiliations === undefined ? null : affiliations.length,
    affiliationTypes: [...new Set((affiliations || []).map(value => value.type))],
    allowedSources: prefs.networkIntent.allowedSources
  });
  syncProfile(s, profileId);
  save(s);
  return {
    profileId,
    networkIntent: prefs.networkIntent,
    affiliationsReplaced: affiliations === undefined ? null : affiliations.length
  };
}
export function addProof(s,pid,summary,evidence='',skills=[],metrics=[]){ if(!one(s,'SELECT id FROM profiles WHERE id=?',[pid])) throw Error(`Unknown profile: ${pid}`); const at=now(), proofId=id('proof',`${pid}:${summary}:${evidence}`); const meta={origin:'manual',claimType:'experience',requiresHumanVerification:false}; run(s,'INSERT OR IGNORE INTO proof_points (id,profile_id,summary,evidence,skills_json,metrics_json,source,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)',[proofId,pid,summary,evidence,JSON.stringify(skills),JSON.stringify(metrics.length?metrics:extractMetrics(summary)),'manual',JSON.stringify(meta),at]); audit(s,'proof_point.added','proof_point',proofId,{profileId:pid}); syncProfile(s,pid); save(s); return one(s,'SELECT * FROM proof_points WHERE id=?',[proofId]); }
export function listProofs(s,pid){ return all(s,'SELECT * FROM proof_points WHERE profile_id=? ORDER BY created_at',[pid]).map(p=>({...p,skills:parseJson(p.skills_json,[]),metrics:parseJson(p.metrics_json,[]),metadata:parseJson(p.metadata_json,{})})); }

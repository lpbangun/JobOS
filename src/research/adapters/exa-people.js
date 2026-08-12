import { extractEmails, isGenericInbox, isLinkedInProfileUrl, sourceAllowedForRecording, sourceObservationFromSearch } from '../sources.js';

export const name = 'exa-people';

const BASE_URL = 'https://api.exa.ai/search';

function queryList(context, plan) {
  const planned = (plan?.queries || []).map(value => String(value || '').trim()).filter(Boolean);
  if (planned.length) return planned;
  const person = context?.person?.name || '';
  const company = context?.companyName || '';
  const role = context?.role || '';
  const fallback = [person && `"${person}"`, [company, role].filter(Boolean).join(' ')].filter(Boolean);
  return fallback;
}

function resultText(result) {
  const highlights = Array.isArray(result?.highlights) ? result.highlights.join(' ') : '';
  const body = [result?.summary, result?.text, highlights].filter(Boolean).join(' ');
  return `${String(result?.title || '').trim()} — ${body}`.replace(/\s+/g, ' ').trim().slice(0, 12000);
}

function titleName(title) {
  const value = String(title || '').trim();
  const prefix = value.split(/\s+(?:[-–—|]|at)\s+/i)[0].trim();
  return /^\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+){1,4}$/u.test(prefix) ? prefix : '';
}

function currentWork(properties = {}) {
  const history = Array.isArray(properties.workHistory) ? properties.workHistory : [];
  return history.find(item => !item?.dates?.to) || history[0] || null;
}

function entityHints(data, observations, context) {
  const entities = Array.isArray(data?.entities) ? data.entities : [];
  const fallbackIds = observations.map(observation => observation.id);
  return entities.filter(entity => entity?.type === 'person' && entity?.properties?.name).map((entity) => {
    const properties = entity.properties;
    const work = currentWork(properties);
    const entityUrl = String(properties.url || entity.url || '').trim();
    return {
      name: properties.name,
      profileUrl: entityUrl && isLinkedInProfileUrl(entityUrl) ? entityUrl : '',
      company: work?.company?.name || context.companyName || '',
      role: work?.title || '',
      confidence: 'medium',
      source: 'exa_people',
      sourceObservationIds: fallbackIds,
      roleRelevance: 'medium'
    };
  }).filter(hint => hint.sourceObservationIds.length);
}

export async function run({ context, plan, budget, signal, env = process.env, fetchImpl = fetch }) {
  const observations = [];
  const personHints = [];
  const warnings = [];
  const usage = { queries: 0, sourceChars: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, paidToolCalls: 0, estimatedUsd: 0 };
  const apiKey = String(env.EXA_API_KEY || '').trim();
  if (!apiKey) {
    return { observations, personHints, usage, warnings: ['EXA_API_KEY is not configured'] };
  }
  const queries = queryList(context, plan).slice(0, Math.max(0, Number(budget.maxQueries ?? 8)));
  for (const query of queries) {
    if (signal?.aborted) break;
    let response;
    try {
      response = await fetchImpl(BASE_URL, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({
          query,
          type: 'auto',
          category: 'people',
          numResults: Math.max(1, Math.min(10, Number(budget.maxCandidates ?? 10))),
          contents: { text: { maxCharacters: 6000 }, highlights: { numSentences: 3 }, summary: true }
        })
      });
    } catch (error) {
      warnings.push(`request failed for "${query.slice(0, 60)}": ${error.message}`);
      continue;
    }
    usage.queries++;
    usage.paidToolCalls++;
    if (!response.ok) {
      warnings.push(`HTTP ${response.status} for "${query.slice(0, 60)}"`);
      continue;
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      warnings.push(`response parse failed for "${query.slice(0, 60)}": ${error.message}`);
      continue;
    }
    const queryObservations = [];
    for (const [index, result] of (data.results || []).entries()) {
      if (!sourceAllowedForRecording(result.url)) continue;
      const snippet = resultText(result);
      const candidateName = titleName(result.title);
      const emails = extractEmails(snippet);
      const observation = sourceObservationFromSearch(context, {
        ...result,
        snippet,
        query,
        rank: index + 1,
        provider: 'exa-people'
      });
      observation.metadata = {
        ...observation.metadata,
        exaResultId: result.id || null,
        publishedDate: result.publishedDate || null,
        discoveredContactTypes: emails.length ? ['email'] : [],
        emailContexts: emails.map(email => ({ email, name: isGenericInbox(email) ? '' : candidateName, context: snippet.slice(0, 300), generic: isGenericInbox(email) }))
      };
      observations.push(observation);
      queryObservations.push(observation);
      usage.sourceChars += snippet.length;
      if (candidateName) {
        personHints.push({
          name: candidateName,
          profileUrl: isLinkedInProfileUrl(result.url) ? result.url : '',
          company: context.companyName || '',
          role: '',
          email: emails[0] || '',
          confidence: 'low',
          source: 'exa_people',
          sourceObservationIds: [observation.id],
          roleRelevance: 'medium'
        });
      }
    }
    personHints.push(...entityHints(data, queryObservations, context));
    const totalCost = Number(data?.costDollars?.total);
    if (Number.isFinite(totalCost)) usage.estimatedUsd += totalCost;
  }
  return { observations, personHints, usage, warnings };
}

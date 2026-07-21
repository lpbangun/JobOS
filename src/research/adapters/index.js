import * as publicWeb from './public-web.js';
import * as github from './github.js';
import * as gdelt from './gdelt.js';
import * as wayback from './wayback.js';
import * as localNetwork from './local-network.js';
import * as linkedinImport from './linkedin-import.js';
import { xaiAdapter } from './xai.js';

// Adapter registry for research source adapters.
// Each adapter: { name: string, run({context,plan,budget,signal,env,fetchImpl}) -> {observations,personHints,usage,warnings} }
// Observations are source observation objects with at least url (or local identifier).
// personHints are { name, profileUrl?, company?, role?, sourceObservationIds[], relationshipType?, confidence?, roleRelevance?, freshnessDays?, sharedAffiliation? }
// usage is { queries, sourceChars, modelCalls, inputTokens, outputTokens, paidToolCalls, estimatedUsd }

const registry = new Map();

export function registerAdapter(adapter) {
  if (!adapter?.name || typeof adapter.run !== 'function') {
    throw new Error(`Invalid adapter: must have name and run function`);
  }
  registry.set(adapter.name, adapter);
}

export function getAdapter(name) {
  return registry.get(name) || null;
}

export function listAdapters() {
  return Array.from(registry.keys());
}

export function getAdapters(names) {
  return names.map(n => registry.get(n)).filter(Boolean);
}

for (const adapter of [
  publicWeb,
  github,
  gdelt,
  wayback,
  localNetwork,
  linkedinImport,
  xaiAdapter
]) registerAdapter(adapter);

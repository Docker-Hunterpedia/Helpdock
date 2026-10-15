import type { previewImportedContact } from './contact-plan.js';

type PlannedContact = Pick<
  Awaited<ReturnType<typeof previewImportedContact>>,
  'action' | 'contactId' | 'identifiers'
> & { externalId: string };

/** Do not let sequential writes implicitly combine two newly proposed source people. */
export function validateContactIdentityPlan(entries: readonly PlannedContact[]) {
  const identities = new Map<string, Map<string, Set<string>>>();
  for (const entry of entries) {
    // An unchanged receipt adds no identifiers, even if the local profile was edited after import.
    if (entry.action === 'unchanged') continue;
    const destination = entry.contactId ? `existing:${entry.contactId}` : `new:${entry.externalId}`;
    for (const identity of entry.identifiers) {
      const key = `${identity.kind}:${identity.value}`;
      const targets = identities.get(key) ?? new Map<string, Set<string>>();
      const sources = targets.get(destination) ?? new Set<string>();
      sources.add(entry.externalId);
      targets.set(destination, sources);
      identities.set(key, targets);
    }
  }
  const conflicted = new Set<string>();
  for (const targets of identities.values())
    if (targets.size > 1)
      for (const sources of targets.values()) for (const source of sources) conflicted.add(source);
  return entries
    .filter((entry) => conflicted.has(entry.externalId))
    .map((entry) => ({ externalId: entry.externalId, code: 'contact-plan-ambiguous' as const }));
}

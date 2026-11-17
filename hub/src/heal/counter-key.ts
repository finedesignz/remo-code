// hub/src/heal/counter-key.ts
//
// PTYCAP-07-01 (AM-F4-1, AM-F4-2): the one shared heal budget-key builder. Returns a plain
// string; only the future route module may attach it to a dispatch request. Prefix-compatible
// with POST /heal (heal:{userId}:), which is deliberately unchanged.

import { isCanonicalRepoIdent } from './repo-ident.ts';

export class HealKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HealKeyError';
  }
}

export function buildHealKey(userId: string, repoIdent: string | null | undefined): string {
  if (typeof userId !== 'string' || userId === '') throw new HealKeyError('heal key requires a user id');
  if (!isCanonicalRepoIdent(repoIdent)) {
    throw new HealKeyError(`heal key requires a canonical repo ident, got ${JSON.stringify(repoIdent ?? null)}`);
  }
  return `heal:${userId}:${repoIdent}`;
}

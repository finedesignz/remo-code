// hub/src/heal/repo-ident.ts
//
// PTYCAP-07-01 (AM-F2-2, AM-F4-1): server-derived canonical repo identities. Only these
// shapes may ever feed a budget key: github://owner/repo (lowercase, same normalization as
// the sessions.repo_key unique index) or path://<absolute dir>.

import { buildRepoKey, repoKeyFromGitRepository } from '../lib/repo-key.ts';

export interface RepoIdentSession {
  repo_key: string | null;
  github_owner: string | null;
  github_repo: string | null;
  project_dir: string | null;
  is_rootless: boolean;
}

const RE_GITHUB_IDENT = /^github:\/\/([^/\s]+)\/([^/\s]+)$/i;
const RE_ABS_PATH = /^(?:[A-Za-z]:[\\/]|\/)/;

/** Exactly github://owner/repo (lowercase) or path://<absolute>. */
export function isCanonicalRepoIdent(v: string | null | undefined): v is string {
  if (typeof v !== 'string') return false;
  const gh = v.match(/^github:\/\/([^/\s]+)\/([^/\s]+)$/);
  if (gh) return v === v.toLowerCase();
  if (v.startsWith('path://')) return RE_ABS_PATH.test(v.slice('path://'.length));
  return false;
}

export function canonicalRepoIdent(s: RepoIdentSession): string | null {
  if (s.is_rootless) return null;

  if (s.repo_key) {
    const m = s.repo_key.trim().match(RE_GITHUB_IDENT);
    if (m) return buildRepoKey({ owner: m[1]!, repo: m[2]! });
  }
  if (s.github_owner && s.github_repo) {
    return buildRepoKey({ owner: s.github_owner, repo: s.github_repo });
  }
  const dir = s.project_dir?.trim();
  if (dir && RE_ABS_PATH.test(dir)) {
    const normalized = dir.replace(/\\/g, '/').replace(/\/+$/, '');
    return normalized === '' ? null : `path://${normalized}`;
  }
  return null;
}

/** Coolify git_repository (URL forms or bare owner/repo) -> canonical github ident, else null. */
export function canonicalRepoIdentFromGit(gitRepository: string | null | undefined): string | null {
  return repoKeyFromGitRepository(gitRepository);
}

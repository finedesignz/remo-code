/**
 * PTYCAP-07-01 -- canonical repo identity derivation (AM-F2-2, AM-F4-1). DB-free.
 */
import { describe, test, expect } from 'bun:test'
import { canonicalRepoIdent, canonicalRepoIdentFromGit, isCanonicalRepoIdent } from '../src/heal/repo-ident.ts'

const none = { repo_key: null, github_owner: null, github_repo: null, project_dir: null, is_rootless: false }

describe('canonicalRepoIdent', () => {
  test('a mixed-case repo_key returns lowercase', () => {
    expect(canonicalRepoIdent({ ...none, repo_key: 'github://Owner/Repo' })).toBe('github://owner/repo')
  })
  test('falls back to github_owner + github_repo', () => {
    expect(canonicalRepoIdent({ ...none, github_owner: 'Acme', github_repo: 'App' })).toBe('github://acme/app')
  })
  test('falls back to an absolute project_dir (drive letter), backslashes normalized, trailing sep trimmed, case preserved', () => {
    expect(canonicalRepoIdent({ ...none, project_dir: 'C:\\Users\\Artic\\Work\\' })).toBe('path://C:/Users/Artic/Work')
  })
  test('absolute posix project_dir', () => {
    expect(canonicalRepoIdent({ ...none, project_dir: '/home/me/Proj/' })).toBe('path:///home/me/Proj')
  })
  test('a rootless session returns null even with a project_dir', () => {
    expect(canonicalRepoIdent({ ...none, repo_key: 'github://a/b', project_dir: '/x', is_rootless: true })).toBeNull()
  })
  test('nothing derivable returns null', () => {
    expect(canonicalRepoIdent(none)).toBeNull()
  })
  test('a relative project_dir returns null', () => {
    expect(canonicalRepoIdent({ ...none, project_dir: 'relative/dir' })).toBeNull()
  })
  test('a non-github repo_key is ignored in favour of the other sources', () => {
    expect(canonicalRepoIdent({ ...none, repo_key: 'gitlab://a/b', project_dir: '/p' })).toBe('path:///p')
  })
})

describe('canonicalRepoIdentFromGit', () => {
  test('ssh remote and bare slug both yield the lowercase github ident', () => {
    expect(canonicalRepoIdentFromGit('git@github.com:Acme/App.git')).toBe('github://acme/app')
    expect(canonicalRepoIdentFromGit('acme/app')).toBe('github://acme/app')
  })
  test('non-GitHub remote, empty, null -> null', () => {
    expect(canonicalRepoIdentFromGit('git@gitlab.com:a/b.git')).toBeNull()
    expect(canonicalRepoIdentFromGit('')).toBeNull()
    expect(canonicalRepoIdentFromGit(null)).toBeNull()
  })
})

describe('isCanonicalRepoIdent', () => {
  test('accepts exactly github://owner/repo and path://abs', () => {
    expect(isCanonicalRepoIdent('github://acme/app')).toBe(true)
    expect(isCanonicalRepoIdent('path:///home/x')).toBe(true)
    expect(isCanonicalRepoIdent('path://C:/Users/x')).toBe(true)
  })
  test('rejects everything else', () => {
    for (const bad of ['', 'null', 'acme/app', 'github://acme', 'github://acme/app/extra', 'github://Acme/App', 'path://rel/dir', 'path://', 'https://github.com/a/b']) {
      expect(isCanonicalRepoIdent(bad)).toBe(false)
    }
    expect(isCanonicalRepoIdent(null)).toBe(false)
  })
})

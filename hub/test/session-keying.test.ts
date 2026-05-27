// hub/test/session-keying.test.ts
//
// Phase 08 / Plan 001: parse-cases for the shared repo-key helper.
// Covers every case enumerated in ARCHITECTURE.md §11.

import { describe, test, expect } from 'bun:test'
import { parseGitRemote, buildRepoKey } from '../src/lib/repo-key'

describe('parseGitRemote', () => {
  test('SSH GitHub remote with .git suffix', () => {
    expect(parseGitRemote('git@github.com:Owner/Repo.git')).toEqual({ owner: 'owner', repo: 'repo' })
  })

  test('HTTPS GitHub remote with trailing slash', () => {
    expect(parseGitRemote('https://github.com/Owner/Repo/')).toEqual({ owner: 'owner', repo: 'repo' })
  })

  test('HTTPS GitHub remote without trailing slash', () => {
    expect(parseGitRemote('https://github.com/Owner/Repo')).toEqual({ owner: 'owner', repo: 'repo' })
  })

  test('ssh:// protocol GitHub remote', () => {
    expect(parseGitRemote('ssh://git@github.com/Owner/Repo')).toEqual({ owner: 'owner', repo: 'repo' })
  })

  test('ssh:// protocol GitHub remote with .git', () => {
    expect(parseGitRemote('ssh://git@github.com/Owner/Repo.git')).toEqual({ owner: 'owner', repo: 'repo' })
  })

  test('GitLab SSH remote returns null', () => {
    expect(parseGitRemote('git@gitlab.com:foo/bar.git')).toBeNull()
  })

  test('Bitbucket HTTPS remote returns null', () => {
    expect(parseGitRemote('https://bitbucket.org/foo/bar.git')).toBeNull()
  })

  test('empty string returns null', () => {
    expect(parseGitRemote('')).toBeNull()
  })

  test('whitespace-only returns null', () => {
    expect(parseGitRemote('   ')).toBeNull()
  })

  test('null returns null', () => {
    expect(parseGitRemote(null)).toBeNull()
  })

  test('undefined returns null', () => {
    expect(parseGitRemote(undefined)).toBeNull()
  })

  test('garbage returns null', () => {
    expect(parseGitRemote('not a url at all')).toBeNull()
  })

  test('host case-insensitive (GITHUB.COM)', () => {
    expect(parseGitRemote('git@GITHUB.COM:Foo/Bar.git')).toEqual({ owner: 'foo', repo: 'bar' })
  })

  test('repo names with hyphens and dots', () => {
    expect(parseGitRemote('git@github.com:Foo-Org/my.repo-name.git')).toEqual({
      owner: 'foo-org',
      repo: 'my.repo-name',
    })
  })
})

describe('buildRepoKey', () => {
  test('lowercases owner + repo', () => {
    expect(buildRepoKey({ owner: 'Foo', repo: 'Bar' })).toBe('github://foo/bar')
  })

  test('already-lowercase input', () => {
    expect(buildRepoKey({ owner: 'acme', repo: 'widget' })).toBe('github://acme/widget')
  })
})

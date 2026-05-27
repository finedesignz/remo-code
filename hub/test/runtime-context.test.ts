import { describe, it, expect } from 'bun:test'
import { detectProjectType } from '../src/scheduler/context/project-type'
import { renderRuntimeContextBlock } from '../src/scheduler/context/runtime-context'

describe('detectProjectType', () => {
  it('tauri.conf.json wins over next/vite + Dockerfile', () => {
    expect(detectProjectType([
      'tauri.conf.json',
      'package.json:{"dependencies":{"next":"14"}}',
      'Dockerfile',
    ])).toBe('tauri')
  })

  it('package.json with next -> web-app', () => {
    expect(detectProjectType(['package.json:{"dependencies":{"next":"14"}}'])).toBe('web-app')
  })

  it('package.json with hono -> api', () => {
    expect(detectProjectType(['package.json:{"dependencies":{"hono":"^4"}}'])).toBe('api')
  })

  it('Dockerfile only -> service', () => {
    expect(detectProjectType(['Dockerfile'])).toBe('service')
  })

  it('empty -> unknown', () => {
    expect(detectProjectType([])).toBe('unknown')
  })
})

describe('renderRuntimeContextBlock', () => {
  it('skips null/undefined fields', () => {
    const txt = renderRuntimeContextBlock({
      project_type: 'tauri',
      repo: 'finedesignz/remo-code',
      branch: null,
      last_commit_sha: undefined,
      design_preferences: 'orange-accent-subtle-borderless',
    })
    expect(txt).toContain('## RUNTIME CONTEXT')
    expect(txt).toContain('- project_type: tauri')
    expect(txt).toContain('- repo: finedesignz/remo-code')
    expect(txt).toContain('- design_preferences: orange-accent-subtle-borderless')
    expect(txt).not.toContain('branch')
    expect(txt).not.toContain('last_commit_sha')
  })

  it('header-only when ctx is empty', () => {
    expect(renderRuntimeContextBlock({})).toBe('## RUNTIME CONTEXT')
  })
})

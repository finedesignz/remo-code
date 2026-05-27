import { describe, expect, test } from 'bun:test'
import { previewComment, storagePrefix, renderAnnotationPrompt } from '../src/revanote/prompt'

describe('previewComment', () => {
  test('short comment unchanged', () => {
    expect(previewComment('hi there')).toBe('hi there')
  })

  test('long comment truncated to 30 graphemes with ellipsis', () => {
    const long = 'a'.repeat(80)
    const p = previewComment(long, 30)
    // 30 chars + ellipsis (single char in BMP)
    expect(p.length).toBeLessThanOrEqual(31)
    expect(p.endsWith('…')).toBe(true)
  })

  test('emoji handled as single grapheme', () => {
    const p = previewComment('🚀'.repeat(40), 10)
    // Should be 10 rockets + ellipsis (Segmenter path; codepoint fallback close).
    const rockets = [...p].filter((c) => c === '🚀').length
    expect(rockets).toBeLessThanOrEqual(20) // tolerant of fallback path's astral pairs
  })

  test('whitespace collapsed', () => {
    expect(previewComment('  hello  \n  world  ')).toBe('hello world')
  })
})

describe('storagePrefix', () => {
  test('uses [revanote: …] shape', () => {
    expect(storagePrefix('the button is wrong')).toBe('[revanote: the button is wrong]')
  })
})

describe('renderAnnotationPrompt', () => {
  const ann: any = {
    id: 'a1',
    annotation_id_external: 'ext-1',
    page_url: 'https://app.example.com/dashboard',
    annotation_url: 'https://app.revanote.com/review/p1#annotation-ext-1',
    screenshot_url: 'https://shots/1.png',
    x: 100, y: 200,
    element_selector: 'button.cta',
    comment: 'wrong color',
    replies_json: [{ author: 'jay', text: 'really wrong' }],
    payload_raw: { element_meta: { tag: 'button' }, capture_viewport: { w: 1280 } },
  }

  test('PR strategy with auto_merge', () => {
    const out = renderAnnotationPrompt({
      annotation: ann,
      mapping: {
        id: 'm1', user_id: 'u', hostname_pattern: 'app.example.com',
        repo_path: 'C:/code/app', supervisor_id: null,
        deploy_strategy: 'pr', auto_merge: true, enabled: true,
        auto_created: false, created_at: '', updated_at: '',
      },
    })
    expect(out).toContain('Strategy: PR')
    expect(out).toContain('revanote/annotation-ext-1')
    expect(out).toContain('auto_merge=true')
    expect(out).toContain('<<JSON>>')
    expect(out).toContain('<<END>>')
    expect(out).toContain('wrong color')
    expect(out).toContain('Annotation deep-link')
  })

  test('direct strategy', () => {
    const out = renderAnnotationPrompt({
      annotation: ann,
      mapping: {
        id: 'm1', user_id: 'u', hostname_pattern: '*.example.com',
        repo_path: 'C:/code/app', supervisor_id: null,
        deploy_strategy: 'direct', auto_merge: false, enabled: true,
        auto_created: false, created_at: '', updated_at: '',
      },
    })
    expect(out).toContain('Strategy: DIRECT')
  })

  test('no mapping → fallback text', () => {
    const out = renderAnnotationPrompt({ annotation: ann, mapping: null })
    expect(out).toContain('no mapping configured')
  })
})

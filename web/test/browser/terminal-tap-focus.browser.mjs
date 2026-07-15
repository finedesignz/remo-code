/**
 * REAL-BROWSER verification (Playwright + installed Chromium) for
 * fix/mobile-tap-focus. Drives GENUINE touchstart/touchmove/touchend + mousedown
 * against the real TerminalSurface gesture handler in an iPhone-emulation (touch)
 * context and asserts xterm textarea focus state:
 *   (a) TAP  → terminal textarea IS focused (keyboard summons)
 *   (b) DRAG → terminal textarea NOT focused (scroll, no keyboard)
 *   (c) ⌨ toggle → focuses, pressed again → blurs
 *   (d) desktop mouse click (non-touch context) → focuses (#375 preserved)
 * Screenshots written to web/test/browser/shots/.
 */
import { chromium, devices } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
mkdirSync(SHOTS, { recursive: true })
const URL = 'http://localhost:5173/terminal-harness.html'
const EXE = 'C:/Users/artic/AppData/Local/ms-playwright/chromium-1187/chrome-win/chrome.exe'

const results = []
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra })
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`)
}

// Focus state of xterm's helper textarea, read in-page.
const focusState = (page) => page.evaluate(() => {
  const ta = document.querySelector('.xterm-helper-textarea')
  return { present: !!ta, focused: !!ta && document.activeElement === ta,
           active: document.activeElement?.className || '(none)' }
})

// Dispatch a REAL touch sequence on the xterm host via CDP-backed Touchscreen is
// awkward for taps vs drags with slop; we synthesize Touch events with correct
// coordinates through the page (still real DOM TouchEvents in Chromium, dispatched
// on the actual element the prod handler is bound to).
async function gesture(page, kind) {
  return page.evaluate((kind) => {
    const host = document.querySelector('.xterm')?.parentElement
      || document.querySelector('#root > div > div:last-child')
    // The host is the div with the touch listeners: the LAST child of the surface.
    const surface = document.querySelector('#root > div > div')
    const target = surface ? surface.lastElementChild : host
    const r = target.getBoundingClientRect()
    const cx = Math.round(r.left + r.width / 2)
    const cy = Math.round(r.top + r.height / 2)
    const mk = (type, x, y) => {
      const t = new Touch({ identifier: 1, target, clientX: x, clientY: y })
      return new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t] })
    }
    if (kind === 'tap') {
      target.dispatchEvent(mk('touchstart', cx, cy))
      target.dispatchEvent(mk('touchend', cx, cy))
    } else if (kind === 'drag') {
      target.dispatchEvent(mk('touchstart', cx, cy))
      target.dispatchEvent(mk('touchmove', cx, cy - 120)) // >10px slop
      target.dispatchEvent(mk('touchmove', cx, cy - 200))
      target.dispatchEvent(mk('touchend', cx, cy - 200))
    }
    return { cx, cy, tag: target.tagName, cls: target.className }
  }, kind)
}

const browser = await chromium.launch({ executablePath: EXE })
try {
  // ---- Touch context (iPhone emulation) for (a),(b),(c) ----
  const iPhone = devices['iPhone 14 Pro Max']
  const tctx = await browser.newContext({ ...iPhone })
  const tpage = await tctx.newPage()
  await tpage.goto(URL, { waitUntil: 'networkidle' })
  await tpage.waitForSelector('.xterm-helper-textarea', { state: 'attached', timeout: 10000 })
  // Ensure nothing is focused to start (blur any autofocus).
  await tpage.evaluate(() => document.activeElement?.blur?.())

  // (b) DRAG first (so a prior focus can't mask it) → NOT focused
  await gesture(tpage, 'drag')
  await tpage.waitForTimeout(150)
  let s = await focusState(tpage)
  ok('(b) DRAG does NOT focus terminal (scroll, no keyboard)', s.present && !s.focused, `active=${s.active}`)
  await tpage.screenshot({ path: join(SHOTS, 'b-drag-no-focus.png') })

  // (a) TAP → focused
  await gesture(tpage, 'tap')
  await tpage.waitForTimeout(150)
  s = await focusState(tpage)
  ok('(a) TAP focuses terminal textarea (keyboard summons)', s.present && s.focused, `active=${s.active}`)
  await tpage.screenshot({ path: join(SHOTS, 'a-tap-focus.png') })

  // (c) ⌨ toggle: currently open (tap focused). Press → should blur; press → focus.
  const toggle = tpage.locator('[data-testid="kb-toggle"]')
  // blur first via toggle OFF (aria-pressed currently reflects kbOpen state from tap)
  const pressedAfterTap = await toggle.getAttribute('aria-pressed')
  await toggle.click(); await tpage.waitForTimeout(120)
  const s1 = await focusState(tpage)
  await toggle.click(); await tpage.waitForTimeout(120)
  const s2 = await focusState(tpage)
  // One of the two clicks focuses, the other blurs — assert toggle changes focus both ways.
  ok('(c) ⌨ toggle summons AND dismisses (focus flips each press)',
     s1.focused !== s2.focused, `afterTapPressed=${pressedAfterTap} s1.focused=${s1.focused} s2.focused=${s2.focused}`)
  // Explicit: end with a known ON press and assert focused
  const finalPressed = await toggle.getAttribute('aria-pressed')
  if (finalPressed !== 'true') { await toggle.click(); await tpage.waitForTimeout(120) }
  const s3 = await focusState(tpage)
  ok('(c2) ⌨ toggle ON → textarea focused', s3.focused, `active=${s3.active}`)
  await tpage.screenshot({ path: join(SHOTS, 'c-kbtoggle.png') })
  await tctx.close()

  // ---- Desktop (non-touch) context for (d) ----
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: false })
  const dpage = await dctx.newPage()
  await dpage.goto(URL, { waitUntil: 'networkidle' })
  await dpage.waitForSelector('.xterm-helper-textarea', { state: 'attached', timeout: 10000 })
  await dpage.evaluate(() => document.activeElement?.blur?.())
  let ds = await focusState(dpage)
  const beforeClick = ds.focused
  // Real mouse click on the terminal host (mousedown handler → focusTerm).
  await dpage.evaluate(() => {
    const surface = document.querySelector('#root > div > div')
    const target = surface.lastElementChild
    const r = target.getBoundingClientRect()
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }))
  })
  await dpage.waitForTimeout(120)
  ds = await focusState(dpage)
  ok('(d) DESKTOP mouse click focuses terminal (#375 preserved)', !beforeClick && ds.focused, `active=${ds.active}`)
  await dpage.screenshot({ path: join(SHOTS, 'd-desktop-click-focus.png') })
  await dctx.close()
} finally {
  await browser.close()
}

const failed = results.filter(r => !r.pass)
console.log(`\n=== ${results.length - failed.length}/${results.length} browser assertions passed ===`)
process.exit(failed.length ? 1 : 0)

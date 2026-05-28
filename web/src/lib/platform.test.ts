/// <reference lib="dom" />
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { isMobileApp, platform, appVersion } from './platform'

const w = globalThis as unknown as {
  window?: any
  navigator?: any
}

function setTauri(present: boolean) {
  if (!w.window) w.window = {}
  if (present) w.window.__TAURI_INTERNALS__ = {}
  else delete w.window.__TAURI_INTERNALS__
}

function setUA(ua: string) {
  if (!w.navigator) w.navigator = {}
  w.navigator.userAgent = ua
}

function setVersion(v: string | undefined) {
  if (!w.window) w.window = {}
  if (v === undefined) delete w.window.__REMO_APP_VERSION__
  else w.window.__REMO_APP_VERSION__ = v
}

describe('platform shim', () => {
  beforeEach(() => {
    // Establish window/navigator if bun:test doesn't already provide a DOM.
    if (!w.window) w.window = {}
    if (!w.navigator) w.navigator = { userAgent: '' }
    setTauri(false)
    setUA('')
    setVersion(undefined)
  })

  afterEach(() => {
    setTauri(false)
    setVersion(undefined)
  })

  test('isMobileApp() is false in plain browser', () => {
    expect(isMobileApp()).toBe(false)
  })

  test('isMobileApp() is true when __TAURI_INTERNALS__ present', () => {
    setTauri(true)
    expect(isMobileApp()).toBe(true)
  })

  test('platform() returns web when not in Tauri, regardless of UA', () => {
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
    expect(platform()).toBe('web')
  })

  test('platform() returns ios for iPhone UA inside Tauri', () => {
    setTauri(true)
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15')
    expect(platform()).toBe('ios')
  })

  test('platform() returns android for Android UA inside Tauri', () => {
    setTauri(true)
    setUA('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36')
    expect(platform()).toBe('android')
  })

  test('appVersion() is null without injected global', () => {
    expect(appVersion()).toBeNull()
  })

  test('appVersion() returns injected string', () => {
    setVersion('1.2.3')
    expect(appVersion()).toBe('1.2.3')
  })

  test('appVersion() treats empty string as null', () => {
    setVersion('')
    expect(appVersion()).toBeNull()
  })
})

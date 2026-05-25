/**
 * createRafBatcher
 *
 * Coalesces a stream of values into a single flush per animation frame.
 * Use for high-frequency events (e.g. `text_delta`) where one React state
 * update per event would thrash the render loop.
 *
 * Usage:
 *   const batcher = createRafBatcher<string>((batch) => {
 *     // batch is an array of pushed values, in order
 *     setMessages(prev => applyDeltas(prev, batch))
 *   })
 *   batcher.push('hello')
 *   batcher.push(' world')
 *   // ...one frame later, flush() runs once with ['hello', ' world']
 *
 * On environments without `requestAnimationFrame` (SSR, tests),
 * falls back to `setTimeout(0)`.
 */
export interface RafBatcher<T> {
  push: (item: T) => void
  cancel: () => void
  /** Drains the queue synchronously. Mostly for tests. */
  flushSync: () => void
}

type Schedule = (cb: () => void) => number
type Unschedule = (id: number) => void

const hasRaf = typeof globalThis !== 'undefined'
  && typeof (globalThis as any).requestAnimationFrame === 'function'

const schedule: Schedule = hasRaf
  ? (cb) => (globalThis as any).requestAnimationFrame(cb)
  : (cb) => (setTimeout(cb, 0) as unknown as number)

const unschedule: Unschedule = hasRaf
  ? (id) => (globalThis as any).cancelAnimationFrame(id)
  : (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>)

export function createRafBatcher<T>(flush: (batch: T[]) => void): RafBatcher<T> {
  let pending: T[] = []
  let scheduled: number | null = null

  const drain = () => {
    scheduled = null
    if (pending.length === 0) return
    const batch = pending
    pending = []
    flush(batch)
  }

  return {
    push(item: T) {
      pending.push(item)
      if (scheduled === null) {
        scheduled = schedule(drain)
      }
    },
    cancel() {
      if (scheduled !== null) {
        unschedule(scheduled)
        scheduled = null
      }
      pending = []
    },
    flushSync() {
      if (scheduled !== null) {
        unschedule(scheduled)
        scheduled = null
      }
      drain()
    },
  }
}

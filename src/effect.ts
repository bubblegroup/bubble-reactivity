import { Computation, type MemoOptions } from './core'
import { STATE_CLEAN, STATE_DISPOSED } from './constants'
import type { Owner } from './owner'
import { handleError } from './owner'

let scheduledEffects = false
let runningEffects = false
let effects: Effect[] = []

/**
 * By default, changes are batched on the microtask queue which is an async process. You can flush the queue
 * synchronously to get the latest updates by calling `flushSync()`.
 */
export function flushSync(): void {
  if (!runningEffects) runEffects()
}

function flushEffects() {
  scheduledEffects = true
  queueMicrotask(runEffects)
}

/**
 * When re-executing nodes, we want to be extra careful to avoid double execution of nested owners
 * In particular, it is important that we check all of our parents to see if they will rerun
 * See tests/createEffect: "should run parent effect before child effect" and "should run parent memo before child effect"
 */
function runTop(node: Computation): void {
  const ancestors: Computation[] = []

  for (
    let current: Owner | null = node;
    current !== null;
    current = current._parent
  ) {
    if (current._state !== STATE_CLEAN) {
      ancestors.push(current as Computation)
    }
  }

  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (ancestors[i]._state !== STATE_DISPOSED)
      ancestors[i]._updateIfNecessary()
  }
}

function runEffects() {
  if (!effects.length) {
    scheduledEffects = false
    return
  }

  runningEffects = true

  try {
    for (let i = 0; i < effects.length; i++) {
      if (effects[i]._state !== STATE_CLEAN) {
        runTop(effects[i])
      }
    }
  } finally {
    effects = []
    scheduledEffects = false
    runningEffects = false
  }
}

/**
 * Effects are the leaf nodes of our reactive graph. When their sources change, they are automatically
 * added to the queue of effects to re-execute, which will cause them to fetch their sources and recompute
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class Effect<T = any> extends Computation<T> {
  constructor(initialValue: T, compute: () => T, options?: MemoOptions<T>) {
    super(initialValue, compute, options)
    effects.push(this)
  }

  override _notify(state: number): void {
    if (this._state >= state) return

    if (this._state === STATE_CLEAN) {
      effects.push(this)
      if (!scheduledEffects) flushEffects()
    }

    this._state = state
  }

  override write(value: T): T {
    this._value = value

    return value
  }

  override _setError(error: unknown): void {
    handleError(this, error)
  }
}

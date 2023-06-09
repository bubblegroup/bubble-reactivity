import { Computation, compute } from "./core";
import { Effect, batch } from "./effect";
import { HANDLER, Owner, handleError } from "./owner";
import type { MemoOptions, SignalOptions } from "./core";

export type Accessor<T> = () => T;
export type Setter<T> = (value: T) => T;
export type Signal<T> = [read: Accessor<T>, write: Setter<T>];

/**
 * Wraps the given value into a signal. The signal will return the current value when invoked
 * `fn()`, and provide a simple write API via `write()`. The value can now be observed
 * when used inside other computations created with `computed` and `effect`.
 */
export function createSignal<T>(
  initialValue: T,
  options?: SignalOptions<T>
): Signal<T> {
  const node = new Computation(initialValue, null, options);
  return [
    () => node.read(),
    (v) => {
      batch(() => {
        node.write(v);
      });
      return v;
    },
  ];
}

/**
 * Creates a new computation whose value is computed and returned by the given function. The given
 * compute function is _only_ re-run when one of it's dependencies are updated. Dependencies are
 * are all signals that are read during execution.
 */
export function createMemo<T>(
  compute: () => T,
  initialValue?: T,
  options?: MemoOptions<T>
): Accessor<T> {
  const node = new Computation(initialValue, compute, options);
  return () => node.read();
}

/**
 * Invokes the given function each time any of the signals that are read inside are updated
 * (i.e., their value changes). The effect is immediately invoked on initialization.
 */
export function createEffect<T>(
  effect: () => T,
  initialValue?: T,
  options?: { name?: string }
): void {
  void new Effect(
    initialValue,
    effect,
    __DEV__ ? { name: options?.name ?? "effect" } : undefined
  );
}

/**
 * Creates a computation root which is given a `dispose()` function to dispose of all inner
 * computations.
 */
export function createRoot<T>(
  init: ((dispose: () => void) => T) | (() => T)
): T {
  const owner = new Owner();
  return compute(
    owner,
    !init.length ? (init as () => T) : () => init(() => owner.dispose()),
    null
  );
}

/**
 * Runs the given function in the given owner so that error handling and cleanups continue to work.
 *
 * Warning: Usually there are simpler ways of modeling a problem that avoid using this function
 */
export function runWithOwner<T>(
  owner: Owner | null,
  run: () => T
): T | undefined {
  try {
    return compute(owner, run, null);
  } catch (error) {
    handleError(owner, error);
    return undefined;
  }
}

/**
 * Runs the given function when an error is thrown in a child owner. If the error is thrown again
 * inside the error handler, it will trigger the next available parent owner handler.
 */
export function catchError<T, U = Error>(
  fn: () => T,
  handler: (error: U) => void
): void {
  const owner = new Owner();
  owner._context = { [HANDLER]: handler };
  try {
    compute(owner, fn, null);
  } catch (error) {
    handleError(owner, error);
  }
}

export { untrack } from "./core";
export { onCleanup, getOwner } from "./owner";
export { flushSync, batch } from "./effect";

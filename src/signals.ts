import { update, Computation } from "./core";
import type { MemoOptions, Accessor, SignalOptions, Signal } from "./types";

/**
 * Wraps the given value into a signal. The signal will return the current value when invoked
 * `fn()`, and provide a simple write API via `set()`. The value can now be observed
 * when used inside other computations created with `computed` and `effect`.
 *
 * @see {@link https://github.com/solidjs/x-reactivity#createsignal}
 */
export function createSignal<T>(
  initialValue: T,
  options?: SignalOptions<T>
): Signal<T> {
  const node = new Computation(initialValue, null, options);
  return [() => node.read(), (v) => node.write(v)];
}

/**
 * Creates a new signal whose value is computed and returned by the given function. The given
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
  const node = new Computation(
    initialValue,
    effect,
    __DEV__ ? { name: options?.name ?? "effect" } : void 0
  );

  node._effect = true;
  update(node);
}

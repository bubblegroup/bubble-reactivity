/* eslint-disable */

import { Effect, batch } from "./effect";
import { STATE_DIRTY, STATE_DISPOSED } from "./constants";
import { Computation } from "./core";
import { runWithOwner } from "./index";

export class Autorun extends Effect {
  _paused = false;
  _ancestor_paused = false;
  _cleanup: (() => void) | undefined;
  _run_once: boolean;

  constructor(
    fn: () => void,
    cleanup?: (() => void) | undefined,
    run_once = false
  ) {
    super(undefined, fn);
    this._cleanup = cleanup;
    this._run_once = run_once;
  }
  invalidate() {
    if (this._run_once) return;
    batch(() => {
      this._notify(STATE_DIRTY);
      this._updateIfNecessary();
    });
  }
  destroy() {
    this.dispose(true);
  }

  pause() {
    this._paused = true;
    this.notify_pause(true);
  }

  notify_pause(pause: boolean) {
    let current = this._nextSibling as Computation | null;

    while (current && current._parent === this) {
      if (current instanceof Autorun) {
        if (!current._paused && current._ancestor_paused && !pause) {
          current._ancestor_paused = false;
          current._updateIfNecessary();
        } else {
          current._ancestor_paused = pause;
        }
        if (current._paused != pause) {
          current.notify_pause(pause);
        }
      }
      
      current = current._nextSibling as Computation;
    }
  }

  unpause() {
    this._paused = false;
    if (this._ancestor_paused) return;

    this.notify_pause(false);
    this._updateIfNecessary();
  }

  _updateIfNecessary(): void {
    if (this._paused || this._ancestor_paused) return;
    super._updateIfNecessary();
  }

  dispose(self = true) {
    if (this._state == STATE_DISPOSED) return;
    if (this._cleanup && self) this._cleanup();
    super.dispose(self);
  }
  set_run_immediately() {}
  alive() {}
  run_me() {
    this._updateIfNecessary();
    return this;
  }
  destroy_subs() {}
  add_sub() {}
  stop_tracking() {}

  get _is_destroyed() {
    return this._state == STATE_DISPOSED;
  }
}

export class Box<T> extends Computation {
  constructor(value: T) {
    super(value, null);
  }
  set(v: T) {
    batch(() => {
      this.write(v);
    });
  }
  get(): T {
    return this.read();
  }
}

export class Watcher extends Computation {
  constructor(fn: { fn: () => void }) {
    super(undefined, fn.fn);
  }
  get() {
    return this.wait();
  }
}

export function autorun_top(fn: () => void) {
  return runWithOwner(null, () => fn());
}

interface AutorunOptions {
  do: () => void;
  while?: () => boolean;
  finally?: () => void;
}

export function autorun(fn: () => void, cleanup?: () => void): Autorun;
export function autorun(options: AutorunOptions): Autorun;
export function autorun(
  fn_or_options: (() => void) | AutorunOptions,
  cleanup_or_empty?: () => void
): Autorun {
  const options =
    typeof fn_or_options === "object"
      ? fn_or_options
      : {
          do: fn_or_options,
          while: undefined,
          finally: cleanup_or_empty,
        };

  let { do: do_fn, while: while_fn, finally: finally_fn } = options;

  if (!while_fn) {
    return new Autorun(do_fn, finally_fn).run_me();
  } else {
    return conditional_autorun(do_fn, while_fn, finally_fn);
  }
}

function conditional_autorun(
  do_fn: () => void,
  while_fn: () => boolean,
  finally_fn?: (() => void) | undefined
): Autorun {
  return batch(() => {
    const run = new Autorun(do_fn, () => {
      finally_fn?.();
      pauser.destroy();
    });

    const pauser = new Autorun(() => {
      if (while_fn()) {
        run.unpause();
      } else {
        run.pause();
      }
    }).run_me();

    return run;
  });
}

export class Switch extends Computation<boolean> {
  name: string;
  _destroyed: boolean;
  _resolve: ((v: boolean) => void) | undefined;
  _promise: Promise<boolean> = new Promise((resolve) => {
    this._resolve = resolve;
  });

  constructor(name: string) {
    super(false, null);
    this.name = name;
    this._destroyed = false;
  }

  is_turned(): boolean {
    return this._value!;
  }

  is_dead(): boolean {
    return this._destroyed;
  }

  max_expected_time(): number | null {
    return null;
  }

  turn_off(): void {
    if (!this._value) {
      return;
    }

    batch(() => {
      this.write(false);
      this._promise = new Promise((resolve) => {
        this._resolve = resolve;
      });
    });
    // this._was_updated()
  }

  turn_on(): void {
    if (this._value) {
      return;
    }
    batch(() => {
      this.write(true);
      this._resolve!(true);
    });
    // this._was_updated()
  }

  // Indicates that the switch is permanently turned and no longer needed
  destroy(): void {
    this._destroyed = true;
    if (!this._value) {
      this.turn_on();
    } else {
      this.dispose(true);
    }
  }

  promise(): boolean {
    return this.wait();
  }
}

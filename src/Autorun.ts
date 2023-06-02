/* eslint-disable */

import { Effect, flushSync } from "./effect";
import { STATE_DIRTY, STATE_DISPOSED } from "./constants";
import { Computation } from "./core";
import { runWithOwner } from "./index";

export class Autorun extends Effect {
  _paused = false;
  _cleanup: (() => void) | undefined;;
  constructor(
    fn: () => void,
    cleanup?: (() => void) | undefined,
    run_once = false
  ) {
    super(undefined, fn);
    this._cleanup = cleanup;
    flushSync();
  }
  invalidate() {
    this._notify(STATE_DIRTY);
    if(!this._paused) flushSync();
  }
  destroy() {
    this.dispose(true);
  }
  pause() {
    this._paused = true;
  }
  unpause() {
    this._paused = false;
    this._updateIfNecessary();
  }

  emptyDisposal(): void {
    this._cleanup?.();
    super.emptyDisposal();
  }
  set_run_immediately() {}
  alive() {}
  run_me() {
    return this;
  }
  destroy_subs() {}
  add_sub() {}
  stop_tracking() {}

  get _is_destroyed() {
    return this._state == STATE_DISPOSED;
  }
}

export class Box<T> {
  value: T;
  constructor(value: T) {
    this.value = value;
  }
  set(v: T) {
    this.value = v;
  }
  get(): boolean {
    return false;
  }
}

export class Watcher {
  x: Computation;
  constructor(fn: { fn: () => void }, something: boolean) {
    this.x = new Computation(undefined, fn.fn);
  }
  get() {
    return this.x.read();
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
    return new Autorun(do_fn, finally_fn);
  } else {
    return conditional_autorun(do_fn, while_fn, finally_fn);
  }
}

function conditional_autorun(
  do_fn: () => void,
  while_fn: () => boolean,
  finally_fn?: (() => void) | undefined
): Autorun {
  let has_ever_run = false;

  const run = new Autorun(do_fn, () => {
    finally_fn?.();
    pauser.destroy();
  });

  const pauser = new Autorun(() => {
    if (while_fn()) {
      run.unpause();
      if (!has_ever_run) {
        has_ever_run = true;
        run.run_me();
      }
    } else {
      run.pause();
    }
  }).run_me();

  return run;
}

export class Switch {
  name: string;
  _turned: boolean;
  _destroyed: boolean;

  constructor(name: string) {
    this.name = name;
    this._turned = false;
    this._destroyed = false;
  }

  is_turned(): boolean {
    return this._turned;
  }

  is_dead(): boolean {
    return this._destroyed;
  }

  max_expected_time(): number | null {
    return null;
  }

  turn_off(): void {
    if (!this._turned) {
      return;
    }

    this._turned = false;
    // this._was_updated()
  }

  turn_on(): void {
    if (this._turned) {
      return;
    }
    this._turned = true;
    // this._was_updated()
  }

  // Indicates that the switch is permanently turned and no longer needed
  destroy(): void {
    this._destroyed = true;
    if (!this._turned) {
      this.turn_on();
    } else {
      // this._update_dead()
    }
  }
}

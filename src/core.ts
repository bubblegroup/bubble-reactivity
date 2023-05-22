import type {
  Callable,
  MemoOptions,
  Dispose,
  MaybeDisposable,
  Disposable,
  ContextRecord,
} from "./types";

let scheduledEffects = false,
  runningEffects = false,
  currentOwner: Owner | null = null,
  currentObserver: Computation | null = null,
  newSources: Computation[] | null = null,
  memoLoading = false,
  newSourcesIndex = 0,
  effects: Computation[] = [];

const HANDLER = Symbol(__DEV__ ? "ERROR_HANDLER" : 0),
  // For more information about this graph tracking scheme see Reactively:
  // https://github.com/modderme123/reactively/blob/main/packages/core/src/core.ts#L21
  STATE_CLEAN = 0,
  STATE_CHECK = 1,
  STATE_DIRTY = 2,
  STATE_DISPOSED = 3;

function flushEffects() {
  scheduledEffects = true;
  queueMicrotask(runEffects);
}

/**
 * When reexecuting nodes, we want to be extra careful to avoid double execution of nested owners
 * In particular, it is important that we check all of our parents to see if they will rerun
 * See tests/createEffect: "should run parent effect before child effect"
 */
function runTop(node: Computation<any>) {
  let ancestors = [node];
  while ((node = node._parent as Computation<any>)) {
    if (node._state !== STATE_CLEAN) {
      ancestors.push(node);
    }
  }
  for (let i = ancestors.length - 1; i >= 0; i--) {
    updateIfNecessary(ancestors[i]);
  }
}

function runEffects() {
  if (!effects.length) {
    scheduledEffects = false;
    return;
  }

  runningEffects = true;

  for (let i = 0; i < effects.length; i++) {
    if (effects[i]._state !== STATE_CLEAN) {
      runTop(effects[i]);
    }
  }

  effects = [];
  scheduledEffects = false;
  runningEffects = false;
}

/**
 * Creates a computation root which is given a `dispose()` function to dispose of all inner
 * computations.
 */
export function createRoot<T>(init: (dispose: Dispose) => T): T {
  const owner = new Owner();
  return compute(
    owner,
    !init.length ? init : init.bind(null, () => owner.dispose()),
    null
  ) as T;
}

/**
 * Returns the current value stored inside the given compute function without triggering any
 * dependencies. Use `untrack` if you want to also disable owner tracking.
 */
export function untrack<T>(fn: () => T): T {
  if (currentObserver === null) return fn();
  return compute<T>(currentOwner, fn, null);
}

/**
 * By default, signal updates are batched on the microtask queue which is an async process. You can
 * flush the queue synchronously to get the latest updates by calling `flushSync()`.
 */
export function flushSync(): void {
  if (!runningEffects) runEffects();
}

/**
 * Returns the currently executing parent owner.
 */
export function getOwner(): Owner | null {
  return currentOwner;
}

/**
 * Runs the given function in the given owner so context and error handling continue to work.
 * This function is pretty advanced, and usually there is a simpler way of modeling the problem
 */
export function runWithOwner<T>(
  owner: Owner | null,
  run: () => T
): T | undefined {
  try {
    return compute<T>(owner, run, null);
  } catch (error) {
    handleError(owner, error);
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

/**
 * Runs the given function when the parent owner computation is being disposed.
 */
export function onCleanup(disposable: MaybeDisposable): void {
  if (!disposable || !currentOwner) return;

  const node = currentOwner;

  if (!node._disposal) {
    node._disposal = disposable;
  } else if (Array.isArray(node._disposal)) {
    node._disposal.push(disposable);
  } else {
    node._disposal = [node._disposal, disposable];
  }
}

function disposeNode(node: Computation) {
  node._state = STATE_DISPOSED;
  if (node._disposal) emptyDisposal(node);
  if (node._sources) removeSourceObservers(node, 0);
  if (node._prevSibling) node._prevSibling._nextSibling = null;
  node._parent = null;
  node._sources = null;
  node._observers = null;
  node._prevSibling = null;
  node._context = null;
}

function emptyDisposal(owner: Computation) {
  if (Array.isArray(owner._disposal)) {
    for (let i = 0; i < owner._disposal.length; i++) {
      const callable = owner._disposal![i];
      callable.call(callable);
    }
  } else {
    owner._disposal!.call(owner._disposal);
  }

  owner._disposal = null;
}

export function compute<Result>(
  owner: Owner | null,
  compute: Callable<Owner | null, Result>,
  observer: Computation | null
): Result {
  const prevOwner = currentOwner,
    prevObserver = currentObserver;

  currentOwner = owner;
  currentObserver = observer;

  try {
    return compute.call(owner, observer ? observer._value : undefined);
  } finally {
    currentOwner = prevOwner;
    currentObserver = prevObserver;
  }
}

function lookup(owner: Owner | null, key: string | symbol): any {
  if (!owner) return;

  let current: Owner | null = owner,
    value;

  while (current) {
    value = current._context?.[key];
    if (value !== undefined) return value;
    current = current._parent;
  }
}

function handleError(owner: Owner | null, error: unknown) {
  const handler = lookup(owner, HANDLER);

  if (!handler) throw error;

  try {
    const coercedError =
      error instanceof Error ? error : Error(JSON.stringify(error));
    handler(coercedError);
  } catch (error) {
    handleError(owner!._parent, error);
  }
}

class Owner {
  _parent: Owner | null;
  _nextSibling: Owner | null;
  _prevSibling: Owner | null;
  _state: number;

  _disposal: Disposable | Disposable[] | null = null;
  _context: null | ContextRecord = null;
  _compute: null | unknown = null;

  constructor(signal: boolean = false) {
    this._parent = null;
    this._nextSibling = null;
    this._prevSibling = null;
    this._state = STATE_CLEAN;
    if (currentOwner && !signal) currentOwner.append(this);
  }

  append(owner: Owner) {
    owner._parent = this;
    owner._prevSibling = this;
    if (this._nextSibling) this._nextSibling._prevSibling = owner;
    owner._nextSibling = this._nextSibling;
    this._nextSibling = owner;
  }

  dispose(this: Owner, self = true) {
    if (this._state === STATE_DISPOSED) return;

    let head = self ? this._prevSibling : this,
      current = this._nextSibling as Computation | null;

    while (current && current._parent === this) {
      current.dispose(true);
      disposeNode(current);
      current = current._nextSibling as Computation;
    }

    if (self) disposeNode(this as Computation);
    if (current) current._prevSibling = !self ? this : this._prevSibling;
    if (head) head._nextSibling = current;
  }
}

export class Computation<T = any> extends Owner {
  _init: boolean;
  _effect: boolean;
  _sources: Computation<any>[] | null;
  _observers: Computation<any>[] | null;
  _lstate: boolean | Computation<boolean>;
  _value: T | undefined;
  _compute: null | (() => T | Promise<T>);
  name: string | undefined;
  _equals: false | ((a: T, b: T) => boolean) = (a, b) => a === b;
  constructor(
    initialValue: T | Promise<T> | undefined,
    compute: null | (() => T | Promise<T>),
    options?: MemoOptions<T>
  ) {
    super(compute === null);

    this._state = compute ? STATE_DIRTY : STATE_CLEAN;
    this._init = false;
    this._effect = false;
    this._sources = null;
    this._observers = null;
    if (isPromise(initialValue)) {
      this._lstate = true;
      this._value = undefined;
      initialValue.then((value) => {
        this.write(value);
        if (typeof this._lstate === "boolean") this._lstate = false;
        else this._lstate.write(false);
      });
    } else {
      this._value = initialValue;
      this._lstate = false;
    }

    this._compute = compute ?? null;

    if (__DEV__)
      this.name = options?.name ?? (this._compute ? "computed" : "signal");
    if (options && options.equals !== undefined) this._equals = options.equals;
  }

  read(): T {
    if (this._state === STATE_DISPOSED) return this._value!;

    if (currentObserver && !this._effect) {
      if (
        !newSources &&
        currentObserver._sources &&
        currentObserver._sources[newSourcesIndex] == this
      ) {
        newSourcesIndex++;
      } else if (!newSources) newSources = [this];
      else newSources.push(this);
    }

    if (this._compute) updateIfNecessary(this);

    return this._value!;
  }

  state(): Computation<boolean> {
    if (typeof this._lstate === "boolean") {
      this._lstate = new Computation(this._lstate, null);
    }
    return this._lstate;
  }

  wait(): T {
    if (!currentObserver) throw new Error("must wait inside computation");

    if (
      typeof this._lstate === "boolean" ? this._lstate : this._lstate._value
    ) {
      memoLoading = true;
    }
    return this.read();
  }

  write(value: T): T {
    if (!this._equals || !this._equals(this._value!, value)) {
      if (isPromise(value)) {
        if (typeof this._lstate === "boolean") this._lstate = true;
        else this._lstate.write(true);
        value.then((v) => {
          this.write(v);
          if (typeof this._lstate === "boolean") this._lstate = false;
          else this._lstate.write(false);
        });
      } else {
        this._value = value;
        if (this._observers) {
          for (let i = 0; i < this._observers.length; i++) {
            notify(this._observers[i], STATE_DIRTY);
          }
        }
      }
    }

    return this._value!;
  }
}

function updateIfNecessary(node: Computation) {
  if (node._state === STATE_CHECK) {
    for (let i = 0; i < node._sources!.length; i++) {
      updateIfNecessary(node._sources![i]);
      if ((node._state as number) === STATE_DIRTY) {
        // Stop the loop here so we won't trigger updates on other parents unnecessarily
        // If our computation changes to no longer use some sources, we don't
        // want to update() a source we used last time, but now don't use.
        break;
      }
    }
  }

  if (node._state === STATE_DIRTY) update(node);
  else node._state = STATE_CLEAN;
}

function cleanup(node: Computation) {
  if (node._nextSibling && node._nextSibling._parent === node)
    node.dispose(false);
  if (node._disposal) emptyDisposal(node);
  node._context = null;
}

export function update(node: Computation) {
  let prevObservers = newSources,
    prevObserversIndex = newSourcesIndex;

  newSources = null as Computation[] | null;
  newSourcesIndex = 0;
  memoLoading = false;

  try {
    cleanup(node);

    const result = compute(node, node._compute!, node);

    if (newSources) {
      if (node._sources) removeSourceObservers(node, newSourcesIndex);

      if (node._sources && newSourcesIndex > 0) {
        node._sources.length = newSourcesIndex + newSources.length;
        for (let i = 0; i < newSources.length; i++) {
          node._sources[newSourcesIndex + i] = newSources[i];
        }
      } else {
        node._sources = newSources;
      }

      let source: Computation;
      for (let i = newSourcesIndex; i < node._sources.length; i++) {
        source = node._sources[i];
        if (!source._observers) source._observers = [node];
        else source._observers.push(node);
      }
    } else if (node._sources && newSourcesIndex < node._sources.length) {
      removeSourceObservers(node, newSourcesIndex);
      node._sources.length = newSourcesIndex;
    }

    if (!node._effect && node._init) {
      node.write(result);
    } else {
      node._value = result;
      node._init = true;
    }
  } catch (error) {
    if (
      __DEV__ &&
      !__TEST__ &&
      !node._init &&
      typeof node._value === "undefined"
    ) {
      console.error(
        `computed \`${node.name}\` threw error during first run, this can be fatal.` +
          "\n\nSolutions:\n\n" +
          "1. Set the `initial` option to silence this error",
        "\n2. Or, use an `effect` if the return value is not being used",
        "\n\n",
        error
      );
    }

    handleError(node, error);

    if (node._state === STATE_DIRTY) {
      cleanup(node);
      if (node._sources) removeSourceObservers(node, 0);
    }

    return;
  }

  newSources = prevObservers;
  newSourcesIndex = prevObserversIndex;

  if (typeof node._lstate === "boolean") node._lstate = memoLoading;
  else node._lstate.write(memoLoading);

  node._state = STATE_CLEAN;
}

export function notify(node: Computation, state: number) {
  if (node._state >= state) return;

  if (node._effect && node._state === STATE_CLEAN) {
    effects.push(node);
    if (!scheduledEffects) flushEffects();
  }

  node._state = state;
  if (node._observers) {
    for (let i = 0; i < node._observers.length; i++) {
      notify(node._observers[i], STATE_CHECK);
    }
  }
}

function removeSourceObservers(node: Computation, index: number) {
  let source: Computation, swap: number;
  for (let i = index; i < node._sources!.length; i++) {
    source = node._sources![i];
    if (source._observers) {
      swap = source._observers.indexOf(node);
      source._observers[swap] = source._observers[source._observers.length - 1];
      source._observers.pop();
    }
  }
}

function isPromise(v: any): v is Promise<any> {
  return (
    (typeof v === "object" || typeof v === "function") &&
    typeof v?.then === "function"
  );
}

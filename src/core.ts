/**
 * Nodes for constructing a reactive graph of reactive values and reactive computations.
 * The graph is acyclic.
 * The user inputs new values into the graph by calling .write() on one more more reactive nodes.
 * The user retrieves computed results from the graph by calling .read() on one or more computation nodes.
 * The library is responsible for running any necessary computations so that .read() is
 * up to date with all prior .write() calls anywhere in the graph.
 *
 * We call input nodes 'roots' and the output nodes 'leaves' of the graph here in discussion.
 * Changes flow from roots to leaves. It would be effective but inefficient to immediately propagate
 * all changes from a root through the graph to descendant leaves. Instead we defer change
 * most change progogation computation until a leaf is accessed. This allows us to coalesce computations
 * and skip altogether recalculating unused sections of the graph.
 *
 * Each computation node tracks its sources and its observers (observers are other
 * elements that have this node as a source). Source and observer links are updated automatically
 * as observer computations re-evaluate and call get() on their sources.
 *
 * Each node stores a cache state to support the change propogation algorithm: 'clean', 'check', or 'dirty'
 * In general, execution proceeds in three passes:
 *  1. write() propogates changes down the graph to the leaves
 *     direct children are marked as dirty and their deeper descendants marked as check
 *     (no computations are evaluated)
 *  2. read() requests that parent nodes updateIfNecessary(), which proceeds recursively up the tree
 *     to decide whether the node is clean (parents unchanged) or dirty (parents changed)
 *  3. updateIfNecessary() evaluates the computation if the node is dirty
 *     (the computations are executed in root to leaf order)
 */

import { Owner, getOwner, setCurrentOwner } from "./owner";
import {
  STATE_CHECK,
  STATE_CLEAN,
  STATE_DIRTY,
  STATE_DISPOSED,
} from "./constants";
import { NotReadyError } from "./error";

export interface SignalOptions<T> {
  name?: string;
  equals?: ((prev: T, next: T) => boolean) | false;
}

export interface MemoOptions<T> extends SignalOptions<T> {
  initial?: T;
}

interface SourceType {
  _observers: ObserverType[] | null;
  updateIfNecessary(): boolean;
}

interface ObserverType {
  _sources: SourceType[] | null;
  notify(state: number): void;

  // Needed to eagerly tell observers that their sources are currently loading
  setLoading(loading: boolean): void;
}

let currentObserver: ObserverType | null = null;

let newSources: SourceType[] | null = null;
let memoLoading = false;
let newSourcesIndex = 0;

const ERROR_BIT = 1;
const WAITING_BIT = 2;
const ASYNC_BIT = 4;

const IS_LOADING = ASYNC_BIT | WAITING_BIT;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class Computation<T = any> extends Owner {
  _sources: SourceType[] | null;
  _observers: ObserverType[] | null;
  _loading: LoadingState<T> | null;
  _error: ErrorState<T> | null;
  // 1=value was thrown, 2=waiting on a source that is loading, 4=value is a promise
  _bits: number;
  _value: T | undefined;
  _compute: null | (() => T | Promise<T>);
  name: string | undefined;
  _equals: false | ((a: T, b: T) => boolean) = isEqual;
  constructor(
    initialValue: T | Promise<T> | undefined,
    compute: null | (() => T | Promise<T>),
    options?: MemoOptions<T>
  ) {
    super(compute === null);

    this._state = compute ? STATE_DIRTY : STATE_CLEAN;
    this._sources = null;
    this._observers = null;
    this._compute = compute;
    this._bits = 0;
    this._error = null;
    this._loading = null;
    if (isPromise(initialValue)) {
      this._bits |= ASYNC_BIT;
      this._value = undefined;
      initialValue
        .then((value) => {
          this.write(value);
        })
        .catch((e) => {
          this.setError(e);
        });
    } else {
      this._value = initialValue;
    }

    if (__DEV__)
      this.name = options?.name ?? (this._compute ? "computed" : "signal");
    if (options && options.equals !== undefined) this._equals = options.equals;
  }

  read(): T {
    if (this._state === STATE_DISPOSED) return this._value!;

    if (this._compute) {
      const isLoading = this.updateIfNecessary();
      memoLoading ||= isLoading;
    } else {
      memoLoading ||= (this._bits & IS_LOADING) !== 0;
    }

    track(this);

    if (this._bits & ERROR_BIT) throw this._value;
    return this._value!;
  }

  wait(): T {
    if (this._state === STATE_DISPOSED) return this._value!;

    if (this._compute) this.updateIfNecessary();

    if ((this._bits & IS_LOADING) === 0) {
      track(this);
      if (this._bits & ERROR_BIT) throw this._value;
      return this._value!;
    } else {
      memoLoading = true;
      if (this._loading === null) {
        this._loading = new LoadingState(this);
      }
      track(this._loading);
      throw new NotReadyError();
    }
  }

  loading(): boolean {
    if (this._loading === null) {
      this._loading = new LoadingState(this);
    }
    track(this._loading);
    return this.updateIfNecessary();
  }

  error(): boolean {
    if (this._error === null) {
      this._error = new ErrorState(this);
    }
    this.updateIfNecessary();
    track(this._error);
    return (this._bits & ERROR_BIT) !== 0;
  }

  write(value: T | Promise<T>): T {
    if (isPromise(value)) {
      if ((this._bits & IS_LOADING) === 0) this._loading?.set(true);
      this._bits |= ASYNC_BIT;
      value
        .then((v) => {
          this.write(v);
        })
        .catch((e) => {
          this.setError(e);
        });
    } else if (!this._equals || !this._equals(this._value!, value)) {
      this._value = value;
      if ((this._bits & WAITING_BIT) === 0) this._loading?.set(false);
      this._bits &= ~ASYNC_BIT;
      if ((this._bits & ERROR_BIT) !== 0) this._error?.set();
      this._bits &= ~ERROR_BIT;
      if (this._observers) {
        for (let i = 0; i < this._observers.length; i++) {
          this._observers[i].notify(STATE_DIRTY);
        }
      }
    }

    return this._value!;
  }

  notify(state: number) {
    if (this._state >= state) return;

    this._state = state;
    if (this._observers) {
      for (let i = 0; i < this._observers.length; i++) {
        this._observers[i].notify(STATE_CHECK);
      }
    }
    this._loading?.notify(STATE_CHECK);
    this._error?.notify(STATE_CHECK);
  }

  setLoading(loading: boolean) {
    if (loading !== ((this._bits & ASYNC_BIT) !== 0)) {
      this._loading?.set(loading);
    }
    this._bits &= ~WAITING_BIT;
    if (loading) this._bits |= WAITING_BIT;
  }

  setError(error: unknown) {
    if ((this._bits & ERROR_BIT) === 0) this._error?.set();
    this._value = error as T;
    this._bits |= ERROR_BIT;
  }

  // This is the core part of the reactivity system, which makes sure that values that we read are
  // always up to date. We've also adapted it to return the loading state of the computation, so that
  // we can propagate that to the computation's observers.
  updateIfNecessary(): boolean {
    if (this._state === STATE_CLEAN) {
      return (this._bits & IS_LOADING) !== 0;
    }

    let anyLoading = false;
    if (this._state === STATE_CHECK) {
      for (let i = 0; i < this._sources!.length; i++) {
        const isLoading = this._sources![i].updateIfNecessary();
        anyLoading ||= isLoading;
        if ((this._state as number) === STATE_DIRTY) {
          // Stop the loop here so we won't trigger updates on other parents unnecessarily
          // If our computation changes to no longer use some sources, we don't
          // want to update() a source we used last time, but now don't use.
          break;
        }
      }
    }

    if (this._state === STATE_DIRTY) update(this);
    else {
      this.setLoading(anyLoading);

      this._state = STATE_CLEAN;
    }

    return (this._bits & IS_LOADING) !== 0;
  }

  disposeNode() {
    if (this._sources) removeSourceObservers(this, 0);
    this._sources = null;
    this._observers = null;
    super.disposeNode();
  }
}

/**
 * We attach a LoadingState node to each Computation node to track async sources
 * When a Computation node reads a LoadingState node, it adds the LoadingState node to its sources.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
class LoadingState<T = any> implements SourceType {
  _observers: ObserverType[] | null;
  _origin: Computation<T>;

  constructor(origin: Computation<T>) {
    this._origin = origin;
    this._observers = null;
  }

  updateIfNecessary(): boolean {
    return this._origin.updateIfNecessary();
  }

  set(value: boolean) {
    if (this._origin._observers) {
      for (let i = 0; i < this._origin._observers.length; i++) {
        if (value) {
          this._origin._observers[i].setLoading(true);
        } else {
          this._origin._observers[i].notify(STATE_CHECK);
        }
      }
    }
    this.notify(STATE_DIRTY);
  }
  notify(state: number) {
    if (this._observers) {
      for (let i = 0; i < this._observers.length; i++) {
        this._observers[i].notify(state);
      }
    }
  }
}

class ErrorState<T> implements SourceType {
  _observers: ObserverType[] | null;
  _origin: Computation<T>;

  constructor(origin: Computation<T>) {
    this._origin = origin;
    this._observers = null;
  }

  updateIfNecessary(): boolean {
    return this._origin.updateIfNecessary();
  }

  set() {
    this.notify(STATE_DIRTY);
  }

  notify(state: number) {
    if (this._observers) {
      for (let i = 0; i < this._observers.length; i++) {
        this._observers[i].notify(state);
      }
    }
  }
}

function cleanup(node: Computation) {
  if (node._nextSibling && node._nextSibling._parent === node)
    node.dispose(false);
  if (node._disposal) node.emptyDisposal();
  node._context = null;
}

/**
 * Instead of wiping the sources immediately on reevaluation, we instead compare them to the new sources
 * by checking if the source we want to add is the same as the old source at the same index.
 *
 * This way when the sources don't change, we are just doing a fast comparison:
 *
 * _sources: [a, b, c]
 *            ^
 *            |
 *      newSourcesIndex
 *
 * When the sources do change, we create newSources and push the values that we read into it
 */
function track(computation: SourceType) {
  if (currentObserver) {
    if (
      !newSources &&
      currentObserver._sources &&
      currentObserver._sources[newSourcesIndex] === computation
    ) {
      newSourcesIndex++;
    } else if (!newSources) newSources = [computation];
    else newSources.push(computation);
  }
}

/**
 * This is the main tracking code when a computation's _compute function is rerun.
 * It handles the updating of sources and observers, disposal of previous executions,
 * and error handling if the _compute function throws.
 *
 * It also checks the count of asynchronous computations and sets the node's loading state (lstate)
 * to the number of sources that are currently waiting on a value or have any parents waiting on a value
 */
export function update<T>(node: Computation<T>) {
  const prevObservers = newSources;
  const prevObserversIndex = newSourcesIndex;
  const prevMemoLoading = memoLoading;

  newSources = null as Computation[] | null;
  newSourcesIndex = 0;
  memoLoading = false;

  try {
    cleanup(node);

    const result = compute(node, node._compute!, node);

    node.write(result);

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

      let source: SourceType;
      for (let i = newSourcesIndex; i < node._sources.length; i++) {
        source = node._sources[i];
        if (!source._observers) source._observers = [node];
        else source._observers.push(node);
      }
    } else if (node._sources && newSourcesIndex < node._sources.length) {
      removeSourceObservers(node, newSourcesIndex);
      node._sources.length = newSourcesIndex;
    }

    node.setLoading(memoLoading);
  } catch (error) {
    node.setError(error);

    return;
  }

  newSources = prevObservers;
  newSourcesIndex = prevObserversIndex;
  memoLoading = prevMemoLoading;

  node._state = STATE_CLEAN;
}

function removeSourceObservers(node: ObserverType, index: number) {
  let source: SourceType;
  let swap: number;
  for (let i = index; i < node._sources!.length; i++) {
    source = node._sources![i];
    if (source._observers) {
      swap = source._observers.indexOf(node);
      source._observers[swap] = source._observers[source._observers.length - 1];
      source._observers.pop();
    }
  }
}

function isPromise(v: unknown): v is Promise<unknown> {
  return (
    (typeof v === "object" || typeof v === "function") &&
    typeof (v as any)?.then === "function" // eslint-disable-line
  );
}

function isEqual<T>(a: T, b: T): boolean {
  return a === b;
}

/**
 * Returns the current value stored inside the given compute function without triggering any
 * dependencies. Use `untrack` if you want to also disable owner tracking.
 */
export function untrack<T>(fn: () => T): T {
  if (currentObserver === null) return fn();
  return compute(getOwner(), fn, null);
}

export function compute<T>(
  owner: Owner | null,
  compute: (val: T) => T | Promise<T>,
  observer: Computation<T>
): T | Promise<T>;
export function compute<T>(
  owner: Owner | null,
  compute: (val: undefined) => T,
  observer: null
): T;
export function compute<T>(
  owner: Owner | null,
  compute: (val: undefined) => T | Promise<T>,
  observer: null
): T | Promise<T>;
export function compute<T>(
  owner: Owner | null,
  compute: (val?: T) => T | Promise<T>,
  observer: Computation<T> | null
): T | Promise<T> {
  const prevOwner = setCurrentOwner(owner);
  const prevObserver = currentObserver;
  currentObserver = observer;

  try {
    return compute(observer ? observer._value : undefined);
  } catch (e) {
    if (!(e instanceof NotReadyError)) {
      throw e;
    } else {
      // TODO: figure out what should go here
      return observer!._value!;
    }
  } finally {
    setCurrentOwner(prevOwner);
    currentObserver = prevObserver;
  }
}

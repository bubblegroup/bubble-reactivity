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
  _updateIfNecessary(): void;

  // Needed to lazily update to not loading
  _isLoading(): boolean;
}

interface ObserverType {
  _sources: SourceType[] | null;
  _notify(state: number): void;

  // Needed to eagerly tell observers that their sources are currently loading (and thus they are too)
  _setWaiting(loading: boolean): void;
}

let currentObserver: ObserverType | null = null;

let newSources: SourceType[] | null = null;
let newSourcesIndex = 0;
let newLoadingState = false;

const ERROR_BIT = 1;
const WAITING_BIT = 2;
const SELF_ASYNC_BIT = 4;

const IS_LOADING = SELF_ASYNC_BIT | WAITING_BIT;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class Computation<T = any>
  extends Owner
  implements SourceType, ObserverType
{
  _sources: SourceType[] | null = null;
  _observers: ObserverType[] | null = null;
  _value: T | undefined;
  _compute: null | (() => T | Promise<T>);

  // Used in __DEV__ mode, hopefully removed in production
  _name: string | undefined;

  // Ideally we would set this default value on the prototype directly, but doing that in typescript causes issues
  // One alternative would be to define _equals on Owner, but benchmarking hasn't shown a substantial impact
  _equals: false | ((a: T, b: T) => boolean) = isEqual;

  // 1=value was thrown, 2=waiting on a source that is loading, 4=value is a promise
  _stateFlags = 0;
  _error: ErrorState<T> | null = null;
  _promise: Promise<T> | null = null;
  _loading: LoadingState<T> | null = null;

  constructor(
    initialValue: T | Promise<T> | undefined,
    compute: null | (() => T | Promise<T>),
    options?: MemoOptions<T>
  ) {
    // Initialize self as a node in the Owner tree, for tracking cleanups.
    // If we aren't passed a compute function, we don't need to track nested computations
    // because there is no way to create a nested computation (which would add an element to the owner tree)
    super(compute === null);

    this._compute = compute;

    this._state = compute ? STATE_DIRTY : STATE_CLEAN;

    // If the initial value passed in is a promise, we need to track it
    if (isPromise(initialValue)) {
      this._stateFlags |= SELF_ASYNC_BIT;

      // Early reads to this computation will return this value (undefined). If that behavior is not desired,
      // the user should call .wait() on the computation to wait for the promise to resolve
      this._value = undefined;

      // Keep track of the latest promise, that way if a new promise is written
      // before the first one resolves, we can ignore the first one
      this._promise = initialValue;

      // When the promise resolves, we need to update our value
      initialValue
        .then((value) => {
          // Writing a new value (that is not a promise) will automatically update the state to "no longer loading"
          if (this._promise === initialValue) this.write(value);
        })
        .catch((e) => {
          // When the promise errors, we need to set an error state so that future reads of this
          // computation will re-throw the error (until a new value is written/recomputed)
          if (this._promise === initialValue) this._setError(e);
        });
    } else {
      // If the initial value is not a promise, we just set it directly
      this._value = initialValue;
    }

    // Used when debugging the graph; it is often helpful to know the names of sources/observers
    if (__DEV__)
      this._name = options?.name ?? (this._compute ? "computed" : "signal");

    if (options && options.equals !== undefined) this._equals = options.equals;
  }

  _read(shouldThrow: boolean): T {
    if (this._compute) this._updateIfNecessary();

    track(this);

    if (this._isLoading()) {
      newLoadingState = true;

      if (shouldThrow) throw new NotReadyError();
    }

    if (this._stateFlags & ERROR_BIT) throw this._value;
    return this._value!;
  }

  read(): T {
    return this._read(false);
  }

  wait(): T {
    return this._read(true);
  }

  loading(): boolean {
    if (this._loading === null) {
      this._loading = new LoadingState(this);
    }
    this._updateIfNecessary();
    track(this._loading);
    return this._isLoading();
  }

  error(): boolean {
    if (this._error === null) {
      this._error = new ErrorState(this);
    }
    this._updateIfNecessary();
    track(this._error);
    return (this._stateFlags & ERROR_BIT) !== 0;
  }

  write(value: T | Promise<T>): T {
    this._promise = null;
    if (isPromise(value)) {
      // We are about to change the async state to true, and we want to notify _loading observers if the loading state changes
      // Thus, we just need to check if the current state is not loading, then we are guaranteed to change
      if ((this._stateFlags & IS_LOADING) === 0) this._loading?.set(true);
      this._stateFlags |= SELF_ASYNC_BIT;
      this._promise = value;
      value
        .then((v) => {
          if (this._promise === value) this.write(v);
        })
        .catch((e) => {
          if (this._promise === value) this._setError(e);
        });
    } else if (!this._equals || !this._equals(this._value!, value)) {
      this._value = value;

      // We are about to change the async state to false, and we want to notify _loading observers if the loading state changes.
      // If we are currently waiting on a source, then changing the loading state will not change the overall loading state.
      // Otherwise, we need to notify _loading observers that the loading state has changed
      if ((this._stateFlags & WAITING_BIT) === 0) this._loading?.set(false);
      this._stateFlags &= ~SELF_ASYNC_BIT;

      // If we were in an error state, then our error state is changing and we need to notify _error observers
      // that the error state has changed
      if ((this._stateFlags & ERROR_BIT) !== 0) this._error?.set();
      this._stateFlags &= ~ERROR_BIT;

      // Our value has changed, so we need to notify all of our observers that the value has changed and so they must rerun
      if (this._observers) {
        for (let i = 0; i < this._observers.length; i++) {
          this._observers[i]._notify(STATE_DIRTY);
        }
      }
    }

    // We return the value so that .write can be used in an expression (although it is not usually recommended)
    return this._value!;
  }

  _notify(state: number) {
    if (this._state >= state) return;

    this._state = state;
    if (this._observers) {
      for (let i = 0; i < this._observers.length; i++) {
        this._observers[i]._notify(STATE_CHECK);
      }
    }
    this._loading?._notify(STATE_CHECK);
    this._error?._notify(STATE_CHECK);
  }

  _setWaiting(loading: boolean) {
    // We are changing the self waiting bit
    if (loading !== ((this._stateFlags & SELF_ASYNC_BIT) !== 0)) {
      this._loading?.set(loading);
    }
    this._stateFlags &= ~WAITING_BIT;
    if (loading) this._stateFlags |= WAITING_BIT;
  }

  _setError(error: unknown) {
    if ((this._stateFlags & ERROR_BIT) === 0) this._error?.set();
    this._value = error as T;
    this._stateFlags |= ERROR_BIT;
  }

  _isLoading(): boolean {
    return (this._stateFlags & IS_LOADING) !== 0;
  }

  // This is the core part of the reactivity system, which makes sure that values that we read are
  // always up to date. We've also adapted it to return the loading state of the computation, so that
  // we can propagate that to the computation's observers.
  //
  // This function will ensure that the value and states we read from the computation are up to date
  _updateIfNecessary() {
    // If the user tries to read a computation that has been disposed, we throw an error, because
    // they probably kept a reference to it as the parent reran, so there is likely a new computation
    // with the same _compute function that they should be reading instead.
    if (this._state === STATE_DISPOSED) {
      throw new Error("Tried to read a disposed computation");
    }

    // If the computation is already clean, none of our sources have changed, so we know that
    // our value and stateFlags are up to date, and we can just return.
    if (this._state === STATE_CLEAN) {
      return;
    }

    // Otherwise, one of our parent's value may have changed, or one of our parent's loading state
    // may have been set to no longer loading. In either case, what we need to do is make sure our
    // parents all have up to date values and loading states, and then update our own value and loading state

    // We keep track of whether any of our sources have changed loading state, so that we can update our own loading state
    // This is only necessary if none of them change value, because update() will also cause us to recompute our loading state
    let isWaiting = false;

    // If we're in state_check, then that means one of our grandparent sources may have changed value or loading state,
    // so we need to recursively call _updateIfNecessary to update the state of all of our sources, and then update our value and loading state.
    if (this._state === STATE_CHECK) {
      for (let i = 0; i < this._sources!.length; i++) {
        // Make sure the parent is up to date. If it changed value, then it will mark us as STATE_DIRTY, and we will know to rerun
        this._sources![i]._updateIfNecessary();

        // If the parent is loading, then we are waiting
        if (this._sources![i]._isLoading()) {
          isWaiting = true;
        }

        // If the parent changed value, it will mark us as STATE_DIRTY and we need to call update()
        // We cast because typescript doesn't know that the _updateIfNecessary call above can change our state
        if ((this._state as number) === STATE_DIRTY) {
          // Stop the loop here so we won't trigger updates on other parents unnecessarily
          // If our computation changes to no longer use some sources, we don't
          // want to update() a source we used last time, but now don't use.
          break;
        }
      }
    }

    if (this._state === STATE_DIRTY) {
      update(this);
    } else {
      // We have checked all our parents and none of them changed value, so we know that our value is up to date
      // That means that anyLoading correctly represents whether we are waiting on anything (waiting state)
      this._setWaiting(isWaiting);

      // None of our parents changed value, so our value is up to date (STATE_CLEAN)
      this._state = STATE_CLEAN;
    }
  }

  // If we are a child of an owner that has been disposed or computation that has rerun, then we need to remove ourselves from the graph
  _disposeNode() {
    if (this._state === STATE_DISPOSED) return;

    // Unlink ourselves from our sources' observers array so that we can be garbage collected
    // This removes us from the computation graph
    if (this._sources) removeSourceObservers(this, 0);

    // Remove ourselves from the ownership tree as well
    super._disposeNode();
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

  _updateIfNecessary(): void {
    this._origin._updateIfNecessary();
  }

  _isLoading(): boolean {
    return this._origin._isLoading();
  }

  set(value: boolean) {
    if (this._origin._observers) {
      for (let i = 0; i < this._origin._observers.length; i++) {
        if (value) {
          this._origin._observers[i]._setWaiting(true);
        } else {
          this._origin._observers[i]._notify(STATE_CHECK);
        }
      }
    }
    this._notify(STATE_DIRTY);
  }

  _notify(state: number) {
    if (this._observers) {
      for (let i = 0; i < this._observers.length; i++) {
        this._observers[i]._notify(state);
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

  _updateIfNecessary(): void {
    this._origin._updateIfNecessary();
  }

  _isLoading(): boolean {
    return this._origin._isLoading();
  }

  set() {
    this._notify(STATE_DIRTY);
  }

  _notify(state: number) {
    if (this._observers) {
      for (let i = 0; i < this._observers.length; i++) {
        this._observers[i]._notify(state);
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
 * Reruns a computation's _compute function, producing a new value and keeping track of dependencies.
 *
 * It handles the updating of sources and observers, disposal of previous executions,
 * and error handling if the _compute function throws. It also sets the node as loading
 * if it read any parents that are currently loading.
 */
export function update<T>(node: Computation<T>) {
  const prevSources = newSources;
  const prevSourcesIndex = newSourcesIndex;
  const prevLoadingState = newLoadingState;

  newSources = null as Computation[] | null;
  newSourcesIndex = 0;
  newLoadingState = false;

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

    node._setWaiting(newLoadingState);
  } catch (error) {
    node._setError(error);

    return;
  }

  newSources = prevSources;
  newSourcesIndex = prevSourcesIndex;
  newLoadingState = prevLoadingState;

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

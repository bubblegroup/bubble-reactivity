/**
 * Nodes for constructing a graph of reactive values and reactive computations.
 * The graph is acyclic.
 * The user inputs new values into the graph by calling .write() on one more computation nodes.
 * The user retrieves computed results from the graph by calling .read() on one or more computation nodes.
 * The library is responsible for running any necessary computations so that .read() is
 * up to date with all prior .write() calls anywhere in the graph.
 *
 * We call the input nodes 'roots' and the output nodes 'leaves' of the graph here.
 * Changes flow from roots to leaves. It would be effective but inefficient to immediately propagate
 * all changes from a root through the graph to descendant leaves. Instead, we defer change
 * most change propagation computation until a leaf is accessed. This allows us to coalesce
 * computations and skip altogether recalculating unused sections of the graph.
 *
 * Each computation node tracks its sources and its observers (observers are other
 * elements that have this node as a source). Source and observer links are updated automatically
 * as observer computations re-evaluate and call get() on their sources.
 *
 * Each node stores a cache state (clean/check/dirty) to support the change propagation algorithm:
 * In general, execution proceeds in three passes:
 *  1. write() propagates changes down the graph to the leaves
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

  // Needed to eagerly tell observers that their sources are currently loading
  // (and thus they are too)
  _setIsWaiting(loading: boolean): void;
}

let currentObserver: ObserverType | null = null;

let newSources: SourceType[] | null = null;
let newSourcesIndex = 0;
let newLoadingState = false;

export const hooks = {
  signalWritten: () => {
    // Noop, to be replaced
  },
};

/** Computation threw a value during execution */
const ERROR_BIT = 1;
/** Computation's ancestors have a unresolved promise */
const WAITING_BIT = 2;

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

  // Ideally we would set this default value on the prototype directly, but doing that
  // in typescript causes issues.
  _equals: false | ((a: T, b: T) => boolean) = isEqual;

  /** Whether the computation is an error or has ancestors that are unresolved */
  _stateFlags = 0;
  _error: ErrorState<T> | null = null;
  _loading: LoadingState<T> | null = null;
  /** current pending promise */
  _promise: Promise<T> | null = null;

  constructor(
    initialValue: T | Promise<T> | undefined,
    compute: null | (() => T | Promise<T>),
    options?: MemoOptions<T>
  ) {
    // Initialize self as a node in the Owner tree, for tracking cleanups.
    // If we aren't passed a compute function, we don't need to track nested computations
    // because there is no way to create a nested computation (a child to the owner tree)
    super(compute === null);

    this._compute = compute;

    this._state = compute ? STATE_DIRTY : STATE_CLEAN;

    // If the initial value passed in is a promise, we need to track it
    if (isPromise(initialValue)) {
      // Early reads to this computation will return this value (undefined).
      // If that behavior is not desired, the user should call .wait() on the computation
      // to wait for the promise to resolve
      this._value = undefined;

      // Keep track of the latest promise, that way if a new promise is written
      // before the first one resolves, we can ignore the first one
      this._promise = initialValue;

      // When the promise resolves, we need to update our value
      initialValue
        .then((value) => {
          // Writing a new value (that is not a promise) will automatically
          // update the state to "no longer loading"
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

    // When the currentObserver reads this._value, the want to add this computation as a source
    // so that when this._value changes, the currentObserver will be re-executed
    track(this);

    if (this._isLoading()) {
      newLoadingState = true;

      // If we want to wait for the value to resolve, we throw a NotReadyError which will be caught
      // That way user's computations never see stale or undefined values.
      // (cf. React: https://twitter.com/sebmarkbage/status/941214259505119232)
      if (shouldThrow) throw new NotReadyError();
    }

    if (this._stateFlags & ERROR_BIT) throw this._value;
    return this._value!;
  }

  /**
   * Return the current value of this computation
   * Automatically re-executes the surrounding computation when the value changes
   *
   * If the computation is currently a pending promise, this will return the previous/inital value
   */
  read(): T {
    return this._read(false);
  }

  /**
   * Return the current value of this computation
   * Automatically re-executes the surrounding computation when the value changes
   *
   * If the computation has any unresolved ancestors, this function waits for the value to resolve
   * before continuing
   */
  wait(): T {
    return this._read(true);
  }

  /**
   * Return true if the computation is the value is dependent on an unresolved promise
   * Triggers re-execution of the computation when the loading state changes
   *
   * This is useful especially when effects want to re-execute when a computation's
   * loading state changes
   */
  loading(): boolean {
    if (this._loading === null) {
      this._loading = new LoadingState(this);
    }
    this._updateIfNecessary();
    track(this._loading);
    return this._isLoading();
  }

  /**
   * Return true if the computation is the computation threw an error
   * Triggers re-execution of the computation when the error state changes
   */
  error(): boolean {
    if (this._error === null) {
      this._error = new ErrorState(this);
    }
    this._updateIfNecessary();
    track(this._error);
    return (this._stateFlags & ERROR_BIT) !== 0;
  }

  /** Update the computation with a new value or promise */
  write(value: T | Promise<T>): T {
    if (isPromise(value)) {
      // We are about to change the async state to true, and we want to notify _loading observers
      // if the loading state changes. Thus, we just need to check if the current state is not
      // loading, then we are guaranteed to change
      if (!this._isLoading()) this._loading?.set(true);

      // Update the latest promise, that way any old promises that resolve will be ignored
      this._promise = value;

      // When the promise resolves, we need to update our value (or error if the promise rejects)
      value
        .then((v) => {
          if (this._promise === value) this.write(v);
        })
        .catch((e) => {
          if (this._promise === value) this._setError(e);
        });
    } else if (!this._equals || !this._equals(this._value!, value)) {
      this._value = value;

      // We are about to change the async state to false, and we want to notify _loading observers
      // if the loading state changes. If an ancestor is already unresolved then us becoming
      // unresolved will not change the overall loading state. Otherwise, we need to
      // notify _loading observers that the loading state has changed
      if ((this._stateFlags & WAITING_BIT) === 0) this._loading?.set(false);
      this._promise = null;

      // If we were in an error state, then our error state is changing and we need to notify
      // _error observers that the error state has changed
      if ((this._stateFlags & ERROR_BIT) !== 0) {
        this._error?._notify(STATE_DIRTY);
        this._stateFlags &= ~ERROR_BIT;
      }

      // Our value has changed, so we need to notify all of our observers that the value has
      // changed and so they must rerun
      if (this._observers) {
        for (let i = 0; i < this._observers.length; i++) {
          this._observers[i]._notify(STATE_DIRTY);
        }
      }
    }

    // We return the value so that .write can be used in an expression
    // (although it is not usually recommended)
    return this._value!;
  }

  /**
   * Set the current node's state, and recursively mark all of this node's observers as STATE_CHECK
   */
  _notify(state: number) {
    // If the state is already STATE_DIRTY and we are trying to set it to STATE_CHECK,
    // then we don't need to do anything. Similarly, if the state is already STATE_CHECK
    // and we are trying to set it to STATE_CHECK, then we don't need to do anything because
    // a previous _notify call has already set this state and all observers as STATE_CHECK
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

  /**
   * Change the waiting state of the computation, notifying observers if the computation switches
   * to or from a loading state
   */
  _setIsWaiting(waiting: boolean) {
    // Check if changing the waiting state will change the overall loading state
    // If it will, then we need to notify _loading observers that the loading state has changed
    const isSelfPending = this._promise !== null;
    if (waiting !== isSelfPending) this._loading?.set(waiting);

    this._stateFlags &= ~WAITING_BIT;
    if (waiting) this._stateFlags |= WAITING_BIT;
  }

  _setError(error: unknown) {
    // If we are not in an error state, then our error state is changing so notify _error observers
    if ((this._stateFlags & ERROR_BIT) === 0) {
      this._error?._notify(STATE_DIRTY);
      this._stateFlags |= ERROR_BIT;
    }

    // Store the error value in _value
    // this is an optimization to avoid having an extra field because we know _value is not used
    this._value = error as T;
  }

  /**
   * This is the core part of the reactivity system, which makes sure that the values are updated
   * before they are read. We've also adapted it to return the loading state of the computation,
   * so that we can propagate that to the computation's observers.
   *
   * This function will ensure that the value and states we read from the computation are up to date
   */
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

    // Otherwise, our sources' values may have changed, or one of our sources' loading states
    // may have been set to no longer loading. In either case, what we need to do is make sure our
    // sources all have up to date values and loading states and then update our own value and
    // loading state

    // We keep track of whether any of our sources have changed loading state so that we can update
    // our loading state. This is only necessary if none of them change value because update() will
    // also cause us to recompute our loading state.
    let isWaiting = false;

    // STATE_CHECK means one of our grandparent sources may have changed value or loading state,
    // so we need to recursively call _updateIfNecessary to update the state of all of our sources
    // and then update our value and loading state.
    if (this._state === STATE_CHECK) {
      for (let i = 0; i < this._sources!.length; i++) {
        // Make sure the parent is up to date. If it changed value, then it will mark us as
        // STATE_DIRTY, and we will know to rerun
        this._sources![i]._updateIfNecessary();

        // If the parent is loading, then we are waiting
        if (this._sources![i]._isLoading()) {
          isWaiting = true;
        }

        // If the parent changed value, it will mark us as STATE_DIRTY and we need to call update()
        // Cast because the _updateIfNecessary call above can change our state
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
      // isWaiting has now coallesced all of our parents' loading states
      this._setIsWaiting(isWaiting);

      // None of our parents changed value, so our value is up to date (STATE_CLEAN)
      this._state = STATE_CLEAN;
    }
  }

  /** Needed so that we can read whether _sources are loading in _updateIfNecessary */
  _isLoading(): boolean {
    return (this._stateFlags & WAITING_BIT) !== 0 || this._promise !== null;
  }

  /**
   * Remove ourselves from the owner graph and the computation graph
   */
  _disposeNode() {
    // If we've already been disposed, don't try to dispose twice
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
    // When a computation reads .loading() and tracks this LoadingState, they read _origin.isLoading
    // The reading computation node  will track this LoadingState instance as they would track any
    // other computation. To make sure that _origin.isLoading up to date, we call _updateIfNecessary
    this._origin._updateIfNecessary();
  }

  _isLoading(): boolean {
    return false;
  }

  /** Notify observers and downstream computation states that the loading state has changed */
  set(value: boolean) {
    if (this._origin._observers) {
      for (let i = 0; i < this._origin._observers.length; i++) {
        if (value) {
          // Eagerly update all computations because only the loading state could have changed
          this._origin._observers[i]._setIsWaiting(true);
        } else {
          // Lazily update computations (because we don't know whether the value has changed)
          this._origin._observers[i]._notify(STATE_CHECK);
        }
      }
    }
    this._notify(STATE_DIRTY);
  }

  /** Notify computations that observe this loading state directly that it has updated */
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

  /** Notify downstream computation states that the error state has changed */
  _notify(state: number) {
    if (this._observers) {
      for (let i = 0; i < this._observers.length; i++) {
        this._observers[i]._notify(state);
      }
    }
  }
}

/**
 * Instead of wiping the sources immediately on `update`, we compare them to the new sources
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
    else if (computation !== newSources[newSources.length - 1]) {
      // If the computation is the same as the last source we read, we don't need to add it to newSources
      // https://github.com/solidjs/solid/issues/46#issuecomment-515717924
      newSources.push(computation);
    }
  }
}

/**
 * Reruns a computation's _compute function, producing a new value and keeping track of dependencies.
 *
 * It handles the updating of sources and observers, disposal of previous executions,
 * and error handling if the _compute function throws. It also sets the node as loading
 * if it reads any parents that are currently loading.
 */
export function update<T>(node: Computation<T>) {
  const prevSources = newSources;
  const prevSourcesIndex = newSourcesIndex;
  const prevLoadingState = newLoadingState;

  newSources = null as Computation[] | null;
  newSourcesIndex = 0;
  newLoadingState = false;

  try {
    node.dispose(false);
    node.emptyDisposal();

    // Rerun the node's _compute function, setting node as owner and listener so that any
    // computations read are added to node's sources and any computations are automatically disposed
    // if `node` is rerun
    const result = compute(node, node._compute!, node);

    // Update the node's value
    node.write(result);

    // newLoadingState coallecesses if any of the sources we read were loading
    node._setIsWaiting(newLoadingState);
  } catch (error) {
    node._setError(error);
  } finally {
    if (newSources) {
      // If there are new sources, that means the end of the sources array has changed
      // newSourcesIndex keeps track of the index of the first new source
      // See track() above for more info

      // We need to remove any old sources after newSourcesIndex
      if (node._sources) removeSourceObservers(node, newSourcesIndex);

      // First we update our own sources array (uplinks)
      if (node._sources && newSourcesIndex > 0) {
        // If we shared some sources with the previous execution, we need to copy those over to the
        // new sources array

        // First we need to make sure the sources array is long enough to hold all the new sources
        node._sources.length = newSourcesIndex + newSources.length;

        // Then we copy the new sources over
        for (let i = 0; i < newSources.length; i++) {
          node._sources[newSourcesIndex + i] = newSources[i];
        }
      } else {
        // If we didn't share any sources with the previous execution, set the sources array to newSources
        node._sources = newSources;
      }

      // For each new source, we need to add this `node` to the source's observers array (downlinks)
      let source: SourceType;
      for (let i = newSourcesIndex; i < node._sources.length; i++) {
        source = node._sources[i];
        if (!source._observers) source._observers = [node];
        else source._observers.push(node);
      }
    } else if (node._sources && newSourcesIndex < node._sources.length) {
      // If there are no new sources, but the sources array is longer than newSourcesIndex,
      // that means the sources array has just shrunk so we remove the tail end
      removeSourceObservers(node, newSourcesIndex);
      node._sources.length = newSourcesIndex;
    }

    // Reset global context after computation
    newSources = prevSources;
    newSourcesIndex = prevSourcesIndex;
    newLoadingState = prevLoadingState;

    // By now, we have updated the node's value and sources array, so we can mark it as clean
    // TODO: This assumes that the computation didn't write to any signals, throw an error if it did
    node._state = STATE_CLEAN;
  }
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

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise#thenables
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

/**
 * A convenient wrapper that calls `compute` with the `owner` and `observer` and is guaranteed
 * to reset the global context after the computation is finished even if an error is thrown.
 */
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

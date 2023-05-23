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

import { Owner, getOwner, handleError, setCurrentOwner } from "./owner";
import {
  STATE_CLEAN,
  STATE_DIRTY,
  STATE_CHECK,
  STATE_DISPOSED,
} from "./constants";

export interface SignalOptions<T> {
  name?: string;
  equals?: ((prev: T, next: T) => boolean) | false;
}

export interface MemoOptions<T> extends SignalOptions<T> {
  initial?: T;
}

interface SourceType {
  _observers: ObserverType[] | null;
  updateIfNecessary(): void;
}

interface ObserverType {
  _sources: SourceType[] | null;
  notify(state: number): void;
  state(): LoadingState | null;
}

let currentObserver: Computation | null = null;

let newSources: SourceType[] | null = null,
  memoLoading = 0,
  newSourcesIndex = 0;

export class Computation<T = any> extends Owner {
  _init: boolean;
  _sources: SourceType[] | null;
  _observers: ObserverType[] | null;
  _lstate: LoadingState | null;
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
    this._sources = null;
    this._observers = null;
    this._compute = compute ?? null;
    if (isPromise(initialValue)) {
      this._lstate = new LoadingState(this, 1);
      this._value = undefined;
      initialValue.then((value) => {
        this.write(value);
        this._lstate!.change(-1);
      });
    } else {
      this._value = initialValue;
      this._lstate = null;
    }

    if (__DEV__)
      this.name = options?.name ?? (this._compute ? "computed" : "signal");
    if (options && options.equals !== undefined) this._equals = options.equals;
  }

  read(): T {
    if (this._state === STATE_DISPOSED) return this._value!;

    memoLoading += this._lstate == null ? 0 : +this._lstate.read();

    if (currentObserver) {
      if (
        !newSources &&
        currentObserver._sources &&
        currentObserver._sources[newSourcesIndex] == this
      ) {
        newSourcesIndex++;
      } else if (!newSources) newSources = [this];
      else newSources.push(this);
    }

    if (this._compute) this.updateIfNecessary();

    return this._value!;
  }

  state(): LoadingState {
    if (!this._lstate) {
      this._lstate = new LoadingState(this, 0);
    }
    return this._lstate;
  }

  write(value: T): T {
    if (!this._equals || !this._equals(this._value!, value)) {
      memoLoading += setMaybePromise(this, value);
      if (!isPromise(value)) {
        if (this._observers) {
          for (let i = 0; i < this._observers.length; i++) {
            this._observers[i].notify(STATE_DIRTY);
          }
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
  }

  updateIfNecessary() {
    if (this._state === STATE_CHECK) {
      for (let i = 0; i < this._sources!.length; i++) {
        this._sources![i].updateIfNecessary();
        if ((this._state as number) === STATE_DIRTY) {
          // Stop the loop here so we won't trigger updates on other parents unnecessarily
          // If our computation changes to no longer use some sources, we don't
          // want to update() a source we used last time, but now don't use.
          break;
        }
      }
    }

    if (this._state === STATE_DIRTY) update(this);
    else this._state = STATE_CLEAN;
  }

  disposeNode() {
    this._state = STATE_DISPOSED;
    if (this._disposal) this.emptyDisposal();
    if (this._sources) removeSourceObservers(this, 0);
    if (this._prevSibling) this._prevSibling._nextSibling = null;
    this._parent = null;
    this._sources = null;
    this._observers = null;
    this._prevSibling = null;
    this._context = null;
  }
}

/**
 * We attach a LoadingState node to each Computation node to track async sources.
 * When a Computation node returns an async value it creates a LoadingState node with value 1.
 * When the async value resolves, it calls change(-1) on the LoadingState node.
 * 
 * When a Computation node reads a LoadingState node, it adds the LoadingState node to its sources.
 */
class LoadingState {
  _observers: ObserverType[] | null;
  _value: number;
  _origin: Computation;
  constructor(origin: Computation, value: number) {
    this._origin = origin;
    this._observers = null;
    this._value = value;
  }
  updateIfNecessary() {}
  change(value: number) {
    this.set(this._value + value);
  }
  read() {
    if (currentObserver) {
      if (
        !newSources &&
        currentObserver._sources &&
        currentObserver._sources[newSourcesIndex] == this
      ) {
        newSourcesIndex++;
      } else if (!newSources) newSources = [this];
      else newSources.push(this);
    }

    return this._value != 0;
  }
  set(value: number) {
    if (this._value === value) return;

    const wasZero = Math.min(this._value, 1);
    const isZero = Math.min(value, 1);
    this._value = value;
    if (wasZero != isZero) {
      if (this._origin._observers) {
        for (let i = 0; i < this._origin._observers.length; i++) {
          this._origin._observers[i].state()!.change(isZero - wasZero);
        }
      }
      if (this._observers) {
        for (let i = 0; i < this._observers.length; i++) {
          this._observers[i].notify(STATE_DIRTY);
        }
      }
    }
  }
}

function setMaybePromise(node: Computation, value: any): 0 | 1 {
  if (isPromise(value)) {
    value.then((v) => {
      node._lstate!.change(-1);
      node.write(v);
    });
    return 1;
  } else {
    node._value = value;
    return 0;
  }
}

function cleanup(node: Computation) {
  if (node._nextSibling && node._nextSibling._parent === node)
    node.dispose(false);
  if (node._disposal) node.emptyDisposal();
  node._context = null;
}

/**
 * This is the main tracking code when a computation's _compute function is rerun.
 * It handles the updating of sources and observers, disposal of previous executions,
 * and error handling if the _compute function throws.
 *
 * It also checks the count of asynchronous computations and sets the node's loading state (lstate)
 * to the number of sources that are currently waiting on a value or have any parents waiting on a value
 */
export function update(node: Computation) {
  let prevObservers = newSources,
    prevObserversIndex = newSourcesIndex;

  newSources = null as Computation[] | null;
  newSourcesIndex = 0;
  memoLoading = 0;

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

    if (node._init) {
      node.write(result);
    } else {
      memoLoading += setMaybePromise(node, result);
      node._init = true;
    }

    if (node._lstate) node._lstate.set(memoLoading);
    else if (memoLoading) node._lstate = new LoadingState(node, memoLoading);
  } catch (error) {
    handleError(node, error);

    if (node._state === STATE_DIRTY) {
      cleanup(node);
      if (node._sources) removeSourceObservers(node, 0);
    }

    return;
  }

  newSources = prevObservers;
  newSourcesIndex = prevObserversIndex;

  node._state = STATE_CLEAN;
}

function removeSourceObservers(node: ObserverType, index: number) {
  let source: SourceType, swap: number;
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

/**
 * Returns the current value stored inside the given compute function without triggering any
 * dependencies. Use `untrack` if you want to also disable owner tracking.
 */
export function untrack<T>(fn: () => T): T {
  if (currentObserver === null) return fn();
  return compute<T>(getOwner(), fn, null);
}

export function compute<T>(
  owner: Owner | null,
  compute: (val: T) => T,
  observer: Computation | null
): T {
  const prevOwner = setCurrentOwner(owner);
  const prevObserver = currentObserver;
  currentObserver = observer;

  try {
    return compute(observer ? observer._value : undefined);
  } finally {
    setCurrentOwner(prevOwner);
    currentObserver = prevObserver;
  }
}

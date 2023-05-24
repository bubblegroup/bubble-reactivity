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

// General thoughts:
// - can we be less promise-oriented in the core (and is it a win)
// - I'm a bit spooked by the loading state propagation; we might want to
//   explicitly lay out our options and expectations here, and the performance
//   bounds each approach can get.

// I think LoadingStates might get marked (dirty/check) too late. If you have...
// - A: Computation
// - B: Comptuation that depends on A's loading state (but not A)
// - C: Computation that depends on B.
//
// Then something that dirties A in a way that makes its next run have a
// different loading state than its previous run, it brings you to a graph where
// you can read C then A then C again, and get two different values for C!
//
// (Am I missing something?)


import { Owner, getOwner, handleError, setCurrentOwner } from "./owner";
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
  updateIfNecessary(): void;
}

interface ObserverType {
  _sources: SourceType[] | null;
  notify(state: number): void;

  // Needed to handle a second eager propagation pass of number of parents that currently have
  // a promise pending
  _loading: LoadingState | null;
}

let currentObserver: ObserverType | null = null;

let newSources: SourceType[] | null = null;
let memoLoading = 0;
let newSourcesIndex = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class Computation<T = any> extends Owner {
  _init: boolean;
  _sources: SourceType[] | null;
  _observers: ObserverType[] | null;
  _loading: LoadingState<T> | null;
  _value: T | undefined;
  _compute: null | (() => T | Promise<T>);
  name: string | undefined;
  // creates a new function object every time (alas)
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
      this._loading = new LoadingState(this, 1);
      this._value = undefined;
      void initialValue.then((value) => {
        this.write(value);
        this._loading!.change(-1);
      });
    } else {
      this._value = initialValue;
      this._loading = null;
    }

    if (__DEV__)
      this.name = options?.name ?? (this._compute ? "computed" : "signal");
    if (options && options.equals !== undefined) this._equals = options.equals;
  }

  read(): T {
    if (this._state === STATE_DISPOSED) return this._value!;

    if (this._compute) this.updateIfNecessary();

    memoLoading +=
      this._loading == null ? 0 : +Math.min(this._loading._value, 1);

    track(this);

    return this._value!;
  }

  wait(): T {
    if (this._state === STATE_DISPOSED) return this._value!;

    if (this._compute) this.updateIfNecessary();

    if (!this._loading) {
      track(this);
      return this._value!;
    }

    track(this._loading);
    const isLoading = this._loading._value !== 0;
    if (isLoading) {
      memoLoading++;
      // could in theory use the same object every time (and not capture a stack
      // trace); may be a thing we want to only do in debug mode
      throw new NotReadyError();
    }

    return this._value!;
  }

  loading(): boolean {
    if (!this._loading) {
      this._loading = new LoadingState(this, 0);
    }
    track(this._loading);
    return this._loading._value !== 0;
  }

  write(value: T | Promise<T>): T {
    // I'm not sure about this connection between promises<->loadingness -- it
    // seems like the core could be agnostic to why things are loading/how to
    // decide they're ready, and it might separate some concerns better.
    if (isPromise(value)) {
      void value.then((v) => {
        this._loading!.change(-1);
        this.write(v);
      });
      memoLoading++;
    } else if (!this._equals || !this._equals(this._value!, value)) {
      this._value = value;
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
        // hah, very unfortunate cast here (but I see why TS asks for it)
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
    if (this._sources) removeSourceObservers(this, 0);
    this._sources = null;
    this._observers = null;
    super.disposeNode();
  }
}

/**
 * We attach a LoadingState node to each Computation node to track async sources.
 * When a Computation node returns an async value it creates a LoadingState node with value 1.
 * When the async value resolves, it calls change(-1) on the LoadingState node.
 *
 * When a Computation node reads a LoadingState node, it adds the LoadingState node to its sources.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any

// Probably want to name the interface this implements (it's a Source?)
class LoadingState<T = any> {
  _observers: ObserverType[] | null;
  _value: number;
  _origin: Computation<T>;

  constructor(origin: Computation<T>, value: number) {
    this._origin = origin;
    this._observers = null;
    this._value = value;
  }

  updateIfNecessary() {
    // Stubbed out to match the required interface
    // (the lint rule requres at least a comment for empty functions)
  }

  change(value: number) {
    this.set(this._value + value);
  }

  set(value: number) {
    if (this._value === value) return;

    // These are named and defined pretty confusingly -- they sound like
    // booleans. Do we just want isZero / wasZero (booleans) and a delta
    // (+1 | -1 | 0)?
    const wasZero = Math.min(this._value, 1);
    const isZero = Math.min(value, 1);

    this._value = value;
    if (wasZero != isZero) {
      if (this._origin._observers) {
        // Maintaining this "shadow graph" might be very expensive; this
        // approach doesn't guarantee O(V+E) work AFAICT, because it pushes
        // changes in loadingness forwards too eagerly. Worth talking through.
        for (let i = 0; i < this._origin._observers.length; i++) {
          this._origin._observers[i]._loading!.change(isZero - wasZero);
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
  // mobx does some primitive deduplication here (keepts a field for
  // "computation-rerun-id this was last added to" on sources); no idea if
  // that's a win or not. (probably not?)
  if (currentObserver) {
    if (
      !newSources &&
      currentObserver._sources &&
      currentObserver._sources[newSourcesIndex] == computation
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

    // treating the first run specially seems iffy to me, especially if the
    // promise magic is different -- how should I/the caller be reasoning about
    // this?
    if (node._init) {
      node.write(result);
    } else {
      if (isPromise(result)) {
        void result.then((v) => {
          // (yes this isn't the first time this showed up) is this correct? if
          // you depend on things that aren't ready, but you return a promise,
          // and that promise resolves, is this the right outcome?
          node._loading!.change(-1);
          node.write(v);
        });
        memoLoading++;
      } else {
        node._value = result;
      }
      node._init = true;
    }

    // this seems sketchy vis-a-vis the "computation returns a promise" case --
    // if we decrement the loading count when the promise resolves, we probably
    // ought to increment it when the promise is discovered?
    if (node._loading) node._loading.set(memoLoading);
    else if (memoLoading) node._loading = new LoadingState(node, memoLoading);
  } catch (error) {
    handleError(node, error);

    // How do you end up here if it wasn't dirty?
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
    // This makes everything a fold, which looks like carryover from solid that
    // we just haven't thought much about. IMO this is sensible for effects, and
    // bogus for memos -- though there could be some other answer here that
    // makes it sensible for some class of pure nodes.
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

/**
 * Owner tracking is used to enable nested tracking scopes with automatic cleanup.
 * We also use owners to also keep track of which error handling context we are in.
 *
 * If you write the following
 *
 *   const a = createOwner(() => {
 *     const b = createOwner(() => {});
 *
 *     const c = createOwner(() => {
 *       const d = createOwner(() => {});
 *     });
 *
 *     const e = createOwner(() => {});
 *   });
 *
 * The owner tree will look like this:
 *
 *    a
 *   /|\
 *  b-c-e
 *    |
 *    d
 *
 * Following the _nextSibling pointers of each owner will first give you its children, and then its siblings.
 * a -> b -> c -> d -> e
 *
 * Note that the owner tree is largely orthogonal to the reactivity tree, and is much closer to the component tree.
 */

import { STATE_CLEAN, STATE_DISPOSED } from "./constants";
import type { Computation } from "./core";

export type ContextRecord = Record<string | symbol, unknown>;
export type Disposable = () => void;

export const HANDLER = Symbol("ERROR_HANDLER");

let currentOwner: Owner | null = null;

export function setCurrentOwner(owner: Owner | null) {
  const out = currentOwner;
  currentOwner = owner;
  return out;
}

/**
 * Returns the currently executing parent owner.
 */
export function getOwner(): Owner | null {
  return currentOwner;
}

export class Owner {
  _parent: Owner | null;
  _nextSibling: Owner | null;
  _prevSibling: Owner | null;
  _state: number = STATE_CLEAN;

  _disposal: Disposable | Disposable[] | null = null;
  _context: null | ContextRecord = null;
  _compute: null | unknown = null;

  constructor(signal = false) {
    this._parent = null;
    this._nextSibling = null;
    this._prevSibling = null;
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

    const head = self ? this._prevSibling : this;
    let current = this._nextSibling as Computation | null;

    while (current && current._parent === this) {
      current.dispose(true);
      current.disposeNode();
      current = current._nextSibling as Computation;
    }

    if (self) this.disposeNode();
    if (current) current._prevSibling = !self ? this : this._prevSibling;
    if (head) head._nextSibling = current;
  }

  disposeNode() {
    if (this._prevSibling) this._prevSibling._nextSibling = null;
    this._parent = null;
    this._prevSibling = null;
    this._context = null;
    this._state = STATE_DISPOSED;
    if (this._disposal) this.emptyDisposal();
  }

  emptyDisposal() {
    if (Array.isArray(this._disposal)) {
      for (let i = 0; i < this._disposal.length; i++) {
        const callable = this._disposal[i];
        callable.call(callable);
      }
    } else {
      this._disposal!.call(this._disposal);
    }

    this._disposal = null;
  }
}

/**
 * Runs the given function when the parent owner computation is being disposed.
 */
export function onCleanup(disposable: Disposable): void {
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

export function lookup(owner: Owner | null, key: string | symbol): unknown {
  if (!owner) return;

  let current: Owner | null = owner;
  let value;

  while (current) {
    value = current._context?.[key];
    if (value !== undefined) return value;
    current = current._parent;
  }
}

export function handleError(owner: Owner | null, error: unknown) {
  const handler = lookup(owner, HANDLER) as
    | undefined
    | ((error: Error) => void);

  if (!handler) throw error;

  try {
    const coercedError =
      error instanceof Error ? error : Error(JSON.stringify(error));
    handler(coercedError);
  } catch (error) {
    handleError(owner!._parent, error);
  }
}

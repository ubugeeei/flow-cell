/* @flow strict */

import {
  currentScope,
  notifyListeners,
  registerReadable,
  trackReadable,
} from "./Internal";
import type {
  Cell,
  GraphMeta,
  Listener,
  NodeOptions,
  Unsubscribe,
  Writable,
} from "./Types";

export class CellImpl<T> implements Writable<T> {
  _initial: T;
  _value: T;
  _listeners: Set<Listener> = new Set();
  _meta: GraphMeta;

  constructor(initial: T, options?: NodeOptions): void {
    this._initial = initial;
    this._value = initial;
    this._meta = registerReadable(
      this,
      "cell",
      options,
      scope => "value",
      scope => (scope == null ? this._listeners.size : scope._getCellSubscriberCount(this)),
      scope => []
    );
  }

  get(): T {
    trackReadable(this);

    const scope = currentScope();
    if (scope != null) {
      return scope._getCell(this);
    }

    return this._value;
  }

  subscribe(listener: Listener): Unsubscribe {
    const scope = currentScope();
    if (scope != null) {
      return scope._subscribeCell(this, listener);
    }

    return this._subscribeGlobal(listener);
  }

  set(value: T): void {
    const scope = currentScope();
    if (scope != null) {
      scope._setCell(this, value);
      return;
    }

    this._setGlobal(value);
  }

  update(fn: (value: T) => T): void {
    this.set(fn(this.get()));
  }

  _getInitial(): T {
    return this._initial;
  }

  _setGlobal(value: T): void {
    if (Object.is(this._value, value)) {
      return;
    }

    this._value = value;
    notifyListeners(this._listeners);
  }

  _subscribeGlobal(listener: Listener): Unsubscribe {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }
}

export function cell<T>(initial: T, options?: NodeOptions): Cell<T> {
  return new CellImpl(initial, options);
}

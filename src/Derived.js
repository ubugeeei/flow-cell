/* @flow strict */

import {
  currentScope,
  notifyListeners,
  registerReadable,
  sameReadables,
  trackReadable,
  uniqueReadables,
  withDependencyTracking,
} from "./Internal";
import type {
  AnyReadable,
  AsyncDerivedFactory,
  DependencyCollector,
  Derived,
  DerivedFactory,
  Getter,
  GraphMeta,
  Listener,
  NodeOptions,
  Readable,
  Unsubscribe,
} from "./Types";

type NormalizedDerivation<T> = {
  +explicitDeps: Array<AnyReadable>,
  +read: () => T,
  +options: ?NodeOptions,
};

function createGetter(): Getter {
  return (<T>(readable: Readable<T>): T => {
    trackReadable(readable);
    return readable.get();
  });
}

function normalizeDerivation<T>(
  depsOrFn: AnyReadable | $ReadOnlyArray<AnyReadable> | (() => T) | ((get: Getter) => T),
  maybeFn?: ((...args: Array<any>) => T) | NodeOptions,
  options?: NodeOptions
): NormalizedDerivation<T> {
  if (typeof depsOrFn === "function" && typeof maybeFn !== "function") {
    return {
      explicitDeps: [],
      read: () => (depsOrFn as any)(createGetter()),
      options: maybeFn ?? options,
    };
  }

  const explicitDeps = Array.isArray(depsOrFn)
    ? [...(depsOrFn as $ReadOnlyArray<AnyReadable>)]
    : [depsOrFn as any];
  const fn = maybeFn;

  if (typeof fn !== "function") {
    throw new Error("derived requires a compute function when dependencies are provided.");
  }

  return {
    explicitDeps,
    read: () => fn(...explicitDeps.map(dep => dep.get())),
    options,
  };
}

export class DerivedImpl<T> implements Readable<T> {
  _read: () => T;
  _explicitDeps: Array<AnyReadable>;
  _deps: Array<AnyReadable> = [];
  _depUnsubscribers: Array<Unsubscribe> = [];
  _listeners: Set<Listener> = new Set();
  _state: "dirty" | "value" | "error" = "dirty";
  _value: any;
  _error: any;
  _onDependencyChange: Listener;
  _meta: GraphMeta;

  constructor(derivation: NormalizedDerivation<T>): void {
    this._read = derivation.read;
    this._explicitDeps = derivation.explicitDeps;
    this._onDependencyChange = () => {
      if (this._state !== "dirty") {
        this._state = "dirty";
        notifyListeners(this._listeners);
      }
    };
    this._meta = registerReadable(
      this,
      "derived",
      derivation.options,
      scope => (scope == null ? this._state : scope._getDerivedStatus(this)),
      scope => (scope == null ? this._listeners.size : scope._getDerivedSubscriberCount(this)),
      scope => (scope == null ? this._deps : scope._getDerivedDependencies(this))
    );
  }

  get(): T {
    trackReadable(this);

    const scope = currentScope();
    if (scope != null) {
      return scope._getDerived(this);
    }

    if (this._state === "dirty") {
      this._evaluate();
    }

    if (this._state === "error") {
      throw this._error;
    }

    return this._value as T;
  }

  subscribe(listener: Listener): Unsubscribe {
    const scope = currentScope();
    if (scope != null) {
      return scope._subscribeDerived(this, listener);
    }

    this._listeners.add(listener);

    return () => {
      this._listeners.delete(listener);

      if (this._listeners.size === 0) {
        this._releaseDependencies();
      }
    };
  }

  _evaluate(): void {
    const trackedDeps: Set<AnyReadable> = new Set(this._explicitDeps);
    const collector: DependencyCollector = {
      add: (readable: AnyReadable) => {
        trackedDeps.add(readable);
      },
    };

    try {
      const value = withDependencyTracking(collector, this._read);
      this._value = value;
      this._error = undefined;
      this._state = "value";
    } catch (error) {
      this._error = error;
      this._state = "error";
    } finally {
      this._bindDependencies(Array.from(trackedDeps));
    }
  }

  _bindDependencies(deps: $ReadOnlyArray<AnyReadable>): void {
    const nextDeps = uniqueReadables(deps).filter(dep => dep !== this);

    if (sameReadables(this._deps, nextDeps)) {
      return;
    }

    for (const unsubscribe of this._depUnsubscribers) {
      unsubscribe();
    }

    this._deps = nextDeps;
    this._depUnsubscribers = nextDeps.map(dep => dep.subscribe(this._onDependencyChange));
  }

  _releaseDependencies(): void {
    for (const unsubscribe of this._depUnsubscribers) {
      unsubscribe();
    }

    this._deps = [];
    this._depUnsubscribers = [];
    this._state = "dirty";
    this._value = undefined;
    this._error = undefined;
  }
}

function createDerived<T>(
  depsOrFn: AnyReadable | $ReadOnlyArray<AnyReadable> | (() => T) | ((get: Getter) => T),
  maybeFn?: ((...args: Array<any>) => T) | NodeOptions,
  options?: NodeOptions
): Derived<T> {
  return new DerivedImpl(normalizeDerivation(depsOrFn, maybeFn, options));
}

export const derived: DerivedFactory = createDerived as any;

export class AsyncDerivedImpl<T> implements Readable<T> {
  _read: () => Promise<T>;
  _explicitDeps: Array<AnyReadable>;
  _deps: Array<AnyReadable> = [];
  _depUnsubscribers: Array<Unsubscribe> = [];
  _listeners: Set<Listener> = new Set();
  _state: "idle" | "pending" | "fulfilled" | "rejected" = "idle";
  _value: any;
  _error: any;
  _promise: ?Promise<mixed>;
  _version: number = 0;
  _onDependencyChange: Listener;
  _meta: GraphMeta;

  constructor(derivation: NormalizedDerivation<Promise<T>>): void {
    this._read = derivation.read;
    this._explicitDeps = derivation.explicitDeps;
    this._onDependencyChange = () => {
      this._version += 1;
      this._state = "idle";
      this._promise = null;
      notifyListeners(this._listeners);
    };
    this._meta = registerReadable(
      this,
      "asyncDerived",
      derivation.options,
      scope => (scope == null ? this._state : scope._getAsyncDerivedStatus(this)),
      scope => (scope == null ? this._listeners.size : scope._getAsyncDerivedSubscriberCount(this)),
      scope => (scope == null ? this._deps : scope._getAsyncDerivedDependencies(this))
    );
  }

  get(): T {
    trackReadable(this);

    const scope = currentScope();
    if (scope != null) {
      return scope._getAsyncDerived(this);
    }

    if (this._state === "fulfilled") {
      return this._value as T;
    }

    if (this._state === "rejected") {
      throw this._error;
    }

    if (this._state === "idle") {
      this._start();
    }

    if (this._state === "fulfilled") {
      return this._value as T;
    }

    if (this._state === "rejected") {
      throw this._error;
    }

    throw this._promise;
  }

  subscribe(listener: Listener): Unsubscribe {
    const scope = currentScope();
    if (scope != null) {
      return scope._subscribeAsyncDerived(this, listener);
    }

    this._listeners.add(listener);

    return () => {
      this._listeners.delete(listener);

      if (this._listeners.size === 0) {
        this._releaseDependencies();
      }
    };
  }

  _start(): void {
    const runVersion = this._version;
    const trackedDeps: Set<AnyReadable> = new Set(this._explicitDeps);
    const collector: DependencyCollector = {
      add: (readable: AnyReadable) => {
        trackedDeps.add(readable);
      },
    };

    let result;

    try {
      result = withDependencyTracking(collector, this._read);
    } catch (error) {
      this._error = error;
      this._state = "rejected";
      this._bindDependencies(Array.from(trackedDeps));
      return;
    }

    this._bindDependencies(Array.from(trackedDeps));

    const promise = Promise.resolve(result).then(
      value => {
        if (this._version === runVersion) {
          this._value = value;
          this._error = undefined;
          this._state = "fulfilled";
          this._promise = null;
          notifyListeners(this._listeners);
        }

        return value;
      },
      error => {
        if (this._version === runVersion) {
          this._error = error;
          this._state = "rejected";
          this._promise = null;
          notifyListeners(this._listeners);
        }

        return undefined;
      }
    );

    this._promise = promise;
    this._state = "pending";
  }

  _bindDependencies(deps: $ReadOnlyArray<AnyReadable>): void {
    const nextDeps = uniqueReadables(deps).filter(dep => dep !== this);

    if (sameReadables(this._deps, nextDeps)) {
      return;
    }

    for (const unsubscribe of this._depUnsubscribers) {
      unsubscribe();
    }

    this._deps = nextDeps;
    this._depUnsubscribers = nextDeps.map(dep => dep.subscribe(this._onDependencyChange));
  }

  _releaseDependencies(): void {
    this._version += 1;

    for (const unsubscribe of this._depUnsubscribers) {
      unsubscribe();
    }

    this._deps = [];
    this._depUnsubscribers = [];
    this._state = "idle";
    this._value = undefined;
    this._error = undefined;
    this._promise = null;
  }
}

function createAsyncDerived<T>(
  depsOrFn: AnyReadable | $ReadOnlyArray<AnyReadable> | (() => Promise<T>) | ((get: Getter) => Promise<T>),
  maybeFn?: ((...args: Array<any>) => Promise<T>) | NodeOptions,
  options?: NodeOptions
): Derived<T> {
  return new AsyncDerivedImpl(normalizeDerivation(depsOrFn, maybeFn, options));
}

export const asyncDerived: AsyncDerivedFactory = createAsyncDerived as any;

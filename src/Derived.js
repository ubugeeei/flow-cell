/* @flow strict */

import {
  cancelPendingListener,
  createDependencyTracker,
  currentScope,
  isPromiseLike,
  notifyListeners,
  registerReadable,
  replaceDependencySubscriptions,
  trackReadable,
  unsubscribeAll,
  withDependencyTracking,
} from "./Internal";
import type {
  AnyReadable,
  AsyncDerivedFactory,
  Derived,
  DerivedFactory,
  Getter,
  GraphMeta,
  Listener,
  NodeOptions,
  Readable,
  Unsubscribe,
} from "./Types";

function defer(fn: () => void): void {
  setTimeout(fn, 0);
}

type NormalizedDerivation<T> = {
  +explicitDeps: Array<AnyReadable>,
  +read: () => T,
  +options: ?NodeOptions,
};

function runWithGetter<T>(fn: (get: Getter) => T): T {
  let active = true;
  const getter: Getter = (<Value>(readable: Readable<Value>): Value => {
    if (!active) {
      throw new Error("FlowCell getter can only be used synchronously during derived computation.");
    }

    trackReadable(readable);
    return readable.get();
  });

  try {
    return fn(getter);
  } finally {
    active = false;
  }
}

function normalizeDerivation<T>(
  depsOrFn: AnyReadable | $ReadOnlyArray<AnyReadable> | (() => T) | ((get: Getter) => T),
  maybeFn?: ((...args: Array<any>) => T) | NodeOptions,
  options?: NodeOptions
): NormalizedDerivation<T> {
  if (typeof depsOrFn === "function" && typeof maybeFn !== "function") {
    return {
      explicitDeps: [],
      read: () => runWithGetter(depsOrFn as any),
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
  _state: "dirty" | "pending" | "value" | "error" = "dirty";
  _value: any;
  _error: any;
  _promise: ?Promise<mixed>;
  _version: number = 0;
  _evaluating: boolean = false;
  _cleanupToken: number = 0;
  _onDependencyChange: Listener;
  _meta: GraphMeta;

  constructor(derivation: NormalizedDerivation<T>): void {
    this._read = derivation.read;
    this._explicitDeps = derivation.explicitDeps;
    this._onDependencyChange = () => {
      if (this._state !== "dirty") {
        this._version += 1;
        this._state = "dirty";
        this._promise = null;
        notifyListeners(this._listeners);
        this._scheduleUnobservedRelease();
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

    if (this._evaluating) {
      throw new Error("FlowCell derived cycle detected.");
    }

    if (this._state === "dirty") {
      this._evaluate();
    }

    if (this._state === "pending") {
      throw this._promise;
    }

    if (this._state === "error") {
      const error = this._error;
      this._scheduleUnobservedRelease();
      throw error;
    }

    const value = this._value as T;
    this._scheduleUnobservedRelease();
    return value;
  }

  subscribe(listener: Listener): Unsubscribe {
    const scope = currentScope();
    if (scope != null) {
      return scope._subscribeDerived(this, listener);
    }

    this._cleanupToken += 1;
    this._listeners.add(listener);

    return () => {
      this._listeners.delete(listener);
      cancelPendingListener(listener);

      if (this._listeners.size === 0) {
        this._releaseDependencies();
      }
    };
  }

  _evaluate(): void {
    if (this._evaluating) {
      throw new Error("FlowCell derived cycle detected.");
    }

    const runVersion = this._version;
    const dependencyTracker = createDependencyTracker(this._explicitDeps);

    this._evaluating = true;

    try {
      const value = withDependencyTracking(dependencyTracker.collector, this._read);
      this._value = value;
      this._error = undefined;
      this._promise = null;
      this._state = "value";
    } catch (error) {
      if (isPromiseLike(error)) {
        const promise = Promise.resolve(error).then(
          () => {
            if (this._version === runVersion && this._state === "pending") {
              this._state = "dirty";
              this._promise = null;
              notifyListeners(this._listeners);
              this._scheduleUnobservedRelease();
            }

            return undefined;
          },
          thrown => {
            if (this._version === runVersion && this._state === "pending") {
              this._error = thrown;
              this._promise = null;
              this._state = "error";
              notifyListeners(this._listeners);
              this._scheduleUnobservedRelease();
            }

            return undefined;
          }
        );

        this._value = undefined;
        this._error = undefined;
        this._promise = promise;
        this._state = "pending";
      } else {
        this._error = error;
        this._promise = null;
        this._state = "error";
      }
    } finally {
      this._evaluating = false;
      this._bindDependencies(dependencyTracker.dependencies());
    }
  }

  _bindDependencies(deps: $ReadOnlyArray<AnyReadable>): void {
    const binding = replaceDependencySubscriptions(
      this._deps,
      this._depUnsubscribers,
      deps,
      this,
      dep => dep.subscribe(this._onDependencyChange)
    );

    if (binding == null) {
      return;
    }

    this._deps = binding.deps;
    this._depUnsubscribers = binding.unsubscribers;
  }

  _releaseDependencies(): void {
    this._version += 1;
    this._cleanupToken += 1;

    unsubscribeAll(this._depUnsubscribers);

    this._deps = [];
    this._depUnsubscribers = [];
    this._state = "dirty";
    this._value = undefined;
    this._error = undefined;
    this._promise = null;
  }

  _scheduleUnobservedRelease(): void {
    if (this._listeners.size !== 0 || this._state === "pending") {
      return;
    }

    const cleanupToken = this._cleanupToken + 1;
    this._cleanupToken = cleanupToken;

    defer(() => {
      if (this._cleanupToken === cleanupToken && this._listeners.size === 0) {
        this._releaseDependencies();
      }
    });
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
  _starting: boolean = false;
  _cleanupToken: number = 0;
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
      this._scheduleUnobservedRelease();
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

    if (this._starting) {
      throw new Error("FlowCell asyncDerived cycle detected.");
    }

    if (this._state === "fulfilled") {
      this._scheduleUnobservedRelease();
      return this._value as T;
    }

    if (this._state === "rejected") {
      const error = this._error;
      this._scheduleUnobservedRelease();
      throw error;
    }

    if (this._state === "idle") {
      this._start();
    }

    if (this._state === "fulfilled") {
      return this._value as T;
    }

    if (this._state === "rejected") {
      const error = this._error;
      this._scheduleUnobservedRelease();
      throw error;
    }

    throw this._promise;
  }

  subscribe(listener: Listener): Unsubscribe {
    const scope = currentScope();
    if (scope != null) {
      return scope._subscribeAsyncDerived(this, listener);
    }

    this._cleanupToken += 1;
    this._listeners.add(listener);

    return () => {
      this._listeners.delete(listener);
      cancelPendingListener(listener);

      if (this._listeners.size === 0) {
        this._releaseDependencies();
      }
    };
  }

  _start(): void {
    if (this._starting) {
      throw new Error("FlowCell asyncDerived cycle detected.");
    }

    const runVersion = this._version;
    const dependencyTracker = createDependencyTracker(this._explicitDeps);

    let result;

    this._starting = true;

    try {
      result = withDependencyTracking(dependencyTracker.collector, this._read);
    } catch (error) {
      if (isPromiseLike(error)) {
        const promise = Promise.resolve(error).then(
          () => {
            if (this._version === runVersion && this._state === "pending") {
              this._state = "idle";
              this._promise = null;
              notifyListeners(this._listeners);
              this._scheduleUnobservedRelease();
            }

            return undefined;
          },
          thrown => {
            if (this._version === runVersion && this._state === "pending") {
              this._error = thrown;
              this._state = "rejected";
              this._promise = null;
              notifyListeners(this._listeners);
              this._scheduleUnobservedRelease();
            }

            return undefined;
          }
        );

        this._value = undefined;
        this._error = undefined;
        this._promise = promise;
        this._state = "pending";
      } else {
        this._error = error;
        this._promise = null;
        this._state = "rejected";
      }
      this._bindDependencies(dependencyTracker.dependencies());
      this._starting = false;
      return;
    } finally {
      this._starting = false;
    }

    this._bindDependencies(dependencyTracker.dependencies());

    const promise = Promise.resolve(result).then(
      value => {
        if (this._version === runVersion) {
          this._value = value;
          this._error = undefined;
          this._state = "fulfilled";
          this._promise = null;
          notifyListeners(this._listeners);
          this._scheduleUnobservedRelease();
        }

        return value;
      },
      error => {
        if (this._version === runVersion) {
          this._error = error;
          this._state = "rejected";
          this._promise = null;
          notifyListeners(this._listeners);
          this._scheduleUnobservedRelease();
        }

        return undefined;
      }
    );

    this._promise = promise;
    this._state = "pending";
  }

  _bindDependencies(deps: $ReadOnlyArray<AnyReadable>): void {
    const binding = replaceDependencySubscriptions(
      this._deps,
      this._depUnsubscribers,
      deps,
      this,
      dep => dep.subscribe(this._onDependencyChange)
    );

    if (binding == null) {
      return;
    }

    this._deps = binding.deps;
    this._depUnsubscribers = binding.unsubscribers;
  }

  _releaseDependencies(): void {
    this._version += 1;
    this._cleanupToken += 1;

    unsubscribeAll(this._depUnsubscribers);

    this._deps = [];
    this._depUnsubscribers = [];
    this._state = "idle";
    this._value = undefined;
    this._error = undefined;
    this._promise = null;
  }

  _scheduleUnobservedRelease(): void {
    if (this._listeners.size !== 0 || this._state === "pending") {
      return;
    }

    const cleanupToken = this._cleanupToken + 1;
    this._cleanupToken = cleanupToken;

    defer(() => {
      if (this._cleanupToken === cleanupToken && this._listeners.size === 0) {
        this._releaseDependencies();
      }
    });
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

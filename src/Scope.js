/* @flow strict */

import { CellImpl } from "./Cell";
import { AsyncDerivedImpl, DerivedImpl } from "./Derived";
import {
  cancelPendingListener,
  clearDefaultScope,
  isPromiseLike,
  notifyListeners,
  preloadReadable,
  sameReadables,
  uniqueReadables,
  withDependencyTracking,
  withScope,
} from "./Internal";
import type {
  AnyReadable,
  Cell,
  DependencyCollector,
  Listener,
  Readable,
  Scope,
  ScopeSnapshot,
  Unsubscribe,
} from "./Types";

function defer(fn: () => void): void {
  setTimeout(fn, 0);
}

function createCellRecord(): { [string]: mixed } {
  return Object.create(null) as any;
}

function hasOwnCell(record: { [string]: mixed }, id: string): boolean {
  return Object.hasOwn(record, id);
}

type ScopedCellState<T> = {
  value: T,
  listeners: Set<Listener>,
};

type ScopedDerivedState = {
  deps: Array<AnyReadable>,
  depUnsubscribers: Array<Unsubscribe>,
  listeners: Set<Listener>,
  state: "dirty" | "pending" | "value" | "error",
  value: any,
  error: any,
  promise: ?Promise<mixed>,
  version: number,
  evaluating: boolean,
  cleanupToken: number,
  onDependencyChange: Listener,
};

type ScopedAsyncDerivedState = {
  deps: Array<AnyReadable>,
  depUnsubscribers: Array<Unsubscribe>,
  listeners: Set<Listener>,
  state: "idle" | "pending" | "fulfilled" | "rejected",
  value: any,
  error: any,
  promise: ?Promise<mixed>,
  version: number,
  starting: boolean,
  cleanupToken: number,
  onDependencyChange: Listener,
};

export class ScopeImpl implements Scope {
  _cellStates: WeakMap<CellImpl<any>, ScopedCellState<any>> = new WeakMap();
  _derivedStates: WeakMap<DerivedImpl<any>, ScopedDerivedState> = new WeakMap();
  _asyncDerivedStates: WeakMap<AsyncDerivedImpl<any>, ScopedAsyncDerivedState> = new WeakMap();
  _boundReadables: WeakMap<AnyReadable, AnyReadable> = new WeakMap();
  _touchedCells: Set<CellImpl<any>> = new Set();
  _createdDerivedStates: Set<ScopedDerivedState> = new Set();
  _createdAsyncDerivedStates: Set<ScopedAsyncDerivedState> = new Set();
  _snapshotCells: { [string]: mixed };
  _disposed: boolean = false;

  constructor(snapshot?: ScopeSnapshot): void {
    this._snapshotCells = createCellRecord();

    if (snapshot != null) {
      if (snapshot.version != null && snapshot.version !== 1) {
        throw new Error(`Unsupported FlowCell snapshot version: ${String(snapshot.version)}`);
      }

      if (
        snapshot.cells == null ||
        typeof snapshot.cells !== "object" ||
        Array.isArray(snapshot.cells)
      ) {
        throw new Error("FlowCell snapshot cells must be an object.");
      }

      const snapshotCells = snapshot.cells;
      for (const id of Object.keys(snapshotCells)) {
        this._snapshotCells[id] = (snapshotCells as any)[id];
      }
    }
  }

  get<T>(readable: Readable<T>): T {
    this._assertActive();
    return withScope(this, () => readable.get());
  }

  subscribe<T>(readable: Readable<T>, listener: Listener): Unsubscribe {
    this._assertActive();

    if (readable instanceof CellImpl) {
      return this._subscribeCell(readable, listener);
    }

    if (readable instanceof DerivedImpl) {
      return this._subscribeDerived(readable, listener);
    }

    if (readable instanceof AsyncDerivedImpl) {
      return this._subscribeAsyncDerived(readable, listener);
    }

    return withScope(this, () => readable.subscribe(listener));
  }

  set<T>(cellValue: Cell<T>, value: T): void {
    this._assertActive();

    if (cellValue instanceof CellImpl) {
      this._setCell(cellValue, value);
      return;
    }

    cellValue.set(value);
  }

  update<T>(cellValue: Cell<T>, fn: (value: T) => T): void {
    this.set(cellValue, fn(this.get(cellValue)));
  }

  bind<T, R: Readable<T>>(readable: R): R {
    this._assertActive();

    const existing = this._boundReadables.get(readable);
    if (existing != null) {
      return existing as any;
    }

    const maybeWritable: any = readable;
    const bound: any = {
      get: () => this.get(readable),
      subscribe: (listener: Listener) => this.subscribe(readable, listener),
    };

    if (
      typeof maybeWritable.set === "function" &&
      typeof maybeWritable.update === "function"
    ) {
      bound.set = (value: T) => this.set(readable as any, value);
      bound.update = (fn: (value: T) => T) => this.update(readable as any, fn);
    }

    const stableBound = Object.freeze(bound);
    this._boundReadables.set(readable, stableBound);
    return stableBound;
  }

  preload<T>(readable: Readable<T>): Promise<T> {
    this._assertActive();
    return preloadReadable(() => this.get(readable));
  }

  run<T>(fn: () => T): T {
    this._assertActive();
    return withScope(this, fn);
  }

  snapshot(): ScopeSnapshot {
    this._assertActive();

    const cells: { [string]: mixed } = createCellRecord();

    for (const cellValue of this._touchedCells) {
      if (!cellValue._serializable) {
        continue;
      }

      cells[cellValue._meta.id] = this._getCell(cellValue);
    }

    return { version: 1, cells };
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }

    this._disposed = true;
    clearDefaultScope(this);

    for (const state of this._createdDerivedStates) {
      state.version += 1;
      state.cleanupToken += 1;

      for (const unsubscribe of state.depUnsubscribers) {
        unsubscribe();
      }

      state.depUnsubscribers = [];
      state.deps = [];
      for (const listener of state.listeners) {
        cancelPendingListener(listener);
      }
      state.listeners.clear();
    }

    for (const state of this._createdAsyncDerivedStates) {
      state.version += 1;
      state.cleanupToken += 1;

      for (const unsubscribe of state.depUnsubscribers) {
        unsubscribe();
      }

      state.depUnsubscribers = [];
      state.deps = [];
      for (const listener of state.listeners) {
        cancelPendingListener(listener);
      }
      state.listeners.clear();
      state.promise = null;
    }

    for (const cellValue of this._touchedCells) {
      const state = this._cellStates.get(cellValue);

      if (state != null) {
        for (const listener of state.listeners) {
          cancelPendingListener(listener);
        }
        state.listeners.clear();
      }
    }
  }

  _assertActive(): void {
    if (this._disposed) {
      throw new Error("Cannot use a disposed FlowCell scope.");
    }
  }

  _getCell<T>(cellValue: CellImpl<T>): T {
    return this._getCellState(cellValue).value;
  }

  _setCell<T>(cellValue: CellImpl<T>, value: T): void {
    const state = this._getCellState(cellValue);

    if (Object.is(state.value, value)) {
      return;
    }

    state.value = value;
    notifyListeners(state.listeners);
  }

  _subscribeCell<T>(cellValue: CellImpl<T>, listener: Listener): Unsubscribe {
    const state = this._getCellState(cellValue);
    state.listeners.add(listener);

    return () => {
      state.listeners.delete(listener);
      cancelPendingListener(listener);
    };
  }

  _getCellSubscriberCount<T>(cellValue: CellImpl<T>): number {
    const state = this._cellStates.get(cellValue);
    return state == null ? 0 : state.listeners.size;
  }

  _getCellState<T>(cellValue: CellImpl<T>): ScopedCellState<T> {
    const existing = this._cellStates.get(cellValue);

    if (existing != null) {
      return existing;
    }

    const id = cellValue._meta.id;
    const hasSnapshotValue = hasOwnCell(this._snapshotCells, id);
    const value = hasSnapshotValue
      ? this._snapshotCells[id]
      : cellValue._getInitial();
    const state = {
      value: value as any,
      listeners: new Set<Listener>(),
    };

    this._touchedCells.add(cellValue);
    this._cellStates.set(cellValue, state);
    return state;
  }

  _getDerived<T>(derivedValue: DerivedImpl<T>): T {
    const state = this._getDerivedState(derivedValue);

    if (state.evaluating) {
      throw new Error("FlowCell scoped derived cycle detected.");
    }

    if (state.state === "dirty") {
      this._evaluateDerived(derivedValue, state);
    }

    if (state.state === "pending") {
      throw state.promise;
    }

    if (state.state === "error") {
      const error = state.error;
      this._scheduleScopedDerivedRelease(state);
      throw error;
    }

    const value = state.value as T;
    this._scheduleScopedDerivedRelease(state);
    return value;
  }

  _subscribeDerived<T>(derivedValue: DerivedImpl<T>, listener: Listener): Unsubscribe {
    const state = this._getDerivedState(derivedValue);
    state.cleanupToken += 1;
    state.listeners.add(listener);

    return () => {
      state.listeners.delete(listener);
      cancelPendingListener(listener);

      if (state.listeners.size === 0) {
        this._releaseScopedDerivedState(state);
      }
    };
  }

  _getDerivedStatus<T>(derivedValue: DerivedImpl<T>): string {
    const state = this._derivedStates.get(derivedValue);
    return state == null ? "dirty" : state.state;
  }

  _getDerivedSubscriberCount<T>(derivedValue: DerivedImpl<T>): number {
    const state = this._derivedStates.get(derivedValue);
    return state == null ? 0 : state.listeners.size;
  }

  _getDerivedDependencies<T>(derivedValue: DerivedImpl<T>): $ReadOnlyArray<AnyReadable> {
    const state = this._derivedStates.get(derivedValue);
    return state == null ? [] : state.deps;
  }

  _getDerivedState<T>(derivedValue: DerivedImpl<T>): ScopedDerivedState {
    const existing = this._derivedStates.get(derivedValue);

    if (existing != null) {
      return existing;
    }

    const state: ScopedDerivedState = {
      deps: [],
      depUnsubscribers: [],
      listeners: new Set(),
      state: "dirty",
      value: undefined,
      error: undefined,
      promise: null,
      version: 0,
      evaluating: false,
      cleanupToken: 0,
      onDependencyChange: () => {
        if (state.state !== "dirty") {
          state.version += 1;
          state.state = "dirty";
          state.promise = null;
          notifyListeners(state.listeners);
          this._scheduleScopedDerivedRelease(state);
        }
      },
    };

    this._derivedStates.set(derivedValue, state);
    this._createdDerivedStates.add(state);
    return state;
  }

  _evaluateDerived<T>(derivedValue: DerivedImpl<T>, state: ScopedDerivedState): void {
    if (state.evaluating) {
      throw new Error("FlowCell scoped derived cycle detected.");
    }

    const runVersion = state.version;
    const trackedDeps: Set<AnyReadable> = new Set(derivedValue._explicitDeps);
    const collector: DependencyCollector = {
      add: (readable: AnyReadable) => {
        trackedDeps.add(readable);
      },
    };

    state.evaluating = true;

    try {
      const value = withScope(this, () => withDependencyTracking(collector, derivedValue._read));
      state.value = value;
      state.error = undefined;
      state.promise = null;
      state.state = "value";
    } catch (error) {
      if (isPromiseLike(error)) {
        const promise = Promise.resolve(error).then(
          () => {
            if (state.version === runVersion && state.state === "pending") {
              state.state = "dirty";
              state.promise = null;
              notifyListeners(state.listeners);
              this._scheduleScopedDerivedRelease(state);
            }

            return undefined;
          },
          thrown => {
            if (state.version === runVersion && state.state === "pending") {
              state.error = thrown;
              state.promise = null;
              state.state = "error";
              notifyListeners(state.listeners);
              this._scheduleScopedDerivedRelease(state);
            }

            return undefined;
          }
        );

        state.value = undefined;
        state.error = undefined;
        state.promise = promise;
        state.state = "pending";
      } else {
        state.error = error;
        state.promise = null;
        state.state = "error";
      }
    } finally {
      state.evaluating = false;
      this._bindScopedDependencies(state, Array.from(trackedDeps), derivedValue);
    }
  }

  _releaseScopedDerivedState(state: ScopedDerivedState): void {
    state.version += 1;
    state.cleanupToken += 1;

    for (const unsubscribe of state.depUnsubscribers) {
      unsubscribe();
    }

    state.deps = [];
    state.depUnsubscribers = [];
    state.state = "dirty";
    state.value = undefined;
    state.error = undefined;
    state.promise = null;
  }

  _scheduleScopedDerivedRelease(state: ScopedDerivedState): void {
    if (state.listeners.size !== 0 || state.state === "pending") {
      return;
    }

    const cleanupToken = state.cleanupToken + 1;
    state.cleanupToken = cleanupToken;

    defer(() => {
      if (!this._disposed && state.cleanupToken === cleanupToken && state.listeners.size === 0) {
        this._releaseScopedDerivedState(state);
      }
    });
  }

  _getAsyncDerived<T>(derivedValue: AsyncDerivedImpl<T>): T {
    const state = this._getAsyncDerivedState(derivedValue);

    if (state.starting) {
      throw new Error("FlowCell scoped asyncDerived cycle detected.");
    }

    if (state.state === "fulfilled") {
      this._scheduleScopedAsyncDerivedRelease(state);
      return state.value as T;
    }

    if (state.state === "rejected") {
      const error = state.error;
      this._scheduleScopedAsyncDerivedRelease(state);
      throw error;
    }

    if (state.state === "idle") {
      this._startAsyncDerived(derivedValue, state);
    }

    if (state.state === "fulfilled") {
      return state.value as T;
    }

    if (state.state === "rejected") {
      const error = state.error;
      this._scheduleScopedAsyncDerivedRelease(state);
      throw error;
    }

    throw state.promise;
  }

  _subscribeAsyncDerived<T>(derivedValue: AsyncDerivedImpl<T>, listener: Listener): Unsubscribe {
    const state = this._getAsyncDerivedState(derivedValue);
    state.cleanupToken += 1;
    state.listeners.add(listener);

    return () => {
      state.listeners.delete(listener);
      cancelPendingListener(listener);

      if (state.listeners.size === 0) {
        this._releaseScopedAsyncDerivedState(state);
      }
    };
  }

  _getAsyncDerivedStatus<T>(derivedValue: AsyncDerivedImpl<T>): string {
    const state = this._asyncDerivedStates.get(derivedValue);
    return state == null ? "idle" : state.state;
  }

  _getAsyncDerivedSubscriberCount<T>(derivedValue: AsyncDerivedImpl<T>): number {
    const state = this._asyncDerivedStates.get(derivedValue);
    return state == null ? 0 : state.listeners.size;
  }

  _getAsyncDerivedDependencies<T>(derivedValue: AsyncDerivedImpl<T>): $ReadOnlyArray<AnyReadable> {
    const state = this._asyncDerivedStates.get(derivedValue);
    return state == null ? [] : state.deps;
  }

  _getAsyncDerivedState<T>(derivedValue: AsyncDerivedImpl<T>): ScopedAsyncDerivedState {
    const existing = this._asyncDerivedStates.get(derivedValue);

    if (existing != null) {
      return existing;
    }

    const state: ScopedAsyncDerivedState = {
      deps: [],
      depUnsubscribers: [],
      listeners: new Set(),
      state: "idle",
      value: undefined,
      error: undefined,
      promise: null,
      version: 0,
      starting: false,
      cleanupToken: 0,
      onDependencyChange: () => {
        state.version += 1;
        state.state = "idle";
        state.promise = null;
        notifyListeners(state.listeners);
        this._scheduleScopedAsyncDerivedRelease(state);
      },
    };

    this._asyncDerivedStates.set(derivedValue, state);
    this._createdAsyncDerivedStates.add(state);
    return state;
  }

  _startAsyncDerived<T>(derivedValue: AsyncDerivedImpl<T>, state: ScopedAsyncDerivedState): void {
    if (state.starting) {
      throw new Error("FlowCell scoped asyncDerived cycle detected.");
    }

    const runVersion = state.version;
    const trackedDeps: Set<AnyReadable> = new Set(derivedValue._explicitDeps);
    const collector: DependencyCollector = {
      add: (readable: AnyReadable) => {
        trackedDeps.add(readable);
      },
    };

    let result;

    state.starting = true;

    try {
      result = withScope(this, () => withDependencyTracking(collector, derivedValue._read));
    } catch (error) {
      if (isPromiseLike(error)) {
        const promise = Promise.resolve(error).then(
          () => {
            if (state.version === runVersion && state.state === "pending") {
              state.state = "idle";
              state.promise = null;
              notifyListeners(state.listeners);
              this._scheduleScopedAsyncDerivedRelease(state);
            }

            return undefined;
          },
          thrown => {
            if (state.version === runVersion && state.state === "pending") {
              state.error = thrown;
              state.state = "rejected";
              state.promise = null;
              notifyListeners(state.listeners);
              this._scheduleScopedAsyncDerivedRelease(state);
            }

            return undefined;
          }
        );

        state.value = undefined;
        state.error = undefined;
        state.promise = promise;
        state.state = "pending";
      } else {
        state.error = error;
        state.promise = null;
        state.state = "rejected";
      }
      this._bindScopedDependencies(state, Array.from(trackedDeps), derivedValue);
      state.starting = false;
      return;
    } finally {
      state.starting = false;
    }

    this._bindScopedDependencies(state, Array.from(trackedDeps), derivedValue);

    const promise = Promise.resolve(result).then(
      value => {
        if (state.version === runVersion) {
          state.value = value;
          state.error = undefined;
          state.state = "fulfilled";
          state.promise = null;
          notifyListeners(state.listeners);
          this._scheduleScopedAsyncDerivedRelease(state);
        }

        return value;
      },
      error => {
        if (state.version === runVersion) {
          state.error = error;
          state.state = "rejected";
          state.promise = null;
          notifyListeners(state.listeners);
          this._scheduleScopedAsyncDerivedRelease(state);
        }

        return undefined;
      }
    );

    state.promise = promise;
    state.state = "pending";
  }

  _releaseScopedAsyncDerivedState(state: ScopedAsyncDerivedState): void {
    state.version += 1;
    state.cleanupToken += 1;

    for (const unsubscribe of state.depUnsubscribers) {
      unsubscribe();
    }

    state.deps = [];
    state.depUnsubscribers = [];
    state.state = "idle";
    state.value = undefined;
    state.error = undefined;
    state.promise = null;
  }

  _scheduleScopedAsyncDerivedRelease(state: ScopedAsyncDerivedState): void {
    if (state.listeners.size !== 0 || state.state === "pending") {
      return;
    }

    const cleanupToken = state.cleanupToken + 1;
    state.cleanupToken = cleanupToken;

    defer(() => {
      if (!this._disposed && state.cleanupToken === cleanupToken && state.listeners.size === 0) {
        this._releaseScopedAsyncDerivedState(state);
      }
    });
  }

  _bindScopedDependencies(
    state: ScopedDerivedState | ScopedAsyncDerivedState,
    deps: $ReadOnlyArray<AnyReadable>,
    owner: AnyReadable
  ): void {
    const nextDeps = uniqueReadables(deps).filter(dep => dep !== owner);

    if (sameReadables(state.deps, nextDeps)) {
      return;
    }

    for (const unsubscribe of state.depUnsubscribers) {
      unsubscribe();
    }

    state.deps = nextDeps;
    state.depUnsubscribers = nextDeps.map(dep => this.subscribe(dep, state.onDependencyChange));
  }
}

export function createScope(snapshot?: ScopeSnapshot): Scope {
  return new ScopeImpl(snapshot);
}

export function dehydrate(scope: Scope): ScopeSnapshot {
  return (scope as any)?.snapshot() ?? { version: 1, cells: {} };
}

export function hydrate(snapshot: ScopeSnapshot): Scope {
  return createScope(snapshot);
}

export function preload<T>(readable: Readable<T>, scope?: Scope): Promise<T> {
  const scopeImpl = scope == null ? null : scope as any;

  if (scopeImpl != null) {
    return scopeImpl.preload(readable);
  }

  return preloadReadable(() => readable.get());
}

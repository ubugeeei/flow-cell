/* @flow strict */

import * as React from "react";

export type Listener = () => void;
export type Unsubscribe = () => void;

export interface Readable<+T> {
  get(): T;
  subscribe(listener: Listener): Unsubscribe;
}

export interface Writable<T> extends Readable<T> {
  set(value: T): void;
  update(fn: (value: T) => T): void;
}

export type Cell<T> = Writable<T>;
export type Derived<+T> = Readable<T>;

export type NodeOptions = {
  +key?: string,
  +name?: string,
};

type NodeType = "cell" | "derived" | "asyncDerived";
type AnyReadable = Readable<any>;

export type ScopeSnapshot = {
  +version?: 1,
  +cells: { +[string]: mixed },
};

export interface Scope {
  get<T>(readable: Readable<T>): T;
  subscribe<T>(readable: Readable<T>, listener: Listener): Unsubscribe;
  set<T>(cell: Cell<T>, value: T): void;
  update<T>(cell: Cell<T>, fn: (value: T) => T): void;
  bind<T, R: Readable<T>>(readable: R): R;
  preload<T>(readable: Readable<T>): Promise<T>;
  run<T>(fn: () => T): T;
  snapshot(): ScopeSnapshot;
  dispose(): void;
}

export type ProviderProps = {
  +children?: React.Node,
  +scope: Scope,
  +setAsDefault?: boolean,
};

export type GraphNode = {
  +id: string,
  +type: NodeType,
  +label: string,
  +status: string,
  +subscribers: number,
  +dependencies: $ReadOnlyArray<string>,
};

export type GraphEdge = {
  +from: string,
  +to: string,
};

export type GraphSnapshot = {
  +nodes: $ReadOnlyArray<GraphNode>,
  +edges: $ReadOnlyArray<GraphEdge>,
};

type GraphMeta = {
  +readable: AnyReadable,
  +id: string,
  +type: NodeType,
  +label: string,
  +getStatus: (scope: ?ScopeImpl) => string,
  +getSubscriberCount: (scope: ?ScopeImpl) => number,
  +getDependencies: (scope: ?ScopeImpl) => $ReadOnlyArray<AnyReadable>,
};

type DependencyCollector = {
  +add: (readable: AnyReadable) => void,
};

type ScopedCellState<T> = {
  value: T,
  listeners: Set<Listener>,
};

type ScopedDerivedState = {
  deps: Array<AnyReadable>,
  depUnsubscribers: Array<Unsubscribe>,
  listeners: Set<Listener>,
  state: "dirty" | "value" | "error",
  value: any,
  error: any,
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
  onDependencyChange: Listener,
};

let nextNodeID = 1;
const graphMetas: Set<GraphMeta> = new Set();
const graphMetaByReadable: WeakMap<AnyReadable, GraphMeta> = new WeakMap();
const registeredNodeIDs: Set<string> = new Set();

let transactionDepth = 0;
let flushingListeners = false;
const pendingListeners: Set<Listener> = new Set();

let activeCollector: ?DependencyCollector = null;
let activeScope: ?ScopeImpl = null;
let defaultScope: ?ScopeImpl = null;

function registerReadable(
  readable: AnyReadable,
  type: NodeType,
  options: ?NodeOptions,
  getStatus: (scope: ?ScopeImpl) => string,
  getSubscriberCount: (scope: ?ScopeImpl) => number,
  getDependencies: (scope: ?ScopeImpl) => $ReadOnlyArray<AnyReadable>
): GraphMeta {
  const id = options?.key ?? `${type}:${String(nextNodeID++)}`;
  if (registeredNodeIDs.has(id)) {
    throw new Error(`Duplicate flowcell node key: ${id}`);
  }

  registeredNodeIDs.add(id);

  const meta = {
    readable,
    id,
    type,
    label: options?.name ?? id,
    getStatus,
    getSubscriberCount,
    getDependencies,
  };

  graphMetas.add(meta);
  graphMetaByReadable.set(readable, meta);
  return meta;
}

function getReadableID(readable: AnyReadable): ?string {
  const meta = graphMetaByReadable.get(readable);
  return meta?.id;
}

function asScopeImpl(scope: ?Scope): ?ScopeImpl {
  if (scope == null) {
    return null;
  }

  return (scope: any);
}

export function inspectGraph(scope?: Scope): GraphSnapshot {
  const scopeImpl = asScopeImpl(scope);
  const nodes = [];
  const edges = [];

  for (const meta of graphMetas) {
    const dependencies = [];

    for (const dep of meta.getDependencies(scopeImpl)) {
      const dependencyID = getReadableID(dep);

      if (dependencyID != null) {
        dependencies.push(dependencyID);
      }
    }

    nodes.push({
      id: meta.id,
      type: meta.type,
      label: meta.label,
      status: meta.getStatus(scopeImpl),
      subscribers: meta.getSubscriberCount(scopeImpl),
      dependencies,
    });

    for (const dependencyID of dependencies) {
      edges.push({
        from: dependencyID,
        to: meta.id,
      });
    }
  }

  return { nodes, edges };
}

function notifyListeners(listeners: Set<Listener>): void {
  for (const listener of Array.from(listeners)) {
    pendingListeners.add(listener);
  }

  if (transactionDepth === 0) {
    flushListeners();
  }
}

function flushListeners(): void {
  if (flushingListeners) {
    return;
  }

  flushingListeners = true;

  try {
    while (pendingListeners.size > 0) {
      const batch = Array.from(pendingListeners);
      pendingListeners.clear();

      for (const listener of batch) {
        listener();
      }
    }
  } finally {
    flushingListeners = false;
  }
}

export function transaction(fn: () => void): void {
  transactionDepth += 1;

  try {
    fn();
  } finally {
    transactionDepth -= 1;

    if (transactionDepth === 0) {
      flushListeners();
    }
  }
}

function trackReadable(readable: AnyReadable): void {
  if (activeCollector != null) {
    activeCollector.add(readable);
  }
}

function withDependencyTracking<T>(collector: DependencyCollector, fn: () => T): T {
  const previousCollector = activeCollector;
  activeCollector = collector;

  try {
    return fn();
  } finally {
    activeCollector = previousCollector;
  }
}

function withScope<T>(scope: ScopeImpl, fn: () => T): T {
  const previousScope = activeScope;
  activeScope = scope;

  try {
    return fn();
  } finally {
    activeScope = previousScope;
  }
}

function currentScope(): ?ScopeImpl {
  const scope = activeScope ?? defaultScope;

  if (scope != null) {
    scope._assertActive();
  }

  return scope;
}

function uniqueReadables(readables: $ReadOnlyArray<AnyReadable>): Array<AnyReadable> {
  const seen: Set<AnyReadable> = new Set();
  const result: Array<AnyReadable> = [];

  for (const readable of readables) {
    if (!seen.has(readable)) {
      seen.add(readable);
      result.push(readable);
    }
  }

  return result;
}

function sameReadables(left: $ReadOnlyArray<AnyReadable>, right: $ReadOnlyArray<AnyReadable>): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function isPromiseLike(value: mixed): boolean {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value: any).then === "function"
  );
}

function preloadReadable<T>(read: () => T): Promise<T> {
  try {
    return Promise.resolve(read());
  } catch (thrown) {
    if (isPromiseLike(thrown)) {
      return Promise.resolve(thrown).then(() => preloadReadable(read));
    }

    return Promise.reject(thrown);
  }
}

class CellImpl<T> implements Writable<T> {
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

  _getGlobal(): T {
    return this._value;
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

type NormalizedDerivation<T> = {
  +explicitDeps: Array<AnyReadable>,
  +read: () => T,
  +options: ?NodeOptions,
};

function normalizeDerivation<T>(
  depsOrFn: AnyReadable | $ReadOnlyArray<AnyReadable> | (() => T),
  maybeFn?: (...args: Array<any>) => T,
  options?: NodeOptions
): NormalizedDerivation<T> {
  if (typeof depsOrFn === "function" && maybeFn == null) {
    return {
      explicitDeps: [],
      read: (depsOrFn: any),
      options,
    };
  }

  const explicitDeps = Array.isArray(depsOrFn) ? Array.from(depsOrFn) : [(depsOrFn: any)];
  const fn = maybeFn;

  if (fn == null) {
    throw new Error("derived requires a compute function when dependencies are provided.");
  }

  return {
    explicitDeps,
    read: () => fn(...explicitDeps.map(dep => dep.get())),
    options,
  };
}

class DerivedImpl<T> implements Readable<T> {
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

    return (this._value: T);
  }

  subscribe(listener: Listener): Unsubscribe {
    const scope = currentScope();
    if (scope != null) {
      return scope._subscribeDerived(this, listener);
    }

    this._listeners.add(listener);

    return () => {
      this._listeners.delete(listener);
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
}

function createDerived<T>(
  depsOrFn: AnyReadable | $ReadOnlyArray<AnyReadable> | (() => T),
  maybeFn?: (...args: Array<any>) => T,
  options?: NodeOptions
): Derived<T> {
  return new DerivedImpl(normalizeDerivation(depsOrFn, maybeFn, options));
}

export type DerivedFactory = {
  <T>(fn: () => T, options?: NodeOptions): Derived<T>,
  <A, T>(dep: Readable<A>, fn: (A) => T, options?: NodeOptions): Derived<T>,
  <A, T>(deps: [Readable<A>], fn: (A) => T, options?: NodeOptions): Derived<T>,
  <A, B, T>(deps: [Readable<A>, Readable<B>], fn: (A, B) => T, options?: NodeOptions): Derived<T>,
  <A, B, C, T>(deps: [Readable<A>, Readable<B>, Readable<C>], fn: (A, B, C) => T, options?: NodeOptions): Derived<T>,
  <A, B, C, D, T>(deps: [Readable<A>, Readable<B>, Readable<C>, Readable<D>], fn: (A, B, C, D) => T, options?: NodeOptions): Derived<T>,
  <T>(deps: $ReadOnlyArray<Readable<mixed>>, fn: (...args: Array<any>) => T, options?: NodeOptions): Derived<T>,
};

export const derived: DerivedFactory = (createDerived: any);

class AsyncDerivedImpl<T> implements Readable<T> {
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
      return (this._value: T);
    }

    if (this._state === "rejected") {
      throw this._error;
    }

    if (this._state === "idle") {
      this._start();
    }

    if (this._state === "fulfilled") {
      return (this._value: T);
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
}

function createAsyncDerived<T>(
  depsOrFn: AnyReadable | $ReadOnlyArray<AnyReadable> | (() => Promise<T>),
  maybeFn?: (...args: Array<any>) => Promise<T>,
  options?: NodeOptions
): Derived<T> {
  return new AsyncDerivedImpl(normalizeDerivation(depsOrFn, maybeFn, options));
}

export type AsyncDerivedFactory = {
  <T>(fn: () => Promise<T>, options?: NodeOptions): Derived<T>,
  <A, T>(dep: Readable<A>, fn: (A) => Promise<T>, options?: NodeOptions): Derived<T>,
  <A, T>(deps: [Readable<A>], fn: (A) => Promise<T>, options?: NodeOptions): Derived<T>,
  <A, B, T>(deps: [Readable<A>, Readable<B>], fn: (A, B) => Promise<T>, options?: NodeOptions): Derived<T>,
  <A, B, C, T>(deps: [Readable<A>, Readable<B>, Readable<C>], fn: (A, B, C) => Promise<T>, options?: NodeOptions): Derived<T>,
  <A, B, C, D, T>(deps: [Readable<A>, Readable<B>, Readable<C>, Readable<D>], fn: (A, B, C, D) => Promise<T>, options?: NodeOptions): Derived<T>,
  <T>(deps: $ReadOnlyArray<Readable<mixed>>, fn: (...args: Array<any>) => Promise<T>, options?: NodeOptions): Derived<T>,
};

export const asyncDerived: AsyncDerivedFactory = (createAsyncDerived: any);

class ScopeImpl implements Scope {
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
    this._snapshotCells = {};

    if (snapshot != null) {
      if (snapshot.version != null && snapshot.version !== 1) {
        throw new Error(`Unsupported flowcell snapshot version: ${String(snapshot.version)}`);
      }

      for (const id of Object.keys(snapshot.cells)) {
        this._snapshotCells[id] = snapshot.cells[id];
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
      return (existing: any);
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
      bound.set = (value: T) => this.set((readable: any), value);
      bound.update = (fn: (value: T) => T) => this.update((readable: any), fn);
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

    const cells: { [string]: mixed } = {};

    for (const cellValue of this._touchedCells) {
      cells[cellValue._meta.id] = this._getCell(cellValue);
    }

    return { version: 1, cells };
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }

    this._disposed = true;

    if (defaultScope === this) {
      defaultScope = null;
    }

    for (const state of this._createdDerivedStates) {
      for (const unsubscribe of state.depUnsubscribers) {
        unsubscribe();
      }

      state.depUnsubscribers = [];
      state.deps = [];
      state.listeners.clear();
    }

    for (const state of this._createdAsyncDerivedStates) {
      state.version += 1;

      for (const unsubscribe of state.depUnsubscribers) {
        unsubscribe();
      }

      state.depUnsubscribers = [];
      state.deps = [];
      state.listeners.clear();
      state.promise = null;
    }

    for (const cellValue of this._touchedCells) {
      const state = this._cellStates.get(cellValue);

      if (state != null) {
        state.listeners.clear();
      }
    }
  }

  _assertActive(): void {
    if (this._disposed) {
      throw new Error("Cannot use a disposed flowcell scope.");
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
    const hasSnapshotValue = Object.keys(this._snapshotCells).includes(id);
    const value = hasSnapshotValue
      ? this._snapshotCells[id]
      : cellValue._getInitial();
    const state = {
      value: (value: any),
      listeners: new Set<Listener>(),
    };

    this._touchedCells.add(cellValue);
    this._cellStates.set(cellValue, state);
    return state;
  }

  _getDerived<T>(derivedValue: DerivedImpl<T>): T {
    const state = this._getDerivedState(derivedValue);

    if (state.state === "dirty") {
      this._evaluateDerived(derivedValue, state);
    }

    if (state.state === "error") {
      throw state.error;
    }

    return (state.value: T);
  }

  _subscribeDerived<T>(derivedValue: DerivedImpl<T>, listener: Listener): Unsubscribe {
    const state = this._getDerivedState(derivedValue);
    state.listeners.add(listener);

    return () => {
      state.listeners.delete(listener);
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
      onDependencyChange: () => {
        if (state.state !== "dirty") {
          state.state = "dirty";
          notifyListeners(state.listeners);
        }
      },
    };

    this._derivedStates.set(derivedValue, state);
    this._createdDerivedStates.add(state);
    return state;
  }

  _evaluateDerived<T>(derivedValue: DerivedImpl<T>, state: ScopedDerivedState): void {
    const trackedDeps: Set<AnyReadable> = new Set(derivedValue._explicitDeps);
    const collector: DependencyCollector = {
      add: (readable: AnyReadable) => {
        trackedDeps.add(readable);
      },
    };

    try {
      const value = withScope(this, () => withDependencyTracking(collector, derivedValue._read));
      state.value = value;
      state.error = undefined;
      state.state = "value";
    } catch (error) {
      state.error = error;
      state.state = "error";
    } finally {
      this._bindScopedDependencies(state, Array.from(trackedDeps), derivedValue);
    }
  }

  _getAsyncDerived<T>(derivedValue: AsyncDerivedImpl<T>): T {
    const state = this._getAsyncDerivedState(derivedValue);

    if (state.state === "fulfilled") {
      return (state.value: T);
    }

    if (state.state === "rejected") {
      throw state.error;
    }

    if (state.state === "idle") {
      this._startAsyncDerived(derivedValue, state);
    }

    if (state.state === "fulfilled") {
      return (state.value: T);
    }

    if (state.state === "rejected") {
      throw state.error;
    }

    throw state.promise;
  }

  _subscribeAsyncDerived<T>(derivedValue: AsyncDerivedImpl<T>, listener: Listener): Unsubscribe {
    const state = this._getAsyncDerivedState(derivedValue);
    state.listeners.add(listener);

    return () => {
      state.listeners.delete(listener);
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
      onDependencyChange: () => {
        state.version += 1;
        state.state = "idle";
        state.promise = null;
        notifyListeners(state.listeners);
      },
    };

    this._asyncDerivedStates.set(derivedValue, state);
    this._createdAsyncDerivedStates.add(state);
    return state;
  }

  _startAsyncDerived<T>(derivedValue: AsyncDerivedImpl<T>, state: ScopedAsyncDerivedState): void {
    const runVersion = state.version;
    const trackedDeps: Set<AnyReadable> = new Set(derivedValue._explicitDeps);
    const collector: DependencyCollector = {
      add: (readable: AnyReadable) => {
        trackedDeps.add(readable);
      },
    };

    let result;

    try {
      result = withScope(this, () => withDependencyTracking(collector, derivedValue._read));
    } catch (error) {
      state.error = error;
      state.state = "rejected";
      this._bindScopedDependencies(state, Array.from(trackedDeps), derivedValue);
      return;
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
        }

        return value;
      },
      error => {
        if (state.version === runVersion) {
          state.error = error;
          state.state = "rejected";
          state.promise = null;
          notifyListeners(state.listeners);
        }

        return undefined;
      }
    );

    state.promise = promise;
    state.state = "pending";
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

const ScopeContext: React.Context<?ScopeImpl> = React.createContext(null);

export function createScope(snapshot?: ScopeSnapshot): Scope {
  return new ScopeImpl(snapshot);
}

export function dehydrate(scope: Scope): ScopeSnapshot {
  return asScopeImpl(scope)?.snapshot() ?? { version: 1, cells: {} };
}

export function hydrate(snapshot: ScopeSnapshot): Scope {
  return createScope(snapshot);
}

export function preload<T>(readable: Readable<T>, scope?: Scope): Promise<T> {
  const scopeImpl = asScopeImpl(scope);

  if (scopeImpl != null) {
    return scopeImpl.preload(readable);
  }

  return preloadReadable(() => readable.get());
}

export function Provider(props: ProviderProps): React.Node {
  const scope = asScopeImpl(props.scope);
  const setAsDefault = props.setAsDefault ?? true;

  React.useEffect(() => {
    if (scope == null || !setAsDefault) {
      return undefined;
    }

    const previousScope = defaultScope;
    defaultScope = scope;

    return () => {
      if (defaultScope === scope) {
        defaultScope = previousScope == null || previousScope._disposed ? null : previousScope;
      }
    };
  }, [scope, setAsDefault]);

  const createElement: any = React.createElement;
  return createElement(
    ScopeContext.Provider,
    { value: scope },
    props.children
  );
}

export function use<T>(readable: Readable<T>): T {
  const scope = React.useContext(ScopeContext);
  const subscribe = React.useCallback(
    (listener: Listener) => {
      if (scope != null) {
        return scope.subscribe(readable, listener);
      }

      return readable.subscribe(listener);
    },
    [readable, scope]
  );
  const getSnapshot = React.useCallback(() => {
    if (scope != null) {
      return scope.get(readable);
    }

    return readable.get();
  }, [readable, scope]);

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export type Keyed<K, R> = {
  (key: K): R,
  +clear: (key?: K) => void,
  +keys: () => $ReadOnlyArray<string>,
};

function defaultKeyFor(value: mixed): string {
  const type = typeof value;

  if (
    value == null ||
    type === "string" ||
    type === "number" ||
    type === "boolean" ||
    type === "bigint" ||
    type === "symbol"
  ) {
    return `${type}:${String(value)}`;
  }

  const json = JSON.stringify(value);
  return `json:${json ?? String(value)}`;
}

export function keyed<K, R>(
  factory: (key: K) => R,
  options?: { +key?: (key: K) => string }
): Keyed<K, R> {
  const cache: Map<string, R> = new Map();
  const keyFor = options?.key ?? defaultKeyFor;

  const family = (key: K): R => {
    const cacheKey = keyFor(key);

    if (!cache.has(cacheKey)) {
      const created = factory(key);
      cache.set(cacheKey, created);
      return created;
    }

    return (cache.get(cacheKey): any);
  };

  family.clear = (key?: K) => {
    if (key === undefined) {
      cache.clear();
      return;
    }

    cache.delete(keyFor(key));
  };
  family.keys = () => Array.from(cache.keys());

  return (family: any);
}

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.Provider = Provider;
exports.asyncDerived = void 0;
exports.cell = cell;
exports.createScope = createScope;
exports.dehydrate = dehydrate;
exports.derived = void 0;
exports.hydrate = hydrate;
exports.inspectGraph = inspectGraph;
exports.keyed = keyed;
exports.preload = preload;
exports.transaction = transaction;
exports.use = use;
var React = _interopRequireWildcard(require("react"));
function _interopRequireWildcard(e, t) { if ("function" == typeof WeakMap) var r = new WeakMap(), n = new WeakMap(); return (_interopRequireWildcard = function (e, t) { if (!t && e && e.__esModule) return e; var o, i, f = { __proto__: null, default: e }; if (null === e || "object" != typeof e && "function" != typeof e) return f; if (o = t ? n : r) { if (o.has(e)) return o.get(e); o.set(e, f); } for (const t in e) "default" !== t && {}.hasOwnProperty.call(e, t) && ((i = (o = Object.defineProperty) && Object.getOwnPropertyDescriptor(e, t)) && (i.get || i.set) ? o(f, t, i) : f[t] = e[t]); return f; })(e, t); }
let nextNodeID = 1;
const graphMetas = new Set();
const graphMetaByReadable = new WeakMap();
const registeredNodeIDs = new Set();
let transactionDepth = 0;
let flushingListeners = false;
const pendingListeners = new Set();
let activeCollector = null;
let activeScope = null;
let defaultScope = null;
function registerReadable(readable, type, options, getStatus, getSubscriberCount, getDependencies) {
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
    getDependencies
  };
  graphMetas.add(meta);
  graphMetaByReadable.set(readable, meta);
  return meta;
}
function getReadableID(readable) {
  const meta = graphMetaByReadable.get(readable);
  return meta?.id;
}
function asScopeImpl(scope) {
  if (scope == null) {
    return null;
  }
  return scope;
}
function inspectGraph(scope) {
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
      dependencies
    });
    for (const dependencyID of dependencies) {
      edges.push({
        from: dependencyID,
        to: meta.id
      });
    }
  }
  return {
    nodes,
    edges
  };
}
function notifyListeners(listeners) {
  for (const listener of Array.from(listeners)) {
    pendingListeners.add(listener);
  }
  if (transactionDepth === 0) {
    flushListeners();
  }
}
function flushListeners() {
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
function transaction(fn) {
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
function trackReadable(readable) {
  if (activeCollector != null) {
    activeCollector.add(readable);
  }
}
function withDependencyTracking(collector, fn) {
  const previousCollector = activeCollector;
  activeCollector = collector;
  try {
    return fn();
  } finally {
    activeCollector = previousCollector;
  }
}
function withScope(scope, fn) {
  const previousScope = activeScope;
  activeScope = scope;
  try {
    return fn();
  } finally {
    activeScope = previousScope;
  }
}
function currentScope() {
  const scope = activeScope ?? defaultScope;
  if (scope != null) {
    scope._assertActive();
  }
  return scope;
}
function uniqueReadables(readables) {
  const seen = new Set();
  const result = [];
  for (const readable of readables) {
    if (!seen.has(readable)) {
      seen.add(readable);
      result.push(readable);
    }
  }
  return result;
}
function sameReadables(left, right) {
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
function isPromiseLike(value) {
  return value != null && typeof value === "object" && typeof value.then === "function";
}
function preloadReadable(read) {
  try {
    return Promise.resolve(read());
  } catch (thrown) {
    if (isPromiseLike(thrown)) {
      return Promise.resolve(thrown).then(() => preloadReadable(read));
    }
    return Promise.reject(thrown);
  }
}
class CellImpl {
  _listeners = new Set();
  constructor(initial, options) {
    this._initial = initial;
    this._value = initial;
    this._meta = registerReadable(this, "cell", options, scope => "value", scope => scope == null ? this._listeners.size : scope._getCellSubscriberCount(this), scope => []);
  }
  get() {
    trackReadable(this);
    const scope = currentScope();
    if (scope != null) {
      return scope._getCell(this);
    }
    return this._value;
  }
  subscribe(listener) {
    const scope = currentScope();
    if (scope != null) {
      return scope._subscribeCell(this, listener);
    }
    return this._subscribeGlobal(listener);
  }
  set(value) {
    const scope = currentScope();
    if (scope != null) {
      scope._setCell(this, value);
      return;
    }
    this._setGlobal(value);
  }
  update(fn) {
    this.set(fn(this.get()));
  }
  _getInitial() {
    return this._initial;
  }
  _getGlobal() {
    return this._value;
  }
  _setGlobal(value) {
    if (Object.is(this._value, value)) {
      return;
    }
    this._value = value;
    notifyListeners(this._listeners);
  }
  _subscribeGlobal(listener) {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }
}
function cell(initial, options) {
  return new CellImpl(initial, options);
}
function normalizeDerivation(depsOrFn, maybeFn, options) {
  if (typeof depsOrFn === "function" && maybeFn == null) {
    return {
      explicitDeps: [],
      read: depsOrFn,
      options
    };
  }
  const explicitDeps = Array.isArray(depsOrFn) ? Array.from(depsOrFn) : [depsOrFn];
  const fn = maybeFn;
  if (fn == null) {
    throw new Error("derived requires a compute function when dependencies are provided.");
  }
  return {
    explicitDeps,
    read: () => fn(...explicitDeps.map(dep => dep.get())),
    options
  };
}
class DerivedImpl {
  _deps = [];
  _depUnsubscribers = [];
  _listeners = new Set();
  _state = "dirty";
  constructor(derivation) {
    this._read = derivation.read;
    this._explicitDeps = derivation.explicitDeps;
    this._onDependencyChange = () => {
      if (this._state !== "dirty") {
        this._state = "dirty";
        notifyListeners(this._listeners);
      }
    };
    this._meta = registerReadable(this, "derived", derivation.options, scope => scope == null ? this._state : scope._getDerivedStatus(this), scope => scope == null ? this._listeners.size : scope._getDerivedSubscriberCount(this), scope => scope == null ? this._deps : scope._getDerivedDependencies(this));
  }
  get() {
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
    return this._value;
  }
  subscribe(listener) {
    const scope = currentScope();
    if (scope != null) {
      return scope._subscribeDerived(this, listener);
    }
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }
  _evaluate() {
    const trackedDeps = new Set(this._explicitDeps);
    const collector = {
      add: readable => {
        trackedDeps.add(readable);
      }
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
  _bindDependencies(deps) {
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
function createDerived(depsOrFn, maybeFn, options) {
  return new DerivedImpl(normalizeDerivation(depsOrFn, maybeFn, options));
}
const derived = exports.derived = createDerived;
class AsyncDerivedImpl {
  _deps = [];
  _depUnsubscribers = [];
  _listeners = new Set();
  _state = "idle";
  _version = 0;
  constructor(derivation) {
    this._read = derivation.read;
    this._explicitDeps = derivation.explicitDeps;
    this._onDependencyChange = () => {
      this._version += 1;
      this._state = "idle";
      this._promise = null;
      notifyListeners(this._listeners);
    };
    this._meta = registerReadable(this, "asyncDerived", derivation.options, scope => scope == null ? this._state : scope._getAsyncDerivedStatus(this), scope => scope == null ? this._listeners.size : scope._getAsyncDerivedSubscriberCount(this), scope => scope == null ? this._deps : scope._getAsyncDerivedDependencies(this));
  }
  get() {
    trackReadable(this);
    const scope = currentScope();
    if (scope != null) {
      return scope._getAsyncDerived(this);
    }
    if (this._state === "fulfilled") {
      return this._value;
    }
    if (this._state === "rejected") {
      throw this._error;
    }
    if (this._state === "idle") {
      this._start();
    }
    if (this._state === "fulfilled") {
      return this._value;
    }
    if (this._state === "rejected") {
      throw this._error;
    }
    throw this._promise;
  }
  subscribe(listener) {
    const scope = currentScope();
    if (scope != null) {
      return scope._subscribeAsyncDerived(this, listener);
    }
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }
  _start() {
    const runVersion = this._version;
    const trackedDeps = new Set(this._explicitDeps);
    const collector = {
      add: readable => {
        trackedDeps.add(readable);
      }
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
    const promise = Promise.resolve(result).then(value => {
      if (this._version === runVersion) {
        this._value = value;
        this._error = undefined;
        this._state = "fulfilled";
        this._promise = null;
        notifyListeners(this._listeners);
      }
      return value;
    }, error => {
      if (this._version === runVersion) {
        this._error = error;
        this._state = "rejected";
        this._promise = null;
        notifyListeners(this._listeners);
      }
      return undefined;
    });
    this._promise = promise;
    this._state = "pending";
  }
  _bindDependencies(deps) {
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
function createAsyncDerived(depsOrFn, maybeFn, options) {
  return new AsyncDerivedImpl(normalizeDerivation(depsOrFn, maybeFn, options));
}
const asyncDerived = exports.asyncDerived = createAsyncDerived;
class ScopeImpl {
  _cellStates = new WeakMap();
  _derivedStates = new WeakMap();
  _asyncDerivedStates = new WeakMap();
  _boundReadables = new WeakMap();
  _touchedCells = new Set();
  _createdDerivedStates = new Set();
  _createdAsyncDerivedStates = new Set();
  _disposed = false;
  constructor(snapshot) {
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
  get(readable) {
    this._assertActive();
    return withScope(this, () => readable.get());
  }
  subscribe(readable, listener) {
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
  set(cellValue, value) {
    this._assertActive();
    if (cellValue instanceof CellImpl) {
      this._setCell(cellValue, value);
      return;
    }
    cellValue.set(value);
  }
  update(cellValue, fn) {
    this.set(cellValue, fn(this.get(cellValue)));
  }
  bind(readable) {
    this._assertActive();
    const existing = this._boundReadables.get(readable);
    if (existing != null) {
      return existing;
    }
    const maybeWritable = readable;
    const bound = {
      get: () => this.get(readable),
      subscribe: listener => this.subscribe(readable, listener)
    };
    if (typeof maybeWritable.set === "function" && typeof maybeWritable.update === "function") {
      bound.set = value => this.set(readable, value);
      bound.update = fn => this.update(readable, fn);
    }
    const stableBound = Object.freeze(bound);
    this._boundReadables.set(readable, stableBound);
    return stableBound;
  }
  preload(readable) {
    this._assertActive();
    return preloadReadable(() => this.get(readable));
  }
  run(fn) {
    this._assertActive();
    return withScope(this, fn);
  }
  snapshot() {
    this._assertActive();
    const cells = {};
    for (const cellValue of this._touchedCells) {
      cells[cellValue._meta.id] = this._getCell(cellValue);
    }
    return {
      version: 1,
      cells
    };
  }
  dispose() {
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
  _assertActive() {
    if (this._disposed) {
      throw new Error("Cannot use a disposed flowcell scope.");
    }
  }
  _getCell(cellValue) {
    return this._getCellState(cellValue).value;
  }
  _setCell(cellValue, value) {
    const state = this._getCellState(cellValue);
    if (Object.is(state.value, value)) {
      return;
    }
    state.value = value;
    notifyListeners(state.listeners);
  }
  _subscribeCell(cellValue, listener) {
    const state = this._getCellState(cellValue);
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  }
  _getCellSubscriberCount(cellValue) {
    const state = this._cellStates.get(cellValue);
    return state == null ? 0 : state.listeners.size;
  }
  _getCellState(cellValue) {
    const existing = this._cellStates.get(cellValue);
    if (existing != null) {
      return existing;
    }
    const id = cellValue._meta.id;
    const hasSnapshotValue = Object.keys(this._snapshotCells).includes(id);
    const value = hasSnapshotValue ? this._snapshotCells[id] : cellValue._getInitial();
    const state = {
      value: value,
      listeners: new Set()
    };
    this._touchedCells.add(cellValue);
    this._cellStates.set(cellValue, state);
    return state;
  }
  _getDerived(derivedValue) {
    const state = this._getDerivedState(derivedValue);
    if (state.state === "dirty") {
      this._evaluateDerived(derivedValue, state);
    }
    if (state.state === "error") {
      throw state.error;
    }
    return state.value;
  }
  _subscribeDerived(derivedValue, listener) {
    const state = this._getDerivedState(derivedValue);
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  }
  _getDerivedStatus(derivedValue) {
    const state = this._derivedStates.get(derivedValue);
    return state == null ? "dirty" : state.state;
  }
  _getDerivedSubscriberCount(derivedValue) {
    const state = this._derivedStates.get(derivedValue);
    return state == null ? 0 : state.listeners.size;
  }
  _getDerivedDependencies(derivedValue) {
    const state = this._derivedStates.get(derivedValue);
    return state == null ? [] : state.deps;
  }
  _getDerivedState(derivedValue) {
    const existing = this._derivedStates.get(derivedValue);
    if (existing != null) {
      return existing;
    }
    const state = {
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
      }
    };
    this._derivedStates.set(derivedValue, state);
    this._createdDerivedStates.add(state);
    return state;
  }
  _evaluateDerived(derivedValue, state) {
    const trackedDeps = new Set(derivedValue._explicitDeps);
    const collector = {
      add: readable => {
        trackedDeps.add(readable);
      }
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
  _getAsyncDerived(derivedValue) {
    const state = this._getAsyncDerivedState(derivedValue);
    if (state.state === "fulfilled") {
      return state.value;
    }
    if (state.state === "rejected") {
      throw state.error;
    }
    if (state.state === "idle") {
      this._startAsyncDerived(derivedValue, state);
    }
    if (state.state === "fulfilled") {
      return state.value;
    }
    if (state.state === "rejected") {
      throw state.error;
    }
    throw state.promise;
  }
  _subscribeAsyncDerived(derivedValue, listener) {
    const state = this._getAsyncDerivedState(derivedValue);
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  }
  _getAsyncDerivedStatus(derivedValue) {
    const state = this._asyncDerivedStates.get(derivedValue);
    return state == null ? "idle" : state.state;
  }
  _getAsyncDerivedSubscriberCount(derivedValue) {
    const state = this._asyncDerivedStates.get(derivedValue);
    return state == null ? 0 : state.listeners.size;
  }
  _getAsyncDerivedDependencies(derivedValue) {
    const state = this._asyncDerivedStates.get(derivedValue);
    return state == null ? [] : state.deps;
  }
  _getAsyncDerivedState(derivedValue) {
    const existing = this._asyncDerivedStates.get(derivedValue);
    if (existing != null) {
      return existing;
    }
    const state = {
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
      }
    };
    this._asyncDerivedStates.set(derivedValue, state);
    this._createdAsyncDerivedStates.add(state);
    return state;
  }
  _startAsyncDerived(derivedValue, state) {
    const runVersion = state.version;
    const trackedDeps = new Set(derivedValue._explicitDeps);
    const collector = {
      add: readable => {
        trackedDeps.add(readable);
      }
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
    const promise = Promise.resolve(result).then(value => {
      if (state.version === runVersion) {
        state.value = value;
        state.error = undefined;
        state.state = "fulfilled";
        state.promise = null;
        notifyListeners(state.listeners);
      }
      return value;
    }, error => {
      if (state.version === runVersion) {
        state.error = error;
        state.state = "rejected";
        state.promise = null;
        notifyListeners(state.listeners);
      }
      return undefined;
    });
    state.promise = promise;
    state.state = "pending";
  }
  _bindScopedDependencies(state, deps, owner) {
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
const ScopeContext = React.createContext(null);
function createScope(snapshot) {
  return new ScopeImpl(snapshot);
}
function dehydrate(scope) {
  return asScopeImpl(scope)?.snapshot() ?? {
    version: 1,
    cells: {}
  };
}
function hydrate(snapshot) {
  return createScope(snapshot);
}
function preload(readable, scope) {
  const scopeImpl = asScopeImpl(scope);
  if (scopeImpl != null) {
    return scopeImpl.preload(readable);
  }
  return preloadReadable(() => readable.get());
}
function Provider(props) {
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
  const createElement = React.createElement;
  return createElement(ScopeContext.Provider, {
    value: scope
  }, props.children);
}
function use(readable) {
  const scope = React.useContext(ScopeContext);
  const subscribe = React.useCallback(listener => {
    if (scope != null) {
      return scope.subscribe(readable, listener);
    }
    return readable.subscribe(listener);
  }, [readable, scope]);
  const getSnapshot = React.useCallback(() => {
    if (scope != null) {
      return scope.get(readable);
    }
    return readable.get();
  }, [readable, scope]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
function defaultKeyFor(value) {
  const type = typeof value;
  if (value == null || type === "string" || type === "number" || type === "boolean" || type === "bigint" || type === "symbol") {
    return `${type}:${String(value)}`;
  }
  const json = JSON.stringify(value);
  return `json:${json ?? String(value)}`;
}
function keyed(factory, options) {
  const cache = new Map();
  const keyFor = options?.key ?? defaultKeyFor;
  const family = key => {
    const cacheKey = keyFor(key);
    if (!cache.has(cacheKey)) {
      const created = factory(key);
      cache.set(cacheKey, created);
      return created;
    }
    return cache.get(cacheKey);
  };
  family.clear = key => {
    if (key === undefined) {
      cache.clear();
      return;
    }
    cache.delete(keyFor(key));
  };
  family.keys = () => Array.from(cache.keys());
  return family;
}

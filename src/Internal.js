/* @flow strict */

import type {
  AnyReadable,
  DependencyCollector,
  GraphEdge,
  GraphMeta,
  GraphNode,
  GraphSnapshot,
  Listener,
  NodeOptions,
  NodeType,
  Unsubscribe,
} from "./Types";

let nextNodeID = 1;
const graphMetas: Set<GraphMeta> = new Set();
const graphMetaByReadable: WeakMap<AnyReadable, GraphMeta> = new WeakMap();
const registeredNodeIDs: Set<string> = new Set();

let transactionDepth = 0;
let flushingListeners = false;
const pendingListeners: Set<Listener> = new Set();

let activeCollector: ?DependencyCollector = null;
let activeScope: ?any = null;
let defaultScopeStack: Array<any> = [];

const MAX_PRELOAD_RETRIES = 1000;

type GraphEntry = {
  +node: GraphNode,
  +edges: Array<GraphEdge>,
};

type DependencyTracker = {
  +collector: DependencyCollector,
  +dependencies: () => Array<AnyReadable>,
};

type DependencyBinding = {
  +deps: Array<AnyReadable>,
  +unsubscribers: Array<Unsubscribe>,
};

function compactDefaultScopeStack(): void {
  defaultScopeStack = defaultScopeStack.filter(scope => scope != null && !scope._disposed);
}

export function registerReadable(
  readable: AnyReadable,
  type: NodeType,
  options: ?NodeOptions,
  getStatus: (scope: ?any) => string,
  getSubscriberCount: (scope: ?any) => number,
  getDependencies: (scope: ?any) => $ReadOnlyArray<AnyReadable>
): GraphMeta {
  const id = options?.key ?? `${type}:${String(nextNodeID++)}`;
  if (typeof id !== "string") {
    throw new TypeError("FlowCell node key must be a string.");
  }

  if (registeredNodeIDs.has(id)) {
    throw new Error(`Duplicate FlowCell node key: ${id}`);
  }

  const label = options?.name ?? id;
  if (typeof label !== "string") {
    throw new TypeError("FlowCell node name must be a string.");
  }

  registeredNodeIDs.add(id);

  const meta = {
    readable,
    id,
    type,
    label,
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

function dependencyIDsFor(meta: GraphMeta, scopeImpl: ?any): Array<string> {
  return meta.getDependencies(scopeImpl).reduce((ids, dep) => {
    const id = getReadableID(dep);
    return id == null ? ids : ids.concat(id);
  }, [] as Array<string>);
}

function graphEntryForMeta(meta: GraphMeta, scopeImpl: ?any): GraphEntry {
  const dependencies = dependencyIDsFor(meta, scopeImpl);
  const node = {
    id: meta.id,
    type: meta.type,
    label: meta.label,
    status: meta.getStatus(scopeImpl),
    subscribers: meta.getSubscriberCount(scopeImpl),
    dependencies,
  };
  const edges: Array<GraphEdge> = dependencies.map(dependencyID => ({
    from: dependencyID,
    to: meta.id,
  } as GraphEdge));

  return { node, edges };
}

export function inspectGraph(scope?: mixed): GraphSnapshot {
  const scopeImpl = scope == null ? null : scope as any;
  const entries = Array.from(graphMetas).map(meta => graphEntryForMeta(meta, scopeImpl));
  const nodes = entries.map(entry => entry.node);
  const edges = entries.reduce(
    (all, entry) => all.concat(entry.edges),
    [] as Array<GraphEdge>
  );

  return { nodes, edges };
}

export function notifyListeners(listeners: Set<Listener>): void {
  Array.from(listeners).forEach(listener => {
    pendingListeners.add(listener);
  });

  if (transactionDepth === 0) {
    flushListeners();
  }
}

export function cancelPendingListener(listener: Listener): void {
  pendingListeners.delete(listener);
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

      batch.forEach(listener => {
        listener();
      });
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

export function trackReadable(readable: AnyReadable): void {
  if (activeCollector != null) {
    activeCollector.add(readable);
  }
}

export function withDependencyTracking<T>(collector: DependencyCollector, fn: () => T): T {
  const previousCollector = activeCollector;
  activeCollector = collector;

  try {
    return fn();
  } finally {
    activeCollector = previousCollector;
  }
}

export function withScope<T>(scope: any, fn: () => T): T {
  const previousScope = activeScope;
  activeScope = scope;

  try {
    return fn();
  } finally {
    activeScope = previousScope;
  }
}

export function currentScope(): ?any {
  const scope = activeScope ?? getDefaultScope();

  if (scope != null) {
    scope._assertActive();
  }

  return scope;
}

export function getDefaultScope(): ?any {
  compactDefaultScopeStack();
  return defaultScopeStack.length === 0 ? null : defaultScopeStack[defaultScopeStack.length - 1];
}

export function setDefaultScope(scope: ?any): void {
  if (scope == null) {
    defaultScopeStack = [];
    return;
  }

  defaultScopeStack = defaultScopeStack.filter(existing => existing !== scope);
  defaultScopeStack.push(scope);
}

export function clearDefaultScope(scope: any): void {
  defaultScopeStack = defaultScopeStack.filter(existing => existing !== scope);
}

export function uniqueReadables(readables: $ReadOnlyArray<AnyReadable>): Array<AnyReadable> {
  return Array.from(new Set(readables));
}

export function sameReadables(left: $ReadOnlyArray<AnyReadable>, right: $ReadOnlyArray<AnyReadable>): boolean {
  return left.length === right.length && left.every((readable, index) => readable === right[index]);
}

export function createDependencyTracker(readables: $ReadOnlyArray<AnyReadable>): DependencyTracker {
  const tracked: Set<AnyReadable> = new Set(readables);

  return {
    collector: {
      add: readable => {
        tracked.add(readable);
      },
    },
    dependencies: () => Array.from(tracked),
  };
}

export function unsubscribeAll(unsubscribers: $ReadOnlyArray<Unsubscribe>): void {
  unsubscribers.forEach(unsubscribe => {
    unsubscribe();
  });
}

export function cancelListeners(listeners: Set<Listener>): void {
  Array.from(listeners).forEach(cancelPendingListener);
  listeners.clear();
}

export function replaceDependencySubscriptions(
  currentDeps: $ReadOnlyArray<AnyReadable>,
  currentUnsubscribers: $ReadOnlyArray<Unsubscribe>,
  deps: $ReadOnlyArray<AnyReadable>,
  owner: AnyReadable,
  subscribe: (readable: AnyReadable) => Unsubscribe
): ?DependencyBinding {
  const nextDeps = uniqueReadables(deps).filter(dep => dep !== owner);

  if (sameReadables(currentDeps, nextDeps)) {
    return null;
  }

  unsubscribeAll(currentUnsubscribers);

  return {
    deps: nextDeps,
    unsubscribers: nextDeps.map(dep => subscribe(dep)),
  };
}

export function isPromiseLike(value: mixed): boolean {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as any).then === "function"
  );
}

export function preloadReadable<T>(read: () => T, retryCount?: number = 0): Promise<T> {
  try {
    return Promise.resolve(read());
  } catch (thrown) {
    if (isPromiseLike(thrown)) {
      if (retryCount >= MAX_PRELOAD_RETRIES) {
        return Promise.reject(new Error("FlowCell preload exceeded the retry limit."));
      }

      return Promise.resolve(thrown).then(() => preloadReadable(read, retryCount + 1));
    }

    return Promise.reject(thrown);
  }
}

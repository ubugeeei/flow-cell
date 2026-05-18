/* @flow strict */

import type {
  AnyReadable,
  DependencyCollector,
  GraphMeta,
  GraphSnapshot,
  Listener,
  NodeOptions,
  NodeType,
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
let defaultScope: ?any = null;

export function registerReadable(
  readable: AnyReadable,
  type: NodeType,
  options: ?NodeOptions,
  getStatus: (scope: ?any) => string,
  getSubscriberCount: (scope: ?any) => number,
  getDependencies: (scope: ?any) => $ReadOnlyArray<AnyReadable>
): GraphMeta {
  const id = options?.key ?? `${type}:${String(nextNodeID++)}`;
  if (registeredNodeIDs.has(id)) {
    throw new Error(`Duplicate FlowCell node key: ${id}`);
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

export function inspectGraph(scope?: mixed): GraphSnapshot {
  const scopeImpl = scope == null ? null : scope as any;
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

export function notifyListeners(listeners: Set<Listener>): void {
  for (const listener of Array.from(listeners)) {
    pendingListeners.add(listener);
  }

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
  const scope = activeScope ?? defaultScope;

  if (scope != null) {
    scope._assertActive();
  }

  return scope;
}

export function getDefaultScope(): ?any {
  return defaultScope;
}

export function setDefaultScope(scope: ?any): void {
  defaultScope = scope;
}

export function clearDefaultScope(scope: any): void {
  if (defaultScope === scope) {
    defaultScope = null;
  }
}

export function uniqueReadables(readables: $ReadOnlyArray<AnyReadable>): Array<AnyReadable> {
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

export function sameReadables(left: $ReadOnlyArray<AnyReadable>, right: $ReadOnlyArray<AnyReadable>): boolean {
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

export function isPromiseLike(value: mixed): boolean {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as any).then === "function"
  );
}

export function preloadReadable<T>(read: () => T): Promise<T> {
  try {
    return Promise.resolve(read());
  } catch (thrown) {
    if (isPromiseLike(thrown)) {
      return Promise.resolve(thrown).then(() => preloadReadable(read));
    }

    return Promise.reject(thrown);
  }
}

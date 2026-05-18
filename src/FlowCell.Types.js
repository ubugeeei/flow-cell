/* @flow strict */

import type * as React from "react";

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

export type NodeType = "cell" | "derived" | "asyncDerived";
export type AnyReadable = Readable<any>;

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

export type GraphMeta = {
  +readable: AnyReadable,
  +id: string,
  +type: NodeType,
  +label: string,
  +getStatus: (scope: ?any) => string,
  +getSubscriberCount: (scope: ?any) => number,
  +getDependencies: (scope: ?any) => $ReadOnlyArray<AnyReadable>,
};

export type DependencyCollector = {
  +add: (readable: AnyReadable) => void,
};

export type DerivedFactory = {
  <T>(fn: () => T, options?: NodeOptions): Derived<T>,
  <A, T>(dep: Readable<A>, fn: (A) => T, options?: NodeOptions): Derived<T>,
  <A, T>(deps: [Readable<A>], fn: (A) => T, options?: NodeOptions): Derived<T>,
  <A, B, T>(deps: [Readable<A>, Readable<B>], fn: (A, B) => T, options?: NodeOptions): Derived<T>,
  <A, B, C, T>(deps: [Readable<A>, Readable<B>, Readable<C>], fn: (A, B, C) => T, options?: NodeOptions): Derived<T>,
  <A, B, C, D, T>(deps: [Readable<A>, Readable<B>, Readable<C>, Readable<D>], fn: (A, B, C, D) => T, options?: NodeOptions): Derived<T>,
  <T>(deps: $ReadOnlyArray<Readable<mixed>>, fn: (...args: Array<any>) => T, options?: NodeOptions): Derived<T>,
};

export type AsyncDerivedFactory = {
  <T>(fn: () => Promise<T>, options?: NodeOptions): Derived<T>,
  <A, T>(dep: Readable<A>, fn: (A) => Promise<T>, options?: NodeOptions): Derived<T>,
  <A, T>(deps: [Readable<A>], fn: (A) => Promise<T>, options?: NodeOptions): Derived<T>,
  <A, B, T>(deps: [Readable<A>, Readable<B>], fn: (A, B) => Promise<T>, options?: NodeOptions): Derived<T>,
  <A, B, C, T>(deps: [Readable<A>, Readable<B>, Readable<C>], fn: (A, B, C) => Promise<T>, options?: NodeOptions): Derived<T>,
  <A, B, C, D, T>(deps: [Readable<A>, Readable<B>, Readable<C>, Readable<D>], fn: (A, B, C, D) => Promise<T>, options?: NodeOptions): Derived<T>,
  <T>(deps: $ReadOnlyArray<Readable<mixed>>, fn: (...args: Array<any>) => Promise<T>, options?: NodeOptions): Derived<T>,
};

export type Keyed<K, R> = {
  (key: K): R,
  +clear: (key?: K) => void,
  +keys: () => $ReadOnlyArray<string>,
};

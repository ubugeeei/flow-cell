/* @flow strict */

import type { Keyed } from "./Types";

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

    return cache.get(cacheKey) as any;
  };

  family.clear = (key?: K) => {
    if (key === undefined) {
      cache.clear();
      return;
    }

    cache.delete(keyFor(key));
  };
  family.keys = () => Array.from(cache.keys());

  return family as any;
}

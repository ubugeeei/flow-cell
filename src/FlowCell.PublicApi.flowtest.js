/* @flow strict */

import type * as React from "react";
import {
  Provider,
  asyncDerived,
  cell,
  createScope,
  derived,
  keyed,
  preload,
  transaction,
  useCell,
} from "flow-cell";
import type { Cell, Derived, Scope } from "flow-cell";

const count: Cell<number> = cell(0, { key: "flowtest.count" });
const doubled: Derived<number> = derived(count, value => value * 2);
const label: Derived<string> = derived([count, doubled], (value, double) => `${value}:${double}`);
const resource: Derived<{ +id: string }> = asyncDerived(label, async id => ({ id }));
const scope: Scope = createScope();
const scopedCount: Cell<number> = scope.bind(count);
const family = keyed((id: string) => cell(id));

scope.set(count, 1);
scope.update(count, value => value + 1);
scope.run(() => {
  scopedCount.set(3);
});

const readNumber: number = scope.get(count);
const readString: string = family("a").get();
const loaded: Promise<{ +id: string }> = preload(resource, scope);

transaction(() => {
  count.update(value => value + readNumber);
});

hook useCountValue(): number {
  const value: number = useCell(count);
  return value;
}

component CounterValue() {
  const value = useCountValue();
  return <span>{value}</span>;
}

const node: React.Node = (
  <Provider scope={scope}>
    <CounterValue />
  </Provider>
);

void resource;
void readString;
void loaded;
void node;

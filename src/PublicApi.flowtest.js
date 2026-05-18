/* @flow strict */

import {
  Provider,
  asyncDerived,
  cell,
  createScope,
  derived,
  keyed,
  preload,
  transaction,
  use,
} from "./Flowcell";
import type { Cell, Derived, Scope } from "./Flowcell";

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

function CounterValue(): number {
  const value: number = use(count);
  return value;
}

const node: React$Node = Provider({ scope, children: null });

void resource;
void readString;
void loaded;
void node;
void CounterValue;

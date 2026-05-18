/* @flow */

import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import ReactDOMServer from "react-dom/server";
import {
  asyncDerived,
  cell,
  createScope,
  dehydrate,
  derived,
  hydrate,
  inspectGraph,
  keyed,
  Provider,
  preload,
  transaction,
  useCell,
} from "./FlowCell";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("cell stores writable state", () => {
  const count = cell(0);
  const listener = jest.fn();

  const unsubscribe = count.subscribe(listener);

  count.set(1);
  count.update(value => value + 1);
  unsubscribe();
  count.set(3);

  expect(count.get()).toBe(3);
  expect(listener).toHaveBeenCalledTimes(2);
});

test("cell uses Object.is equality for NaN stability", () => {
  const value = cell(NaN);
  const listener = jest.fn();

  value.subscribe(listener);
  value.set(NaN);

  expect(Object.is(value.get(), NaN)).toBe(true);
  expect(listener).not.toHaveBeenCalled();
});

test("transaction batches listener notifications", () => {
  const count = cell(0);
  const listener = jest.fn();
  count.subscribe(listener);

  transaction(() => {
    count.set(1);
    count.set(2);
    count.set(3);
  });

  expect(count.get()).toBe(3);
  expect(listener).toHaveBeenCalledTimes(1);
});

test("useCell subscribes React components with useSyncExternalStore", () => {
  const count = cell(0);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  function Counter() {
    const value = useCell(count);
    return React.createElement("button", null, value);
  }

  act(() => {
    root.render(React.createElement(Counter));
  });

  expect(container.textContent).toBe("0");

  act(() => {
    count.update(value => value + 1);
  });

  expect(container.textContent).toBe("1");

  act(() => {
    root.unmount();
  });
  container.remove();
});

test("useCell unwraps asyncDerived with React Suspense", async () => {
  const userID = cell("1", { key: "test.react.suspense.id" });
  const resolvers = [];
  const user = asyncDerived(userID, id => new Promise(resolve => {
    resolvers.push(() => resolve({ id, name: `User ${id}` }));
  }), { key: "test.react.suspense.user" });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  function UserPanel() {
    const data = useCell(user);
    return React.createElement("h1", null, data.name);
  }

  await act(async () => {
    root.render(
      React.createElement(
        React.Suspense,
        { fallback: React.createElement("span", null, "Loading") },
        React.createElement(UserPanel)
      )
    );
    await Promise.resolve();
  });

  expect(container.textContent).toContain("Loading");

  await act(async () => {
    resolvers[0]();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.textContent).toBe("User 1");

  await act(async () => {
    userID.set("2");
    await Promise.resolve();
  });

  expect(container.textContent).toContain("Loading");

  await act(async () => {
    resolvers[1]();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.textContent).toBe("User 2");

  act(() => {
    root.unmount();
  });
  container.remove();
});

test("derived reads explicit dependencies", () => {
  const query = cell("h");
  const posts = cell([
    { title: "hello" },
    { title: "bye" },
  ]);
  const filteredPosts = derived([query, posts], (q, allPosts) =>
    allPosts.filter(post => post.title.includes(q))
  );

  expect(filteredPosts.get()).toEqual([{ title: "hello" }]);

  query.set("b");

  expect(filteredPosts.get()).toEqual([{ title: "bye" }]);
});

test("derived tracks dependencies read during compute", () => {
  const first = cell("Ada");
  const last = cell("Lovelace");
  const fullName = derived(() => `${first.get()} ${last.get()}`);

  expect(fullName.get()).toBe("Ada Lovelace");

  last.set("Byron");

  expect(fullName.get()).toBe("Ada Byron");
});

test("derived supports getter-style reads with dynamic dependencies", () => {
  const useFirst = cell(true);
  const first = cell("Ada");
  const last = cell("Lovelace");
  const selected = derived(get => (get(useFirst) ? get(first) : get(last)));

  expect(selected.get()).toBe("Ada");

  useFirst.set(false);

  expect(selected.get()).toBe("Lovelace");

  first.set("Grace");
  last.set("Byron");

  expect(selected.get()).toBe("Byron");
});

test("derived releases global dependencies when no subscribers remain", () => {
  const source = cell(1);
  const doubled = derived(get => get(source) * 2);
  const unsubscribe = doubled.subscribe(() => {});

  expect(doubled.get()).toBe(2);
  expect(inspectGraph().nodes.find(node => node.id === doubled._meta.id).dependencies.length).toBe(1);

  unsubscribe();

  expect(inspectGraph().nodes.find(node => node.id === doubled._meta.id).dependencies.length).toBe(0);
  source.set(2);
  expect(doubled.get()).toBe(4);
});

test("scoped derived values release dependencies when no subscribers remain", () => {
  const source = cell(1, { key: "test.scoped.release.source" });
  const doubled = derived(get => get(source) * 2, { key: "test.scoped.release.doubled" });
  const scope = createScope();
  const unsubscribe = scope.subscribe(doubled, () => {});

  expect(scope.get(doubled)).toBe(2);
  expect(inspectGraph(scope).nodes.find(node => node.id === "test.scoped.release.doubled").dependencies).toEqual([
    "test.scoped.release.source",
  ]);

  unsubscribe();

  expect(inspectGraph(scope).nodes.find(node => node.id === "test.scoped.release.doubled").dependencies).toEqual([]);
  scope.set(source, 2);
  expect(scope.get(doubled)).toBe(4);
});

test("keyed memoizes values by key", () => {
  const countByID = keyed(id => cell({ id, count: 0 }));

  expect(countByID("a")).toBe(countByID("a"));
  expect(countByID("a")).not.toBe(countByID("b"));
  expect(countByID.keys()).toEqual(["string:a", "string:b"]);

  countByID.clear("a");

  expect(countByID.keys()).toEqual(["string:b"]);
});

test("asyncDerived suspends while pending and returns resolved data", async () => {
  const userID = cell("1");
  const listeners = [];
  const user = asyncDerived(userID, async id => ({ id, name: `User ${id}` }));

  user.subscribe(() => {
    listeners.push("change");
  });

  expect(() => user.get()).toThrow(Promise);
  await Promise.resolve();

  expect(user.get()).toEqual({ id: "1", name: "User 1" });
  expect(listeners).toEqual(["change"]);

  userID.set("2");

  expect(() => user.get()).toThrow(Promise);
  await Promise.resolve();

  expect(user.get()).toEqual({ id: "2", name: "User 2" });
});

test("asyncDerived supports getter-style reads", async () => {
  const userID = cell("1");
  const user = asyncDerived(async get => {
    const id = get(userID);
    return { id, name: `User ${id}` };
  });

  expect(() => user.get()).toThrow(Promise);
  await Promise.resolve();

  expect(user.get()).toEqual({ id: "1", name: "User 1" });
});

test("inspectGraph exposes serializable nodes and dependency edges", () => {
  const source = cell(1, { name: "source" });
  const doubled = derived(source, value => value * 2, { name: "doubled" });

  expect(doubled.get()).toBe(2);

  const graph = inspectGraph();
  const sourceNode = graph.nodes.find(node => node.label === "source");
  const doubledNode = graph.nodes.find(node => node.label === "doubled");

  expect(sourceNode).toBeTruthy();
  expect(doubledNode).toBeTruthy();
  expect(graph.edges).toContainEqual({
    from: sourceNode.id,
    to: doubledNode.id,
  });
});

test("dehydrate and hydrate preserve scoped cell values", () => {
  const theme = cell("light", { key: "test.theme" });

  const serverScope = createScope();
  serverScope.set(theme, "dark");
  const clientScope = hydrate(dehydrate(serverScope));

  expect(clientScope.get(theme)).toBe("dark");

  clientScope.update(theme, value => (value === "dark" ? "blue" : value));

  expect(clientScope.get(theme)).toBe("blue");
  expect(theme.get()).toBe("light");
});

test("Provider scopes reads for independent SSR requests", () => {
  const requestID = cell("default", { key: "test.requestID" });
  const message = derived(requestID, id => `hello ${id}`, { key: "test.message" });

  function App() {
    return React.createElement("p", null, useCell(message));
  }

  const firstScope = createScope();
  const secondScope = createScope();
  firstScope.set(requestID, "first");
  secondScope.set(requestID, "second");

  const firstHTML = ReactDOMServer.renderToString(
    React.createElement(Provider, { scope: firstScope }, React.createElement(App))
  );
  const secondHTML = ReactDOMServer.renderToString(
    React.createElement(Provider, { scope: secondScope }, React.createElement(App))
  );

  expect(firstHTML).toContain("hello first");
  expect(secondHTML).toContain("hello second");
  expect(requestID.get()).toBe("default");
});

test("scope.bind returns stable readable wrappers for explicit multi-root writes", () => {
  const count = cell(0, { key: "test.bound.count" });
  const firstScope = createScope();
  const secondScope = createScope();
  const firstCount = firstScope.bind(count);
  const secondCount = secondScope.bind(count);

  expect(firstCount).toBe(firstScope.bind(count));
  expect(firstCount).not.toBe(secondCount);

  firstCount.set(10);
  secondCount.update(value => value + 1);

  expect(firstCount.get()).toBe(10);
  expect(secondCount.get()).toBe(1);
  expect(count.get()).toBe(0);
});

test("scope.run executes module-level writes against that scope", () => {
  const count = cell(0, { key: "test.scope.run.count" });
  const scope = createScope();

  scope.run(() => {
    count.update(value => value + 5);
  });

  expect(scope.get(count)).toBe(5);
  expect(count.get()).toBe(0);
});

test("scope.dispose clears subscriptions and prevents later use", () => {
  const count = cell(0, { key: "test.dispose.count" });
  const doubled = derived(count, value => value * 2, { key: "test.dispose.doubled" });
  const scope = createScope();
  const listener = jest.fn();

  expect(scope.get(doubled)).toBe(0);
  scope.subscribe(doubled, listener);
  expect(inspectGraph(scope).nodes.find(node => node.label === "test.dispose.doubled").subscribers).toBe(1);

  scope.dispose();

  expect(() => scope.get(count)).toThrow("disposed");
  expect(() => scope.set(count, 1)).toThrow("disposed");
});

test("dehydrate only includes cells touched by the scope", () => {
  const touched = cell("yes", { key: "test.snapshot.touched" });
  cell("no", { key: "test.snapshot.untouched" });
  const scope = createScope();

  scope.set(touched, "changed");

  expect(dehydrate(scope)).toEqual({
    version: 1,
    cells: {
      "test.snapshot.touched": "changed",
    },
  });
});

test("asyncDerived ignores stale async results after dependencies change", async () => {
  const id = cell("a", { key: "test.async.stale.id" });
  const resolvers = [];
  const resource = asyncDerived(id, value => new Promise(resolve => {
    resolvers.push(() => resolve({ id: value }));
  }), { key: "test.async.stale.resource" });

  expect(() => resource.get()).toThrow(Promise);
  id.set("b");
  expect(() => resource.get()).toThrow(Promise);

  resolvers[0]();
  await Promise.resolve();
  expect(() => resource.get()).toThrow(Promise);

  resolvers[1]();
  await Promise.resolve();
  expect(resource.get()).toEqual({ id: "b" });
});

test("preload resolves asyncDerived before render reads", async () => {
  const id = cell("1", { key: "test.preload.id" });
  const resource = asyncDerived(id, async value => ({ id: value }), { key: "test.preload.resource" });
  const scope = createScope();
  scope.set(id, "2");

  await expect(preload(resource, scope)).resolves.toEqual({ id: "2" });
  expect(scope.get(resource)).toEqual({ id: "2" });
});

test("hydrate rejects unsupported snapshot versions", () => {
  expect(() => hydrate(({ version: 999, cells: {} }: any))).toThrow("Unsupported FlowCell snapshot version");
});

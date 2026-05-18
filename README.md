# FlowCell

> Experimental: FlowCell is an early, experimental state library. APIs and behavior may change while the graph model settles.

An experimental Flow typed state management library for React 19, built around a client state graph of cells and derived values.

The core idea is deliberately small: state is a `cell`, computed state is `derived`, React reads everything through one `useCell` hook, and `transaction` batches writes. The read style is intentionally closer to Jotai, while scopes, keyed graphs, SSR, RSC, and Suspense keep the Recoil graph model alive for modern React.

```js
import { cell, useCell } from "flow-cell";

const count = cell<number>(0);

hook useCount(): number {
  return useCell(count);
}

component Counter() {
  const value = useCount();

  return (
    <button onClick={() => count.update(n => n + 1)}>
      {value}
    </button>
  );
}
```

## Primitives

- `cell(initial)` creates writable state.
- `derived(deps, fn)` creates memoized state from other readable values.
- `useCell(readable)` subscribes React with `useSyncExternalStore`.
- `transaction(fn)` batches notifications.
- `preload(readable, scope?)` warms Suspense resources before render.
- `createScope()` creates an isolated state graph for SSR requests or app roots.

```js
import { cell, derived, useCell } from "flow-cell";

const query = cell<string>("");
const posts = cell<Array<Post>>([]);

const filteredPosts = derived(get => {
  const q = get(query);
  return get(posts).filter(post => post.title.includes(q));
});

component Search() {
  const q = useCell(query);
  const results = useCell(filteredPosts);

  return (
    <>
      <input value={q} onChange={event => query.set(event.currentTarget.value)} />
      <PostList posts={results} />
    </>
  );
}
```

`derived` also supports explicit dependency lists:

```js
const fullName = derived([firstName, lastName], (first, last) => `${first} ${last}`);
```

## Philosophy

FlowCell is a state management library first. The graph is client state by default: cells hold writable application state, derived nodes model synchronous or Suspense-backed computed state, and scopes isolate that graph per request or app root. Remote data, Relay-style resources, and server cache orchestration can layer on later without becoming the center of the API.

## Suspense

FlowCell assumes React 19, Async React, and Suspense. `asyncDerived` stores a pending thenable, FlowCell's `useCell` subscribes with `useSyncExternalStore`, and then unwraps that thenable with React 19's `use`. Pending work suspends; rejected work flows to an error boundary.

```js
import * as React from "react";
import { asyncDerived, cell, preload, useCell } from "flow-cell";

type User = {
  +id: string,
  +name: string,
};

const userID = cell<string>("1");

const user = asyncDerived(async get => {
  const id = get(userID);
  return await fetchUser(id);
});

hook useUser(): User {
  return useCell(user);
}

component UserPanel() {
  const data = useUser();
  return <h1>{data.name}</h1>;
}

component App() {
  return (
    <React.Suspense fallback={<span>Loading...</span>}>
      <UserPanel />
    </React.Suspense>
  );
}

await preload(user);
```

React's own `use` cannot subscribe to arbitrary external stores directly; it accepts thenables and contexts. FlowCell's `useCell` is the state graph hook that performs the external-store subscription, then delegates pending async values to React's `use`.

## RSC

Use `flow-cell/server` in React Server Components and server-only code. It exports the graph primitives without importing React hooks or `react-dom`.

```js
import { cell, createScope, dehydrate } from "flow-cell/server";

const requestID = cell<string>("", { key: "requestID" });

export async function loadFlowCellSnapshot(id: string) {
  const scope = createScope();
  scope.set(requestID, id);
  return dehydrate(scope);
}
```

Use `flow-cell/client` from Client Components. That entry carries `"use client"` and only exports `Provider` and `useCell`.

```js
import { Provider, useCell } from "flow-cell/client";
```

## SSR scopes

Use a fresh `Scope` per request so module-level cells do not leak state between users. `Provider` makes `useCell(cell)` and `useCell(derivedValue)` read from that scope.

```js
import { Provider, createScope, dehydrate, hydrate, useCell } from "flow-cell";

const userID = cell<string>("anonymous", { key: "userID" });

component App() {
  const id = useCell(userID);
  return <h1>{id}</h1>;
}

// Server request
const scope = createScope();
scope.set(userID, request.user.id);

const html = renderToString(
  <Provider scope={scope}>
    <App />
  </Provider>
);
const snapshot = dehydrate(scope);

// Client boot
hydrateRoot(
  document.getElementById("root"),
  <Provider scope={hydrate(window.__FLOWCELL__)}>
    <App />
  </Provider>
);
```

Pass stable `key` values to cells that should survive dehydration across server and client bundles. On the client, `Provider` installs its scope as the default target for `cell.set()` / `cell.update()` calls made from event handlers; pass `setAsDefault={false}` for manually managed multi-root apps.

For multi-root apps, bind writes explicitly:

```js
const scope = createScope();
const scopedCount = scope.bind(count);

scopedCount.update(n => n + 1);
scope.run(() => count.set(10));
scope.dispose();
```

`dispose()` clears scoped subscriptions and prevents accidental reuse after a request or root is finished.

## Package Shape

Source lives in `src/` with PascalCase files such as `Cell.js`, `Scope.js`, and `React.js`. `yarn build` generates publishable artifacts in `dist/`:

- `dist/FlowCell.js` for CommonJS
- `dist/FlowCell.mjs` for ESM
- `dist/FlowCell.js.flow` for Flow consumers
- `dist/Client.js` / `dist/Server.js` for explicit RSC boundaries

Use the committed Yarn 4 release for development:

```sh
yarn install
yarn verify
```

Development and CI run on active Node.js LTS or newer.

## Production Notes

- Scopes isolate state per request or root; dispose them when the request/root is finished.
- Async resources follow React's Suspense contract: pending promises are thrown, rejected values are thrown, and `preload()` can warm them before render.
- Snapshots are versioned and keyed; use stable `key` values for any cell that crosses SSR hydration.
- Server and client entries are split so RSC code can use the graph without pulling React client hooks.
- Published files are flat and side-effect free: CJS, ESM, Flow declarations, README, and LICENSE only.
- Derived nodes release unobserved dependency subscriptions after React and Suspense have a chance to retry, which keeps SSR reads and preloads from retaining graph edges.
- Listener queues remove unsubscribed listeners before a transaction flush, so unmounted roots and disposed scopes do not receive stale notifications.
- Cyclic derived graphs fail with a FlowCell error instead of overflowing the stack.

## Keyed values

Use `keyed` for family-style factories:

```js
const todoByID = keyed(id => cell(null));

todoByID("1") === todoByID("1"); // true
```

## Graph inspection

`inspectGraph()` returns serializable nodes and edges for devtools or debugging.

```js
inspectGraph(scope);
```

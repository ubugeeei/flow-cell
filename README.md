# flowcell

> Experimental: flowcell is an early, experimental state library. APIs and behavior may change while the graph model settles.

A small Flow typed state graph for React.

```js
import { cell, use } from "flowcell";

const count = cell(0);

function Counter() {
  const value = use(count);

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
- `use(readable)` subscribes React with `useSyncExternalStore`.
- `transaction(fn)` batches notifications.
- `preload(readable, scope?)` warms Suspense resources before render.
- `createScope()` creates an isolated state graph for SSR requests or app roots.

```js
const query = cell("");
const posts = cell([]);

const filteredPosts = derived([query, posts], (q, allPosts) =>
  allPosts.filter(post => post.title.includes(q))
);
```

`derived` also supports read tracking:

```js
const fullName = derived(() => `${firstName.get()} ${lastName.get()}`);
```

## Suspense

`asyncDerived` throws its pending promise from `get()`, so `use(resource)` works with Suspense and rejected promises flow to an error boundary.

```js
import { asyncDerived, cell, preload } from "flowcell";

const userID = cell("1");

const user = asyncDerived(userID, async id => {
  return await fetchUser(id);
});

await preload(user);
```

## SSR scopes

Use a fresh `Scope` per request so module-level cells do not leak state between users. `Provider` makes `use(cell)` and `use(derivedValue)` read from that scope.

```js
import { Provider, createScope, dehydrate, hydrate } from "flowcell";

const userID = cell("anonymous", { key: "userID" });

function App() {
  const id = use(userID);
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

Source lives in `src/Flowcell.js` with Flow declarations in `src/Flowcell.js.flow`. Published artifacts are flat at the package root:

- `Flowcell.js` for CommonJS
- `Flowcell.mjs` for ESM
- `Flowcell.js.flow` for Flow consumers

Use Yarn for development:

```sh
yarn install
yarn verify
```

## Production Notes

- Scopes isolate state per request or root; dispose them when the request/root is finished.
- Async resources follow React's Suspense contract: pending promises are thrown, rejected values are thrown, and `preload()` can warm them before render.
- Snapshots are versioned and keyed; use stable `key` values for any cell that crosses SSR hydration.
- Published files are flat and side-effect free: CJS, ESM, Flow declarations, README, and LICENSE only.

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

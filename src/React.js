/* @flow strict */

"use client";

import * as React from "react";
import {
  getDefaultScope,
  isPromiseLike,
  setDefaultScope,
} from "./Internal";
import type {
  Listener,
  ProviderProps,
  Readable,
} from "./Types";

const ScopeContext: React.Context<?any> = React.createContext(null);
const suspenseSnapshots: WeakMap<any, SuspenseSnapshot> = new WeakMap();

type SuspenseSnapshot = {
  +kind: "suspense",
  +thenable: any,
};

function getSuspenseSnapshot(thenable: any): SuspenseSnapshot {
  const existing = suspenseSnapshots.get(thenable);

  if (existing != null) {
    return existing;
  }

  const snapshot: SuspenseSnapshot = {
    kind: "suspense",
    thenable,
  };
  suspenseSnapshots.set(thenable, snapshot);
  return snapshot;
}

function readSnapshot<T>(read: () => T): T | SuspenseSnapshot {
  try {
    return read();
  } catch (thrown) {
    if (isPromiseLike(thrown)) {
      return getSuspenseSnapshot(thrown);
    }

    throw thrown;
  }
}

function isSuspenseSnapshot(snapshot: mixed): boolean {
  return (
    snapshot != null &&
    typeof snapshot === "object" &&
    (snapshot as any).kind === "suspense"
  );
}

export function Provider(props: ProviderProps): React.Node {
  const scope = props.scope as any;
  const setAsDefault = props.setAsDefault ?? true;

  React.useEffect(() => {
    if (scope == null || !setAsDefault) {
      return undefined;
    }

    const previousScope = getDefaultScope();
    setDefaultScope(scope);

    return () => {
      if (getDefaultScope() === scope) {
        setDefaultScope(previousScope == null || previousScope._disposed ? null : previousScope);
      }
    };
  }, [scope, setAsDefault]);

  const createElement: any = React.createElement;
  return createElement(
    ScopeContext.Provider,
    { value: scope },
    props.children
  );
}

export function useCell<T>(readable: Readable<T>): T {
  const scope = React.useContext(ScopeContext);
  const subscribe = React.useCallback(
    (listener: Listener) => {
      if (scope != null) {
        return scope.subscribe(readable, listener);
      }

      return readable.subscribe(listener);
    },
    [readable, scope]
  );
  const getSnapshot = React.useCallback(() => {
    return readSnapshot(() => {
      if (scope != null) {
        return scope.get(readable);
      }

      return readable.get();
    });
  }, [readable, scope]);

  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (isSuspenseSnapshot(snapshot)) {
    return React.use((snapshot as any).thenable) as any;
  }

  return snapshot as any;
}

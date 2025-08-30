import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import {
  getStoreFor,
  snapshot,
  withComponentTracking,
  type StoreListener,
  type Snapshot as CoreSnapshot,
} from "./ripplio";

// Overloads for good typings:
export function useSnapshot<T extends object>(state: T): CoreSnapshot<T>;
export function useSnapshot<T extends object, S>(state: T, selector: (state: T) => S): S;
export function useSnapshot<T extends object, S = CoreSnapshot<T>>(
  state: T,
  selector?: (state: T) => S
): S {
  const store = getStoreFor(state);

  // Stable component id
  const idRef = useRef<symbol | null>(null);
  if (!idRef.current) idRef.current = Symbol("component");
  const cid = idRef.current;

  // Cache for the selected snapshot
  type CacheBox = { value: S | undefined; ready: boolean };
  const cacheRef = useRef<CacheBox>({ value: undefined, ready: false });

  // Stable ref to the compute function (so effects don't need it as a dep)
  const computeSelectedRef = useRef<() => S>(() => undefined as unknown as S);
  computeSelectedRef.current = () =>
    withComponentTracking(cid, () => {
      const selected = selector ? selector(state) : (state as unknown as S);
      return snapshot(selected) as S;
    });

  const subscribe = (onStoreChange: StoreListener) =>
    store.subscribeComponent(cid, () => {
      // precompute so getSnapshot returns fresh value immediately
      cacheRef.current.value = computeSelectedRef.current();
      cacheRef.current.ready = true;
      onStoreChange();
    });

 const getSnapshot = () => {
  if (!cacheRef.current.ready) {
    cacheRef.current.value = computeSelectedRef.current(); // runs under withComponentTracking
    cacheRef.current.ready = true;
  }
  return cacheRef.current.value as S;
};

const getServerSnapshot = getSnapshot

// prime before paint (no deps to silence ESLint)
useLayoutEffect(() => {
  if (!cacheRef.current.ready) {
    cacheRef.current.value = computeSelectedRef.current();
    cacheRef.current.ready = true;
  }
   
}, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

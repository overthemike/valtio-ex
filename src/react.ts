import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import {
  getStoreFor,
  snapshot,
  withComponentTracking,
  type StoreListener,
  type Snapshot as CoreSnapshot,
} from "./ripplio"; // your core file

// Overloads for good typings:
export function useSnapshot<T extends object>(state: T): CoreSnapshot<T>;
export function useSnapshot<T extends object, S>(state: T, selector: (state: T) => S): S;
export function useSnapshot<T extends object, S = CoreSnapshot<T>>(
  state: T,
  selector?: (state: T) => S
): S {
  const store = getStoreFor(state);

  // one id per component instance
  const idRef = useRef<symbol>(null);
  if (!idRef.current) idRef.current = Symbol("component");

  type CacheBox = { value: S | undefined; ready: boolean };
  const cacheRef = useRef<CacheBox>({ value: undefined, ready: false });

  // IMPORTANT: track WHILE snapshotting
  const computeSelected = (): S =>
    withComponentTracking(idRef.current!, () => {
      const selected = selector ? selector(state) : (state as unknown as S);
      return snapshot(selected) as S;
    });

  const subscribe = (onStoreChange: StoreListener) =>
    store.subscribeComponent(idRef.current!, () => {
      cacheRef.current.value = computeSelected();
      cacheRef.current.ready = true;
      onStoreChange();
    });

  const getSnapshot = () => {
    if (!cacheRef.current.ready) {
      cacheRef.current.value = computeSelected();
      cacheRef.current.ready = true;
    }
    return cacheRef.current.value as S;
  };

  const getServerSnapshot = getSnapshot;

  // ensure we have an initial cached value before paint
  useLayoutEffect(() => {
    if (!cacheRef.current.ready) {
      cacheRef.current.value = computeSelected();
      cacheRef.current.ready = true;
    }
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

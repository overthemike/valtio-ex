export type Primitive = string | number | boolean | bigint | symbol | null | undefined;
export type Path = ReadonlyArray<string>;
export type DepKey = string; // "a.b.c" or "__computed__:a.b"
export type CompId = string | symbol; // string for computed key; symbol for UI subscriber
export type StoreListener = () => void;

type Dict = Record<string, unknown>;

type LivePrimitive<T extends Primitive> = (() => T) & {
  readonly __is_live_primitive: true;
  readonly __path: Path | readonly [typeof __COMPUTED_VALUE_KEY, DepKey];
};

const REF_COMPUTED_PREFIX = "__computed__:";
const __COMPUTED_VALUE_KEY: unique symbol = Symbol("computed_value_key");
// A unique symbol flag
const REF_MARK = Symbol("valtio_ref");

// Wrapper type
export type Ref<T> = { readonly [REF_MARK]: true; readonly value: T };

// Create a ref wrapper
export function ref<T>(value: T): Ref<T> {
  return { [REF_MARK]: true, value };
}

// Check if a value is a ref
function isRef(value: unknown): value is Ref<unknown> {
  return typeof value === "object" && value !== null && (REF_MARK in value);
}

// --------- tiny runtime state (module singletons) ---------
type ComputedEntry = { run: () => unknown; last: unknown; lastRun: number };



// NEW: map *any* proxy object back to its Store


const computedRegistry = new Map<DepKey, ComputedEntry>();     // depKey -> entry
const dependencyGraph = new Map<CompId, Set<DepKey>>();        // tracker -> deps
const proxyCache = new WeakMap<object, unknown>();             // target -> proxy
const storeOfRoot = new WeakMap<object, Store>();              // original root -> store
const storeOfProxy = new WeakMap<object, Store>();

let currentTracker:
  | { kind: "component"; id: symbol }
  | { kind: "computed"; id: DepKey }
  | null = null;

// --------- utils & type guards ---------
const isPrimitive = (v: unknown): v is Primitive =>
  v === null ||
  v === undefined ||
  typeof v === "string" ||
  typeof v === "number" ||
  typeof v === "boolean" ||
  typeof v === "bigint" ||
  typeof v === "symbol";

const keyOf = (path: Path): DepKey => path.join(".");
// const matches = (dep: DepKey, changed: DepKey): boolean =>
//   dep === changed || dep.startsWith(changed + ".") || changed.startsWith(dep + ".");

const getValueAtPath = (obj: unknown, path: Path): unknown =>
  path.reduce<unknown>((cur, k) => {
    if (cur === null || typeof cur !== "object") return undefined;
    return (cur as Dict)[k];
  }, obj);

const ensureDepSet = (id: CompId): Set<DepKey> => {
  const cur = dependencyGraph.get(id);
  if (cur) return cur;
  const s = new Set<DepKey>();
  dependencyGraph.set(id, s);
  return s;
};

const hasOwnDescriptor = (obj: object, prop: string): PropertyDescriptor | undefined =>
  Object.getOwnPropertyDescriptor(obj, prop);

const getDescriptorDeep = (obj: object, prop: string): PropertyDescriptor | undefined => {
  // Walk prototype chain
  let cur: object | null = obj;
   
  while (true) {
    if (cur === null) return undefined;
    const d = hasOwnDescriptor(cur, prop);
    if (d) return d;
    cur = Object.getPrototypeOf(cur);
  }
};

const isFunction = (v: unknown) => typeof v === "function";

export type Store = {
  readonly root: object;
  readonly subscribeComponent: (id: symbol, cb: () => void) => () => void;
  readonly notifyPathChange: (path: ReadonlyArray<string>) => void;
};

// Recompute computeds affected by a set of changed keys (raw paths or computed keys).
// Returns the full closure of changed computed dep-keys whose values actually changed.
function recomputeAffectedComputeds(startKeys: Set<DepKey>): Set<DepKey> {
  // Worklist of keys whose change may affect computeds
  const queue: DepKey[] = [...startKeys];
  const seen = new Set<DepKey>(startKeys);
  const changedComputed = new Set<DepKey>();

  while (queue.length) {
    const changed = queue.shift()!;

    // Scan all trackers that are computeds (string keys in dependencyGraph)
    for (const [tracker, deps] of dependencyGraph) {
      if (typeof tracker !== "string") continue; // skip components

      // If this computed depends on the changed key (raw or computed), recompute it
      let depends = false;
      for (const d of deps) {
        if (d === changed || d.startsWith(changed + ".") || changed.startsWith(d + ".")) {
          depends = true;
          break;
        }
      }
      if (!depends) continue;

      const entry = computedRegistry.get(tracker);
      if (!entry) continue;
      const prev = entry.last;

      runComputed(tracker); // re-evaluates and refreshes its dep set

      // If its value actually changed, mark the computed dep-key as changed
      if (!Object.is(prev, entry.last)) {
        if (!seen.has(tracker)) {
          seen.add(tracker);
          changedComputed.add(tracker);
          queue.push(tracker); // this change can cascade into computeds depending on this one
        }
      }
    }
  }

  return changedComputed;
}

const createStore = (root: object): Store => {
  const componentSubscribers = new Map<symbol, StoreListener>();

  const subscribeComponent = (id: symbol, cb: StoreListener) => {
    componentSubscribers.set(id, cb);
    return () => {
      componentSubscribers.delete(id);
    };
  };

  const notifyPathChange = (path: Path) => {
  const changedRaw = keyOf(path);

  // 1) Start with the raw changed key, and recompute all affected computeds transitively.
  const changedKeys = new Set<DepKey>([changedRaw]);
  const changedComputeds = recomputeAffectedComputeds(changedKeys);

  // 2) Notify components that depend on either:
  //    - the raw changed path (ancestor/descendant match), OR
  //    - any computed dep-key whose value changed
  for (const [id, deps] of dependencyGraph) {
    if (typeof id !== "symbol") continue; // components only
      let shouldPing = false;

      // Match raw path against component's deps
      for (const d of deps) {
        if (d === changedRaw || d.startsWith(changedRaw + ".") || changedRaw.startsWith(d + ".")) {
          shouldPing = true;
          break;
        }
      }

      // Or match changed computed keys against component's deps
      if (!shouldPing && changedComputeds.size) {
        for (const d of deps) {
          if (changedComputeds.has(d)) {
            shouldPing = true;
            break;
          }
        }
      }

      if (shouldPing) {
        const cb = componentSubscribers.get(id);
        if (cb) cb();
      }
    }
  };

  const store: Store = { root, subscribeComponent, notifyPathChange };
  storeOfRoot.set(root, store);
  return store;
};

// --------- live primitive ---------
const isComputedPath = (p: Path | readonly [typeof __COMPUTED_VALUE_KEY, DepKey]):
  p is readonly [typeof __COMPUTED_VALUE_KEY, DepKey] =>
  Array.isArray(p) && p.length === 2 && p[0] === __COMPUTED_VALUE_KEY;

const createLivePrimitive = <T extends Primitive>(
  rootRef: object,
  path: Path | readonly [typeof __COMPUTED_VALUE_KEY, DepKey],
): LivePrimitive<T> => {
  const read = (): T => {
    if (isComputedPath(path)) {
      const entry = computedRegistry.get(path[1]);
      return entry?.last as T;
    }
    return getValueAtPath(rootRef, path) as T;
  };

  const access = (): T => {
    const val = read();
    if (currentTracker) {
      const id = currentTracker.id;
      const deps = ensureDepSet(id);
      if (isComputedPath(path)) {
        deps.add(path[1]); // depend on computed dep-key
      } else {
        deps.add(keyOf(path));
      }
    }
    return val;
  };

  const fn = (() => access()) as LivePrimitive<T>;
  Object.defineProperties(fn, {
    __is_live_primitive: { value: true, enumerable: false },
    __path: { value: path, enumerable: false },
    valueOf: { value: () => access(), enumerable: false },
    toString: { value: () => String(access()), enumerable: false },
    [Symbol.toPrimitive]: { value: () => access(), enumerable: false },
  });

  return fn;
};

const isLivePrimitiveGuard = <T extends Primitive>(v: unknown): v is LivePrimitive<T> =>
  isFunction(v) && (v as { __is_live_primitive?: unknown }).__is_live_primitive === true;

// --------- computed plumbing ---------
const computedKeyForPath = (absPath: DepKey): DepKey => `${REF_COMPUTED_PREFIX}${absPath}`;

const runComputed = (depKey: DepKey): unknown => {
  const entry = computedRegistry.get(depKey);
  if (!entry) return undefined;
  dependencyGraph.set(depKey, new Set<DepKey>()); // reset deps
  currentTracker = { kind: "computed", id: depKey };
  try {
    const val = entry.run();
    entry.last = val;
    entry.lastRun = Date.now();
    return val;
  } finally {
    currentTracker = null;
  }
};

const ensureComputed = (absPath: DepKey, runner: () => unknown): DepKey => {
  const depKey = computedKeyForPath(absPath);
  if (!computedRegistry.has(depKey)) {
    computedRegistry.set(depKey, { run: runner, last: undefined, lastRun: 0 });
    runComputed(depKey);
  }
  return depKey;
};

// --------- proxy creation ---------
const makeProxy = <T extends object>(
  target: T,
  store: Store,
  base: Path,
  rootRef: object,
): T => {
  const cached = proxyCache.get(target);
  if (cached) return cached as T;

  const p = new Proxy(target as object, {
    get(obj: object, prop: string | symbol, receiver: unknown) {
      // expose raw & a simple proxy flag
      if (prop === "__raw") return target;
      if (prop === "__isProxy") return true;

      // pass through symbol props (e.g., Symbol.iterator, Symbol.toStringTag)
      if (typeof prop === "symbol") {
        return Reflect.get(obj, prop, receiver);
      }

      // derive absolute path for this property
      const key = String(prop);
      const currentPath: Path = [...base, key];

      // look up a property descriptor across the prototype chain
      const desc = getDescriptorDeep(obj, key);

      // ===== A) computed getter =====
      if (desc && "get" in desc && typeof desc.get === "function") {
        // create/get a computed entry bound to this absolute path
        const depKey = ensureComputed(keyOf(currentPath), () => desc.get!.call(receiver));

        if (currentTracker) {
          // when tracking, record dep on the computed dep-key and return the raw computed value
          ensureDepSet(currentTracker.id).add(depKey);
          const entry = computedRegistry.get(depKey);
          return entry ? entry.last : undefined;
        }

        // when not tracking, return a live primitive wrapper that resolves to the computed value
        return createLivePrimitive<Primitive>(
          { [__COMPUTED_VALUE_KEY]: computedValueRoot },
          [__COMPUTED_VALUE_KEY, depKey]
        );
      }

      // ===== B) plain data property =====
      const value = Reflect.get(obj, prop, receiver);

      // --- B1) ref-wrapped values: unwrap; still record dep if tracking ---
      if (isRef(value)) {
        if (currentTracker) {
          ensureDepSet(currentTracker.id).add(keyOf(currentPath));
        }
        return (value as Ref<unknown>).value;
      }

      // --- B2) primitives: auto-deref while tracking; live primitive outside ---
      if (isPrimitive(value)) {
        if (currentTracker) {
          ensureDepSet(currentTracker.id).add(keyOf(currentPath));
          return value;
        }
        return createLivePrimitive<Primitive>(rootRef, currentPath);
      }

      // --- B4) nested objects/arrays: recurse with extended path ---
      if (value !== null && typeof value === "object") {
        return makeProxy(value as object, store, currentPath, rootRef);
      }

      // functions or other exotic values: return as-is
      return value;
    },

    set(obj, prop, newVal, receiver) {
      const ok = Reflect.set(obj, prop, newVal, receiver);
      store.notifyPathChange([...base, String(prop)]);
      return ok;
    },

    deleteProperty(obj, prop) {
      const ok = Reflect.deleteProperty(obj, prop);
      store.notifyPathChange([...base, String(prop)]);
      return ok;
    },
  }) as T;

  proxyCache.set(target, p);
  storeOfProxy.set(p as unknown as object, store);
  return p;
};

// indirection root for computed live-primitive reads
const computedValueRoot = new Proxy<Record<string, unknown>>(
  {},
  {
    get(_t, depKey: string) {
      return computedRegistry.get(depKey)?.last;
    },
  },
);

// --------- public core API ---------

export function proxy<T extends object>(initial: T): T {
  const store = createStore(initial as unknown as object);
  return makeProxy(initial, store, [], initial as unknown as object);
}

export type Snapshot<T> =
  T extends LivePrimitive<infer P> ? P :
  T extends Primitive ? T :
  T extends Array<infer U> ? Array<Snapshot<U>> :
  T extends object ? { [K in keyof T]: Snapshot<T[K]> } :
  never;

export function snapshot<T>(value: T): Snapshot<T> {
  if (isLivePrimitiveGuard<Primitive>(value)) {
    return value() as Snapshot<T>;
  }
  if (Array.isArray(value)) {
    return value.map((v) => snapshot(v)) as Snapshot<T>;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>)) {
       
      out[k] = snapshot((value as Record<string, unknown>)[k]);
    }
    return out as Snapshot<T>;
  }
  return value as Snapshot<T>;
}

// Adapter surface (frameworks can build on this, e.g., React)
export function getStoreFor(state: object): Store {
  const maybeRaw = (state as { __raw?: object }).__raw ?? state;
  const byRoot = storeOfRoot.get(maybeRaw);
  if (byRoot) return byRoot;

  const byProxy = storeOfProxy.get(state);
  if (byProxy) return byProxy;

  throw new Error("useSnapshot() expects a value created by proxy() (root or nested).");
}

export function withComponentTracking<S>(id: symbol, fn: () => S): S {
  dependencyGraph.set(id, new Set<DepKey>());
  currentTracker = { kind: "component", id };
  try {
    return fn();
  } finally {
    currentTracker = null;
  }
}

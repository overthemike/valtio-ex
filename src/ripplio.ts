// ripplio.ts

export type Primitive = string | number | boolean | bigint | symbol | null | undefined;
export type Path = ReadonlyArray<string>;
export type DepKey = string; // "a.b.c"  or  "__computed__:a.b"
export type CompId = string | symbol; // string for computed key; symbol for UI subscriber
export type StoreListener = () => void;

type Dict = Record<string, unknown>;

type LivePrimitive<T extends Primitive> = (() => T) & {
  readonly __is_live_primitive: true;
  readonly __path: Path | readonly [typeof __COMPUTED_VALUE_KEY, DepKey];
};

const REF_COMPUTED_PREFIX = "__computed__:";
const __COMPUTED_VALUE_KEY: unique symbol = Symbol("computed_value_key");
const REF_MARK = Symbol("valtio_ref");

export type Ref<T> = { readonly [REF_MARK]: true; readonly value: T };
export function ref<T>(value: T): Ref<T> {
  return { [REF_MARK]: true, value };
}
function isRef(value: unknown): value is Ref<unknown> {
  return typeof value === "object" && value !== null && (REF_MARK in value);
}

/* ------------------------------------------------------------------ */
/* Runtime state                                                       */
/* ------------------------------------------------------------------ */

type ComputedEntry = {
  run: () => unknown;
  last: unknown;
  lastRun: number;
  dirty: boolean; // lazy invalidation
};

const computedRegistry = new Map<DepKey, ComputedEntry>(); // depKey -> entry
const dependencyGraph = new Map<CompId, Set<DepKey>>();    // tracker -> deps (components: raw+computed; computeds: RAW only)
const proxyCache = new WeakMap<object, unknown>();         // target -> proxy
const storeOfRoot = new WeakMap<object, Store>();          // initial object -> store
const storeOfProxy = new WeakMap<object, Store>();         // any proxy -> store
const proxyMeta = new WeakMap<object, { store: Store; base: Path }>();


// reverse index for fast invalidation: RAW prefix -> set of computed keys
const reverseRawToComp = new Map<DepKey, Set<DepKey>>();

// per computed key: the set of RAW deps (full leaves) it currently depends on
const computedRawDeps = new Map<DepKey, Set<DepKey>>();

// NEW: computed-of-computed graph
// parent uses child: parentCompKey depends on childCompKey
const computedChildDeps = new Map<DepKey, Set<DepKey>>(); // parent -> children
const reverseCompToComp = new Map<DepKey, Set<DepKey>>(); // child  -> parents

type Tracker =
  | { kind: "component"; id: symbol; deps: Set<DepKey> }
  | { kind: "computed"; id: DepKey; deps: Set<DepKey> }
  | null;

let currentTracker: Tracker = null;

/* ------------------------------------------------------------------ */
/* Utils                                                               */
/* ------------------------------------------------------------------ */

const isPrimitive = (v: unknown): v is Primitive =>
  v === null ||
  v === undefined ||
  typeof v === "string" ||
  typeof v === "number" ||
  typeof v === "boolean" ||
  typeof v === "bigint" ||
  typeof v === "symbol";

const isObject = (v: unknown): v is object => typeof v === "object" && v !== null;

const keyOf = (path: Path): DepKey => path.join(".");

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

const getDescriptorDeep = (obj: object, prop: string): PropertyDescriptor | undefined => {
  let cur: object | null = obj;
  while (cur) {
    const d = Object.getOwnPropertyDescriptor(cur, prop);
    if (d) return d;
    cur = Object.getPrototypeOf(cur);
  }
  return undefined;
};

const prefixesOf = (k: DepKey): DepKey[] => {
  if (!k) return [k];
  const segs = k.split(".");
  const out: DepKey[] = [];
  for (let i = 0; i < segs.length; i++) {
    out.push(segs.slice(0, i + 1).join("."));
  }
  return out;
};

const linkRawToComp = (raw: DepKey, compKey: DepKey) => {
  let set = reverseRawToComp.get(raw);
  if (!set) {
    set = new Set<DepKey>();
    reverseRawToComp.set(raw, set);
  }
  set.add(compKey);
};

const unlinkRawFromComp = (raw: DepKey, compKey: DepKey) => {
  const set = reverseRawToComp.get(raw);
  if (!set) return;
  set.delete(compKey);
  if (!set.size) reverseRawToComp.delete(raw);
};

const linkCompToComp = (child: DepKey, parent: DepKey) => {
  let parents = reverseCompToComp.get(child);
  if (!parents) {
    parents = new Set<DepKey>();
    reverseCompToComp.set(child, parents);
  }
  parents.add(parent);
};

const unlinkCompToComp = (child: DepKey, parent: DepKey) => {
  const parents = reverseCompToComp.get(child);
  if (!parents) return;
  parents.delete(parent);
  if (!parents.size) reverseCompToComp.delete(child);
};

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export type Store = {
  readonly root: object;
  readonly subscribeComponent: (id: symbol, cb: StoreListener) => () => void;
  readonly notifyPathChange: (path: ReadonlyArray<string>) => void;
};

const createStore = (root: object): Store => {
  const componentSubscribers = new Map<symbol, StoreListener>();

  const subscribeComponent = (id: symbol, cb: StoreListener) => {
    componentSubscribers.set(id, cb);
    return () => {
      componentSubscribers.delete(id);
    };
  };

  // WRITE path: mark computeds dirty using reverse indices; notify components.
  const notifyPathChange = (path: Path) => {
    const changedRaw = keyOf(path);
    const lookups = prefixesOf(changedRaw);

    // 1) mark directly affected computeds dirty (raw → comp)
    const affected = new Set<DepKey>();
    for (const lk of lookups) {
      const set = reverseRawToComp.get(lk);
      if (!set) continue;
      for (const compKey of set) {
        const entry = computedRegistry.get(compKey);
        if (entry) {
          entry.dirty = true;
          affected.add(compKey);
        }
      }
    }

    // 2) propagate dirtiness transitively over computed graph (comp → comp)
    //    e.g., taxRate -> tax (dirty) -> total (dirty)
    const queue: DepKey[] = Array.from(affected);
    const seen = new Set<DepKey>(affected);
    while (queue.length) {
      const child = queue.shift()!;
      const parents = reverseCompToComp.get(child);
      if (!parents) continue;
      for (const parent of parents) {
        if (seen.has(parent)) continue;
        const e = computedRegistry.get(parent);
        if (e) {
          e.dirty = true;
          seen.add(parent);
          queue.push(parent);
          affected.add(parent);
        }
      }
    }

    // 3) notify components: raw match or affected computed match
    for (const [id, deps] of dependencyGraph) {
      if (typeof id !== "symbol") continue;

      let shouldPing = false;

      // raw match (ancestor/descendant)
      for (const d of deps) {
        if (d.startsWith(REF_COMPUTED_PREFIX)) continue;
        if (d === changedRaw || d.startsWith(changedRaw + ".") || changedRaw.startsWith(d + ".")) {
          shouldPing = true;
          break;
        }
      }

      // computed match
      if (!shouldPing && affected.size) {
        for (const c of affected) {
          if (deps.has(c)) {
            shouldPing = true;
            break;
          }
        }
      }

      if (shouldPing) componentSubscribers.get(id)?.();
    }
  };

  const store: Store = { root, subscribeComponent, notifyPathChange };
  storeOfRoot.set(root, store);
  return store;
};

/* ------------------------------------------------------------------ */
/* Live primitive                                                      */
/* ------------------------------------------------------------------ */

const isComputedPath = (p: Path | readonly [typeof __COMPUTED_VALUE_KEY, DepKey]):
  p is readonly [typeof __COMPUTED_VALUE_KEY, DepKey] =>
  Array.isArray(p) && p.length === 2 && p[0] === __COMPUTED_VALUE_KEY;

const createLivePrimitive = <T extends Primitive>(
  rootRef: object,
  path: Path | readonly [typeof __COMPUTED_VALUE_KEY, DepKey],
): LivePrimitive<T> => {
  const read = (): T => {
    if (isComputedPath(path)) {
      const compKey = path[1];
      maybeRecompute(compKey);
      const entry = computedRegistry.get(compKey);
      return entry?.last as T;
    }
    return getValueAtPath(rootRef, path) as T;
  };

  const access = (): T => {
    const val = read();
    if (currentTracker) {
      const id = currentTracker.id;
      const deps = ensureDepSet(id);
      if (isComputedPath(path)) deps.add(path[1]);
      else deps.add(keyOf(path));
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
  typeof v === "function" && (v as { __is_live_primitive?: unknown }).__is_live_primitive === true;

/* ------------------------------------------------------------------ */
/* Computed plumbing (lazy + reverse indices + flattening + graph)     */
/* ------------------------------------------------------------------ */

const computedKeyForPath = (absPath: DepKey): DepKey => `${REF_COMPUTED_PREFIX}${absPath}`;

const runComputed = (depKey: DepKey): unknown => {
  const entry = computedRegistry.get(depKey);
  if (!entry) return undefined;

  const deps = new Set<DepKey>();          // RAW deps captured during this run
  dependencyGraph.set(depKey, deps);

  // capture child-computed edges too if you use that feature
  const childCapture = new Set<DepKey>();
  _activeChildCapture = { parent: depKey, set: childCapture };

  const prev = currentTracker;
  currentTracker = { kind: "computed", id: depKey, deps };
  try {
    const val = entry.run();
    entry.last = val;
    entry.lastRun = Date.now();
    entry.dirty = false;
    reindexComputedRawDeps(depKey);
    reindexComputedChildDeps(depKey, childCapture);
    return val;
  } finally {
    currentTracker = prev;
    _activeChildCapture = null;
  }
};

const maybeRecompute = (depKey: DepKey): void => {
  const entry = computedRegistry.get(depKey);
  if (entry && entry.dirty) runComputed(depKey);
};

const reindexComputedRawDeps = (depKey: DepKey) => {
  const oldRaw = computedRawDeps.get(depKey) ?? new Set<DepKey>();
  const newRaw = dependencyGraph.get(depKey) ?? new Set<DepKey>();

  // unlink old (all prefixes)
  for (const raw of oldRaw) for (const p of prefixesOf(raw)) unlinkRawFromComp(p, depKey);

  // link new (all prefixes)
  for (const raw of newRaw) for (const p of prefixesOf(raw)) linkRawToComp(p, depKey);

  computedRawDeps.set(depKey, new Set(newRaw));
};

// Capture structure for comp->comp during a run
let _activeChildCapture: { parent: DepKey; set: Set<DepKey> } | null = null;

const reindexComputedChildDeps = (parent: DepKey, newChildren: Set<DepKey>) => {
  const old = computedChildDeps.get(parent) ?? new Set<DepKey>();
  // unlink old
  for (const child of old) unlinkCompToComp(child, parent);
  // link new
  for (const child of newChildren) linkCompToComp(child, parent);
  computedChildDeps.set(parent, new Set(newChildren));
};

const ensureComputed = (absPath: DepKey, runner: () => unknown): DepKey => {
  const depKey = computedKeyForPath(absPath);
  if (!computedRegistry.has(depKey)) {
    computedRegistry.set(depKey, { run: runner, last: undefined, lastRun: 0, dirty: true });
    // first read will compute
  }
  return depKey;
};

// When parent computed reads child computed, flatten child's RAW deps into parent
// AND record the comp->comp edge (so we can propagate dirtiness).
const mergeChildRawDepsIntoParent = (parentKey: DepKey, childKey: DepKey) => {
  maybeRecompute(childKey); // ensure child's raw deps are fresh
  const childRaw = computedRawDeps.get(childKey);
  if (childRaw) {
    const parentSet = ensureDepSet(parentKey);
    for (const raw of childRaw) parentSet.add(raw);
  }
  // record graph edge for transitive dirtying
  if (_activeChildCapture && _activeChildCapture.parent === parentKey) {
    _activeChildCapture.set.add(childKey);
  }
};

/* ------------------------------------------------------------------ */
/* Proxy creation                                                      */
/* ------------------------------------------------------------------ */

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
      if (prop === "__raw") return target;
      if (prop === "__isProxy") return true;

      if (typeof prop === "symbol") {
        return Reflect.get(obj, prop, receiver);
      }

      const key = String(prop);
      const currentPath: Path = [...base, key];
      const desc = getDescriptorDeep(obj, key);

      // ===== computed getter =====
      if (desc && "get" in desc && typeof desc.get === "function") {
        const abs = keyOf(currentPath);
        const depKey = ensureComputed(abs, () => desc.get!.call(receiver));

        if (currentTracker) {
          const id = currentTracker.id;

          if (typeof id === "symbol") {
            // Component reads a computed:
            // - depend on computed key
            // - depend on raw deps + their prefixes (robust raw notifications)
            const deps = ensureDepSet(id);
            deps.add(depKey);
            maybeRecompute(depKey);
            const raws = computedRawDeps.get(depKey);
            if (raws) {
              for (const raw of raws) {
                deps.add(raw);
                for (const pfx of prefixesOf(raw)) deps.add(pfx);
              }
            }
            const entry = computedRegistry.get(depKey);
            return entry ? entry.last : undefined;
          } else {
            // Computed reads another computed: flatten RAW deps + record comp->comp
            mergeChildRawDepsIntoParent(id, depKey);
            maybeRecompute(depKey);
            const entry = computedRegistry.get(depKey);
            return entry ? entry.last : undefined;
          }
        }

        // Not tracking: return live primitive for the computed value (lazy)
        return createLivePrimitive<Primitive>(
          { [__COMPUTED_VALUE_KEY]: computedValueRoot },
          [__COMPUTED_VALUE_KEY, depKey]
        );
      }

      // ===== data property =====
      const value = Reflect.get(obj, prop, receiver);

      // ref-wrapped: unwrap, still record raw dep
      if (isRef(value)) {
        if (currentTracker) {
          ensureDepSet(currentTracker.id).add(keyOf(currentPath));
        }
        return (value as Ref<unknown>).value;
      }

      // primitive: when tracking, read from ROOT and record raw; otherwise return live primitive
      if (isPrimitive(value)) {
        if (currentTracker) {
          ensureDepSet(currentTracker.id).add(keyOf(currentPath));
          return getValueAtPath(store.root, currentPath);
        }
        return createLivePrimitive<Primitive>(store.root, currentPath);
      }

      // nested object/array: recurse
      if (isObject(value)) {
        return makeProxy(value as object, store, currentPath, rootRef);
      }

      return value;
    },

    set(obj, prop, newVal, receiver) {
      const ok = Reflect.set(obj, prop, newVal, receiver);
      store.notifyPathChange([...base, String(prop)]);
      if (Array.isArray(obj) && prop !== "length") {
        // mutators like push/splice add indices; also bump length
        store.notifyPathChange([...base, "length"]);
      }
      return ok;
    },

    defineProperty(obj, prop, descriptor) {
      const ok = Reflect.defineProperty(obj, prop, descriptor);
      store.notifyPathChange([...base, String(prop)]);
      if (Array.isArray(obj) && prop !== "length") {
        store.notifyPathChange([...base, "length"]);
      }
      return ok;
    },

    deleteProperty(obj, prop) {
      const ok = Reflect.deleteProperty(obj, prop);
      store.notifyPathChange([...base, String(prop)]);
      if (Array.isArray(obj) && prop !== "length") {
        store.notifyPathChange([...base, "length"]);
      }
      return ok;
    },
  }) as T;

  proxyCache.set(target, p);
  storeOfProxy.set(p as unknown as object, store);
  proxyMeta.set(p as unknown as object, { store, base }); 
  return p;
};

// indirection root for computed live-primitive reads
const computedValueRoot = new Proxy<Record<string, unknown>>(
  {},
  {
    get(_t, depKey: string) {
      maybeRecompute(depKey);
      return computedRegistry.get(depKey)?.last;
    },
  },
);

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function proxy<T extends object>(initial: T): T {
  const store = createStore(initial as unknown as object);
  return makeProxy(initial, store, [], initial as unknown as object);
}


function snapshotPlain<T>(value: T) {
  if (isLivePrimitiveGuard<Primitive>(value)) {
    return (value as () => Primitive)();
  }
  if (value === null || typeof value !== "object") return value;

  // ---- Managed proxy ARRAY: read indices from root by absolute path
  if (Array.isArray(value)) {
    const arr = value as unknown as object;
    const meta = proxyMeta.get(arr);
    if (meta) {
      const { store, base } = meta;
      // track length
      if (currentTracker) {
        const deps = ensureDepSet(currentTracker.id);
        const lenKey = keyOf([...base, "length"]);
        deps.add(lenKey);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const len = (store.root as any)[base[0] as any] // cheap but we’ll robustly read length via Reflect
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? Reflect.get(getValueAtPath(store.root, base) as any, "length")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        : Reflect.get(getValueAtPath(store.root, base) as any, "length");

      const out = new Array(len as number);
      for (let i = 0; i < (len as number); i++) {
        const abs = [...base, String(i)];
        if (currentTracker) {
          const deps = ensureDepSet(currentTracker.id);
          const rawKey = keyOf(abs);
          deps.add(rawKey);
        }
        const rawVal = getValueAtPath(store.root, abs);
        out[i] = snapshotPlain(rawVal);
      }
      return out;
    }

    // Non-managed array: deep copy normally
    const src = value as unknown as Array<unknown>;
    const out = new Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = snapshotPlain(src[i]);
    return out;
  }

  // ---- Managed proxy OBJECT: copy enumerable props from root by absolute path
  const obj = value as unknown as object;
  const meta = proxyMeta.get(obj);
  if (meta) {
    const { store, base } = meta;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const target = (obj as any).__raw ?? obj; // enumerate actual keys
    const out: Record<string, unknown> = {};
    for (const k of Reflect.ownKeys(target)) {
      if (typeof k !== "string") continue;
      const desc = Object.getOwnPropertyDescriptor(target, k);
      if (!desc || !desc.enumerable) continue;

      const abs = [...base, k];
      if (currentTracker) {
        const deps = ensureDepSet(currentTracker.id);
        const rawKey = keyOf(abs);
        deps.add(rawKey);
      }
      const rawVal = getValueAtPath(store.root, abs);
      out[k] = snapshotPlain(rawVal);
    }
    return out;
  }

  // ---- Plain object (not managed): deep copy via own enumerable keys
  const plain = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(plain)) {
    out[k] = snapshotPlain(plain[k]);
  }
  return out;
}

export type Snapshot<T> =
  T extends LivePrimitive<infer P> ? P :
  T extends Primitive ? T :
  T extends Array<infer U> ? ReadonlyArray<Snapshot<U>> :
  T extends object ? { readonly [K in keyof T]: Snapshot<T[K]> } :
  never;

export function snapshot<T>(value: T): Snapshot<T> {
  if (isLivePrimitiveGuard<Primitive>(value)) {
    return value() as Snapshot<T>;
  }
  if (value === null || typeof value !== "object") {
    return value as Snapshot<T>;
  }

  // Always materialize arrays to plain data (prevents uncontrolled inputs)
  if (Array.isArray(value)) {
    return snapshotPlain(value) as Snapshot<T>;
  }
  

  // Managed proxy/root -> return a VIEW (bound to component) for OBJECTS
  const asObj = value as unknown as object;
  const maybeRaw = (asObj as { __raw?: object }).__raw ?? asObj;
  const isManaged = storeOfProxy.has(asObj) || storeOfRoot.has(maybeRaw);
  if (isManaged) {
    const bind =
      currentTracker && currentTracker.kind === "component"
        ? { id: currentTracker.id as symbol, deps: currentTracker.deps as Set<DepKey> }
        : undefined;
    return makeSnapshotView(asObj, bind) as Snapshot<T>;
  }

  // Plain non-managed object: materialize shallowly
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>)) {
    out[k] = snapshot((value as Record<string, unknown>)[k]);
  }
  return out as Snapshot<T>;
}


function makeSnapshotView<T extends object>(
  proxyObj: T,
  bind?: { id: symbol; deps: Set<DepKey> }
): Snapshot<T> {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (typeof prop === "symbol") {
        return Reflect.get(proxyObj as object, prop);
      }

      // Run the read under the same component tracker if bound.
      const readUnder = <R>(thunk: () => R): R => {
        if (!bind) return thunk();
        const prev = currentTracker;
        currentTracker = { kind: "component", id: bind.id, deps: bind.deps };
        try {
          return thunk();
        } finally {
          currentTracker = prev;
        }
      };

      const val = readUnder(() => Reflect.get(proxyObj as object, prop));

      // SAFETY: if a live-primitive fn leaked, force-deref it
      if (isLivePrimitiveGuard<Primitive>(val)) {
        return (val as () => Primitive)();


      }

      // For arrays returned from an object property, immediately deep materialize
      // to a plain array so React sees a normal array (map/iterator safe).
      if (Array.isArray(val)) {
        return snapshotPlain(val);
      }

      // For managed nested objects, return another bound view so nested reads track too
      if (val !== null && typeof val === "object") {
        const asObj = val as object;
        const maybeRaw = (asObj as { __raw?: object }).__raw ?? asObj;
        if (storeOfProxy.has(asObj) || storeOfRoot.has(maybeRaw)) {
          return makeSnapshotView(asObj, bind);
        }
      }

      return val;
    },

    ownKeys() {
      return Reflect.ownKeys(proxyObj as object);
    },

    getOwnPropertyDescriptor(_t, prop) {
      return {
        configurable: true,
        enumerable: true,
        writable: false,
        value: Reflect.get(proxyObj as object, prop),
      };
    },
  };

  return new Proxy<object>({}, handler) as Snapshot<T>;
}






export function getStoreFor(state: object): Store {
  const maybeRaw = (state as { __raw?: object }).__raw ?? state;
  const byRoot = storeOfRoot.get(maybeRaw);
  if (byRoot) return byRoot;

  const byProxy = storeOfProxy.get(state);
  if (byProxy) return byProxy;

  throw new Error("useSnapshot() expects a value created by proxy() (root or nested).");
}

export function withComponentTracking<S>(id: symbol, fn: () => S): S {
  const deps = new Set<DepKey>();
  dependencyGraph.set(id, deps);
  const prev = currentTracker;
  currentTracker = { kind: "component", id, deps };
  try {
    return fn();
  } finally {
    currentTracker = prev;
  }
}

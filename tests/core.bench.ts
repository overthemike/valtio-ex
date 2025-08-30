// bench/core.bench.ts
import { bench, describe, beforeAll } from 'vitest';

// ---- import your core (adjust path to your file) ----
import { proxy, snapshot, withComponentTracking } from '../src/ripplio'; // or '../src/reactive-core'

// ---- helpers (no `any`) ----
type Primitive = string | number | boolean | bigint | symbol | null | undefined;
const isPrimitive = (v: unknown): v is Primitive =>
  v === null ||
  v === undefined ||
  typeof v === 'string' ||
  typeof v === 'number' ||
  typeof v === 'boolean' ||
  typeof v === 'bigint' ||
  typeof v === 'symbol';

let sink: unknown; // defeat DCE

function makeRng(seedInit = 0x2f6e2b1): () => number {
  let s = seedInit >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 0x3fffffff) / 0x3fffffff;
  };
}
const rng = makeRng(0xdeadbeef);
const randInt = (n: number) => Math.floor(rng() * n);

// ---- state builders ----
type Item = { id: string; name: string; price: number; qty: number };
type StoreShape = {
  cart: { items: Item[] };
  taxRate: number;
  prefs: { theme: 'light' | 'dark' };
  get itemCount(): number;
  get subtotal(): number;
  get tax(): number;
  get total(): number;
};

function makeStore(n: number): StoreShape {
  const items: Item[] = Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    name: `Item ${i}`,
    price: 1 + (i % 10),
    qty: 1 + (i % 3),
  }));
  return proxy({
    cart: { items },
    taxRate: 0.1,
    prefs: { theme: 'light' as const },

    get itemCount() {
      return this.cart.items.length;
    },
    get subtotal() {
      return this.cart.items.reduce(
        (s: number, it: Item) => s + it.price * it.qty,
        0
      );
    },
    get tax() {
      return this.subtotal * this.taxRate;
    },
    get total() {
      return this.subtotal + this.tax;
    },
  });
}

// Warm a store: touch computeds and simulate one component render (tracking + snapshot)
function warmStore(s: StoreShape) {
  // ensure computeds are created once
  void s.itemCount; void s.subtotal; void s.tax; void s.total;

  const id = Symbol('warm');
  withComponentTracking(id, () => {
    const snap = snapshot(s);
    // read a few fields to register deps
    sink = (snap as StoreShape).total;
  });
}

// ---- fixtures ----
const SMALL = makeStore(200);
const LARGE = makeStore(10_000);

beforeAll(() => {
  warmStore(SMALL);
  warmStore(LARGE);
});

// ---- benchmark groups ----
describe('read (lazy snapshot)', () => {
  bench('read total [small]', () => {
    const id = Symbol('r-small');
    withComponentTracking(id, () => {
      const snap = snapshot(SMALL);
      sink = (snap as StoreShape).total;
    });
  });

  bench('read total [large]', () => {
    const id = Symbol('r-large');
    withComponentTracking(id, () => {
      const snap = snapshot(LARGE);
      sink = (snap as StoreShape).total;
    });
  });

  bench('read nested row.qty [index 0]', () => {
    const id = Symbol('row-0');
    withComponentTracking(id, () => {
      const row = snapshot(SMALL.cart.items[0]);
      sink = (row as Item).qty;
    });
  });

  bench('read nested row.qty [random]', () => {
    const i = randInt(LARGE.cart.items.length);
    const id = Symbol('row-i');
    withComponentTracking(id, () => {
      const row = snapshot(LARGE.cart.items[i]);
      sink = (row as Item).qty;
    });
  });
});

describe('write (leaf) + recompute chain', () => {
  bench('update price [small]', () => {
    const i = randInt(SMALL.cart.items.length);
    SMALL.cart.items[i].price += 1;
  });

  bench('update price [large]', () => {
    const i = randInt(LARGE.cart.items.length);
    LARGE.cart.items[i].price += 1;
  });

  bench('update qty [small]', () => {
    const i = randInt(SMALL.cart.items.length);
    SMALL.cart.items[i].qty = ((SMALL.cart.items[i].qty + 1) % 5) + 1;
  });
});

describe('write (independent primitive)', () => {
  bench('update taxRate [small]', () => {
    SMALL.taxRate = +(Math.min(0.5, SMALL.taxRate + 0.0005).toFixed(4));
  });

  bench('update taxRate [large]', () => {
    LARGE.taxRate = +(Math.min(0.5, LARGE.taxRate + 0.0005).toFixed(4));
  });
});

describe('structural writes', () => {
  bench('push item [small]', () => {
    const id = `n-${randInt(1e9)}`;
    SMALL.cart.items.push({ id, name: 'N', price: 1 + randInt(10), qty: 1 + randInt(3) });
  });

  bench('push item [large]', () => {
    const id = `n-${randInt(1e9)}`;
    LARGE.cart.items.push({ id, name: 'N', price: 1 + randInt(10), qty: 1 + randInt(3) });
  });

  bench('replace subobject (user-like)', () => {
    const obj = proxy({ user: { name: 'Michael' } });
    // warm a component that reads nested proxy
    const id = Symbol('rep-warm');
    withComponentTracking(id, () => {
      const snap = snapshot(obj.user);
      sink = (snap as { name: string }).name;
    });
    // replace the subobject (exercise root-path resolve fix)
    obj.user = { name: 'Daishi' };
  });
});

// optional: plain snapshot cost (if you still have an eager snapshot to compare)
describe('plain JS read (sanity)', () => {
  bench('direct computed chain (no snapshot/tracking)', () => {
    // side note: not apples-to-apples; useful as a lower bound baseline
    sink = LARGE.cart.items.reduce((s, it) => s + it.price * it.qty, 0) * LARGE.taxRate;
  });
});

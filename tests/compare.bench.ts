// bench/compare.bench.ts
import { bench, describe, beforeAll } from "vitest";

// ---- Your engine (adjust the path) ----
import {
  proxy as oursProxy,
  snapshot as oursSnapshot,
  withComponentTracking,
} from "../src/ripplio";

// ---- Valtio (vanilla) ----
import {
  proxy as valtioProxy,
  snapshot as valtioSnapshot,
} from "valtio/vanilla";

// ---------- helpers (no `any`) ----------
type Primitive = string | number | boolean | bigint | symbol | null | undefined;
const isPrimitive = (v: unknown): v is Primitive =>
  v === null ||
  v === undefined ||
  typeof v === "string" ||
  typeof v === "number" ||
  typeof v === "boolean" ||
  typeof v === "bigint" ||
  typeof v === "symbol";

// defeat DCE
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let sink: unknown;

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
const rng = makeRng(0xC0FFEE);
const randInt = (n: number) => Math.floor(rng() * n);

// ---------- store shapes ----------
type Item = { id: string; name: string; price: number; qty: number };
type BaseShape = {
  cart: { items: Item[] };
  taxRate: number;
  prefs: { theme: "light" | "dark" };
  get itemCount(): number;
  get subtotal(): number;
  get tax(): number;
  get total(): number;
};

// our engine store
function makeOursStore(n: number): BaseShape {
  const items: Item[] = Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    name: `Item ${i}`,
    price: 1 + (i % 10),
    qty: 1 + (i % 3),
  }));
  return oursProxy({
    cart: { items },
    taxRate: 0.1,
    prefs: { theme: "light" as const },

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

// valtio store
function makeValtioStore(n: number): BaseShape {
  const items: Item[] = Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    name: `Item ${i}`,
    price: 1 + (i % 10),
    qty: 1 + (i % 3),
  }));
  return valtioProxy({
    cart: { items },
    taxRate: 0.1,
    prefs: { theme: "light" as const },

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
  }) as BaseShape;
}

// ---------- fixtures ----------
const SMALL_OURS = makeOursStore(200);
const LARGE_OURS = makeOursStore(10_000);

const SMALL_VALTIO = makeValtioStore(200);
const LARGE_VALTIO = makeValtioStore(10_000);

function warmOurs(s: BaseShape) {
  // touch computeds once
  void s.itemCount; void s.subtotal; void s.tax; void s.total;
  // simulate a component render (tracking + lazy snapshot)
  const id = Symbol("warm");
  withComponentTracking(id, () => {
    const snap = oursSnapshot(s);
    sink = (snap as BaseShape).total;
  });
}

function warmValtio(s: BaseShape) {
  // touch computeds
  void s.itemCount; void s.subtotal; void s.tax; void s.total;
  // realize a snapshot (Valtio deep/frozen snapshot)
  const snap = valtioSnapshot(s);
  sink = (snap as BaseShape).total;
}

beforeAll(() => {
  warmOurs(SMALL_OURS);
  warmOurs(LARGE_OURS);
  warmValtio(SMALL_VALTIO);
  warmValtio(LARGE_VALTIO);
});

// ---------- READ: computed chain ----------
describe("read: total (proxy direct)", () => {
  bench("ours: small", () => {
    sink = SMALL_OURS.total;
  });
  bench("valtio: small", () => {
    sink = SMALL_VALTIO.total;
  });

  bench("ours: large", () => {
    sink = LARGE_OURS.total;
  });
  bench("valtio: large", () => {
    sink = LARGE_VALTIO.total;
  });
});

describe("read: total (snapshot access)", () => {
  bench("ours (lazy snapshot): small", () => {
    const id = Symbol("r-snap-s");
    withComponentTracking(id, () => {
      const snap = oursSnapshot(SMALL_OURS);
      sink = (snap as BaseShape).total;
    });
  });

  bench("valtio (deep snapshot): small", () => {
    const snap = valtioSnapshot(SMALL_VALTIO);
    sink = (snap as BaseShape).total;
  });

  bench("ours (lazy snapshot): large", () => {
    const id = Symbol("r-snap-l");
    withComponentTracking(id, () => {
      const snap = oursSnapshot(LARGE_OURS);
      sink = (snap as BaseShape).total;
    });
  });

  bench("valtio (deep snapshot): large", () => {
    const snap = valtioSnapshot(LARGE_VALTIO);
    sink = (snap as BaseShape).total;
  });
});

// ---------- WRITE: leaf updates (price/qty) ----------
describe("write: leaf update (price)", () => {
  bench("ours: small", () => {
    const i = randInt(SMALL_OURS.cart.items.length);
    SMALL_OURS.cart.items[i].price += 1;
  });
  bench("valtio: small", () => {
    const i = randInt(SMALL_VALTIO.cart.items.length);
    SMALL_VALTIO.cart.items[i].price += 1;
  });

  bench("ours: large", () => {
    const i = randInt(LARGE_OURS.cart.items.length);
    LARGE_OURS.cart.items[i].price += 1;
  });
  bench("valtio: large", () => {
    const i = randInt(LARGE_VALTIO.cart.items.length);
    LARGE_VALTIO.cart.items[i].price += 1;
  });
});

describe("write: independent primitive (taxRate)", () => {
  bench("ours: small", () => {
    SMALL_OURS.taxRate = +(Math.min(0.5, SMALL_OURS.taxRate + 0.0005).toFixed(4));
  });
  bench("valtio: small", () => {
    SMALL_VALTIO.taxRate = +(Math.min(0.5, SMALL_VALTIO.taxRate + 0.0005).toFixed(4));
  });

  bench("ours: large", () => {
    LARGE_OURS.taxRate = +(Math.min(0.5, LARGE_OURS.taxRate + 0.0005).toFixed(4));
  });
  bench("valtio: large", () => {
    LARGE_VALTIO.taxRate = +(Math.min(0.5, LARGE_VALTIO.taxRate + 0.0005).toFixed(4));
  });
});

// ---------- STRUCTURAL: push item ----------
describe("structural writes (push item)", () => {
  bench("ours: small", () => {
    const id = `n-${randInt(1e9)}`;
    SMALL_OURS.cart.items.push({ id, name: "N", price: 1 + randInt(10), qty: 1 + randInt(3) });
  });
  bench("valtio: small", () => {
    const id = `n-${randInt(1e9)}`;
    SMALL_VALTIO.cart.items.push({ id, name: "N", price: 1 + randInt(10), qty: 1 + randInt(3) });
  });

  bench("ours: large", () => {
    const id = `n-${randInt(1e9)}`;
    LARGE_OURS.cart.items.push({ id, name: "N", price: 1 + randInt(10), qty: 1 + randInt(3) });
  });
  bench("valtio: large", () => {
    const id = `n-${randInt(1e9)}`;
    LARGE_VALTIO.cart.items.push({ id, name: "N", price: 1 + randInt(10), qty: 1 + randInt(3) });
  });
});

// ---------- READ: nested row (proxy vs snapshot) ----------
describe("read: row.qty (nested)", () => {
  bench("ours: proxy direct", () => {
    const i = randInt(SMALL_OURS.cart.items.length);
    sink = SMALL_OURS.cart.items[i].qty;
  });
  bench("valtio: proxy direct", () => {
    const i = randInt(SMALL_VALTIO.cart.items.length);
    sink = SMALL_VALTIO.cart.items[i].qty;
  });

  bench("ours: lazy snapshot nested", () => {
    const i = randInt(SMALL_OURS.cart.items.length);
    const id = Symbol("row-snap");
    withComponentTracking(id, () => {
      const rowSnap = oursSnapshot(SMALL_OURS.cart.items[i]);
      sink = (rowSnap as Item).qty;
    });
  });

  bench("valtio: deep snapshot nested", () => {
    const i = randInt(SMALL_VALTIO.cart.items.length);
    const rowSnap = valtioSnapshot(SMALL_VALTIO.cart.items[i]);
    sink = (rowSnap as Item).qty;
  });
});

import { bench, describe, beforeAll } from "vitest";

// ----- your engine -----
import {
  proxy as oursProxy,
  snapshot as oursSnapshot,
  withComponentTracking,
} from "../src/ripplio";

// ----- valtio + valtio-reactive -----
import { proxy as vProxy } from "valtio/vanilla";
import { computed as vComputed } from "valtio-reactive";

// ---------- helpers ----------
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

function makeRng(seedInit = 0xA11CE): () => number {
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
const ri = (n: number) => Math.floor(rng() * n);

// ---------- shared types ----------
type Item = { id: string; name: string; price: number; qty: number };

// “ours” shape with deeper computeds + fan-out getters
type OursShape = {
  cart: { items: Item[] };
  taxRate: number;
  feeRate: number;
  get itemCount(): number;
  get subtotal(): number;
  get tax(): number;
  get fee(): number;
  get total(): number;
  get grand(): number;
} & Record<`fan${number}`, number>; // fan-out getters

// valtio-reactive bundle
type VRBundle = {
  base: {
    cart: { items: Item[] };
    taxRate: number;
    feeRate: number;
  };
  subtotal: { readonly value: number };
  tax: { readonly value: number };
  fee: { readonly value: number };
  total: { readonly value: number };
  grand: { readonly value: number };
  // fanout readers (computed signals that all read `grand`)
  fans: ReadonlyArray<{ readonly value: number }>;
};

// ---------- builders ----------
function makeOurs(nItems: number, fanCount: number): OursShape {
  const items: Item[] = Array.from({ length: nItems }, (_, i) => ({
    id: `id-${i}`,
    name: `Item ${i}`,
    price: 1 + (i % 10),
    qty: 1 + (i % 3),
  }));

  // base object with computed chain
  const base = {
    cart: { items },
    taxRate: 0.1,
    feeRate: 0.05,

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
    get fee() {
      return this.subtotal * this.feeRate;
    },
    get total() {
      return this.subtotal + this.tax;
    },
    get grand() {
      return this.total + this.fee;
    },
  } as OursShape;

  // add “fanout” getters that all ultimately depend on grand
  for (let i = 0; i < fanCount; i++) {
    Object.defineProperty(base, `fan${i}`, {
      enumerable: true,
      configurable: false,
      get() {
        // light transform to avoid being optimized out
        return this.grand + (i % 3);
      },
    });
  }

  return oursProxy(base);
}

function makeVR(nItems: number, fanCount: number): VRBundle {
  const items: Item[] = Array.from({ length: nItems }, (_, i) => ({
    id: `id-${i}`,
    name: `Item ${i}`,
    price: 1 + (i % 10),
    qty: 1 + (i % 3),
  }));

  const base = vProxy({
    cart: { items },
    taxRate: 0.1,
    feeRate: 0.05,
  });

  const subtotal = vComputed({
    value: () => base.cart.items.reduce(
      (s: number, it: Item) => s + it.price * it.qty, 0),
  });
  const tax = vComputed({
    value: () => subtotal.value * base.taxRate,
  });
  const fee = vComputed({
    value: () => subtotal.value * base.feeRate,
  });
  const total = vComputed({
    value: () => subtotal.value + tax.value,
  });
  const grand = vComputed({
    value: () => total.value + fee.value,
  });

  // fanout readers that all depend on grand
  const fans = Array.from({ length: fanCount }, (_, i) =>
    vComputed({ value: () => grand.value + (i % 3) })
  );

  return { base, subtotal, tax, fee, total, grand, fans };
}

// ---------- fixtures ----------
const SMALL_OURS = makeOurs(200, 50);
const LARGE_OURS = makeOurs(10_000, 50);

const SMALL_VR = makeVR(200, 50);
const LARGE_VR = makeVR(10_000, 50);

// ---------- warm ----------
beforeAll(() => {
  // warm ours: computed chain + a component render (lazy snapshot path)
  const warmOurs = (s: OursShape) => {
    void s.itemCount; void s.subtotal; void s.tax; void s.fee; void s.total; void s.grand;
    for (let i = 0; i < 5; i++) void s[`fan${i}` as const];
    const id = Symbol("warm");
    withComponentTracking(id, () => {
      const snap = oursSnapshot(s);
      sink = (snap as OursShape).grand;
    });
  };
  warmOurs(SMALL_OURS);
  warmOurs(LARGE_OURS);

  // warm vr
  const warmVR = (b: VRBundle) => {
    sink = b.grand.value;
    for (let i = 0; i < 5; i++) sink = b.fans[i]!.value;
  };
  warmVR(SMALL_VR);
  warmVR(LARGE_VR);
});

// ---------- READ: deep chain ----------
describe("read: deep computed chain (grand)", () => {
  bench("ours: proxy direct (small)", () => {
    sink = SMALL_OURS.grand;
  });
  bench("valtio-reactive: grand.value (small)", () => {
    sink = SMALL_VR.grand.value;
  });

  bench("ours: proxy direct (large)", () => {
    sink = LARGE_OURS.grand;
  });
  bench("valtio-reactive: grand.value (large)", () => {
    sink = LARGE_VR.grand.value;
  });
});

// ---------- READ: fan-out (many dependents of the same base) ----------
describe("read: fan-out (50 dependents)", () => {
  bench("ours: read 5 fan getters (small)", () => {
    // emulate a few components reading different fans
    sink = SMALL_OURS.fan0 + SMALL_OURS.fan7 + SMALL_OURS.fan13 + SMALL_OURS.fan21 + SMALL_OURS.fan34;
  });
  bench("valtio-reactive: read 5 fan computeds (small)", () => {
    const f = SMALL_VR.fans;
    sink = f[0]!.value + f[7]!.value + f[13]!.value + f[21]!.value + f[34]!.value;
  });

  bench("ours: read 5 fan getters (large)", () => {
    sink = LARGE_OURS.fan1 + LARGE_OURS.fan8 + LARGE_OURS.fan14 + LARGE_OURS.fan22 + LARGE_OURS.fan35;
  });
  bench("valtio-reactive: read 5 fan computeds (large)", () => {
    const f = LARGE_VR.fans;
    sink = f[1]!.value + f[8]!.value + f[14]!.value + f[22]!.value + f[35]!.value;
  });
});

// ---------- WRITE: leaf updates (exercise full chain invalidation) ----------
describe("write: leaf update (price) → invalidates grand/fans", () => {
  bench("ours: small", () => {
    const i = ri(SMALL_OURS.cart.items.length);
    SMALL_OURS.cart.items[i].price += 1;
  });
  bench("valtio-reactive: small", () => {
    const i = ri(SMALL_VR.base.cart.items.length);
    SMALL_VR.base.cart.items[i].price += 1;
  });

  bench("ours: large", () => {
    const i = ri(LARGE_OURS.cart.items.length);
    LARGE_OURS.cart.items[i].price += 1;
  });
  bench("valtio-reactive: large", () => {
    const i = ri(LARGE_VR.base.cart.items.length);
    LARGE_VR.base.cart.items[i].price += 1;
  });
});

// ---------- WRITE: independent primitive (tax/fee rate) ----------
describe("write: taxRate & feeRate (independent primitives)", () => {
  bench("ours: taxRate (small)", () => {
    SMALL_OURS.taxRate = +(Math.min(0.5, SMALL_OURS.taxRate + 0.0005).toFixed(4));
  });
  bench("valtio-reactive: taxRate (small)", () => {
    SMALL_VR.base.taxRate = +(Math.min(0.5, SMALL_VR.base.taxRate + 0.0005).toFixed(4));
  });

  bench("ours: feeRate (small)", () => {
    SMALL_OURS.feeRate = +(Math.min(0.2, SMALL_OURS.feeRate + 0.0005).toFixed(4));
  });
  bench("valtio-reactive: feeRate (small)", () => {
    SMALL_VR.base.feeRate = +(Math.min(0.2, SMALL_VR.base.feeRate + 0.0005).toFixed(4));
  });

  bench("ours: taxRate (large)", () => {
    LARGE_OURS.taxRate = +(Math.min(0.5, LARGE_OURS.taxRate + 0.0005).toFixed(4));
  });
  bench("valtio-reactive: taxRate (large)", () => {
    LARGE_VR.base.taxRate = +(Math.min(0.5, LARGE_VR.base.taxRate + 0.0005).toFixed(4));
  });

  bench("ours: feeRate (large)", () => {
    LARGE_OURS.feeRate = +(Math.min(0.2, LARGE_OURS.feeRate + 0.0005).toFixed(4));
  });
  bench("valtio-reactive: feeRate (large)", () => {
    LARGE_VR.base.feeRate = +(Math.min(0.2, LARGE_VR.base.feeRate + 0.0005).toFixed(4));
  });
});

// ---------- STRUCTURAL: splice/replace/row-replace ----------
describe("structural: splice and replace", () => {
  bench("ours: splice(0,1) (small)", () => {
    SMALL_OURS.cart.items.splice(0, 1);
  });
  bench("valtio-reactive: splice(0,1) (small)", () => {
    SMALL_VR.base.cart.items.splice(0, 1);
  });

  bench("ours: replace row (small)", () => {
    const i = ri(SMALL_OURS.cart.items.length);
    SMALL_OURS.cart.items[i] = {
      id: `rep-${i}`,
      name: "Rep",
      price: 3,
      qty: 2,
    };
  });
  bench("valtio-reactive: replace row (small)", () => {
    const i = ri(SMALL_VR.base.cart.items.length);
    SMALL_VR.base.cart.items[i] = {
      id: `rep-${i}`,
      name: "Rep",
      price: 3,
      qty: 2,
    };
  });

  bench("ours: replace whole items array (small)", () => {
    SMALL_OURS.cart.items = SMALL_OURS.cart.items.slice();
  });
  bench("valtio-reactive: replace whole items array (small)", () => {
    SMALL_VR.base.cart.items = SMALL_VR.base.cart.items.slice();
  });
});

// ---------- READ via lazy snapshot (ours) to mimic React renders ----------
describe("ours: read via lazy snapshot (grand + fans)", () => {
  const CMP = Symbol("cmp");
  bench("lazy snapshot: grand (small)", () => {
    withComponentTracking(CMP, () => {
      const snap = oursSnapshot(SMALL_OURS);
      sink = (snap as OursShape).grand;
    });
  });

  bench("lazy snapshot: 5 fans (small)", () => {
    withComponentTracking(CMP, () => {
      const snap = oursSnapshot(SMALL_OURS);
      const s = snap as OursShape;
      sink = s.fan0 + s.fan7 + s.fan13 + s.fan21 + s.fan34;
    });
  });

  bench("lazy snapshot: grand (large)", () => {
    withComponentTracking(CMP, () => {
      const snap = oursSnapshot(LARGE_OURS);
      sink = (snap as OursShape).grand;
    });
  });

  bench("lazy snapshot: 5 fans (large)", () => {
    withComponentTracking(CMP, () => {
      const snap = oursSnapshot(LARGE_OURS);
      const s = snap as OursShape;
      sink = s.fan1 + s.fan8 + s.fan14 + s.fan22 + s.fan35;
    });
  });
});

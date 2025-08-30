import { bench, describe, beforeAll } from "vitest";

// ----- ours -----
import {
  proxy as oursProxy,
  snapshot as oursSnapshot,
  withComponentTracking,
} from "../src/ripplio";

// ----- valtio vanilla + valtio-reactive -----
import { proxy as vProxy } from "valtio/vanilla";
import { computed as vReactiveComputed } from "valtio-reactive";

// helpers
type Primitive = string | number | boolean | bigint | symbol | null | undefined;
const isPrimitive = (v: unknown): v is Primitive =>
  v === null ||
  v === undefined ||
  typeof v === "string" ||
  typeof v === "number" ||
  typeof v === "boolean" ||
  typeof v === "bigint" ||
  typeof v === "symbol";

let sink: unknown;
function makeRng(seedInit = 0xC0FFEE): () => number {
  let s = seedInit >>> 0;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 0x3fffffff) / 0x3fffffff;
  };
}
const rng = makeRng();
const ri = (n: number) => Math.floor(rng() * n);

// types & store builders
type Item = { id: string; name: string; price: number; qty: number };
type Shape = {
  cart: { items: Item[] };
  taxRate: number;
  get subtotal(): number;
  get tax(): number;
  get total(): number;
};

function makeOurs(n: number): Shape {
  const items: Item[] = Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    name: `Item ${i}`,
    price: 1 + (i % 10),
    qty: 1 + (i % 3),
  }));
  return oursProxy({
    cart: { items },
    taxRate: 0.1,
    get subtotal() {
      return this.cart.items.reduce(
        (s: number, it: Item) => s + it.price * it.qty, 0
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

function makeValtioWithReactive(n: number) {
  const items: Item[] = Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    name: `Item ${i}`,
    price: 1 + (i % 10),
    qty: 1 + (i % 3),
  }));
  const base = vProxy({
    cart: { items },
    taxRate: 0.1,
  });

  // valtio-reactive computed objects.
  // Use three separate objects to model a chain without self-reference hazards.
  const subtotal = vReactiveComputed({
    value: () => base.cart.items.reduce(
      (s: number, it: Item) => s + it.price * it.qty, 0),
  });
  const tax = vReactiveComputed({
    value: () => subtotal.value * base.taxRate,
  });
  const total = vReactiveComputed({
    value: () => subtotal.value + tax.value,
  });

  return { base, subtotal, tax, total };
}

// fixtures
const SMALL_OURS = makeOurs(200);
const LARGE_OURS = makeOurs(10_000);

const SMALL_VR = makeValtioWithReactive(200);
const LARGE_VR = makeValtioWithReactive(10_000);

// warm
beforeAll(() => {
  const warm = (s: Shape) => {
    void s.subtotal; void s.tax; void s.total;
    const id = Symbol("warm");
    withComponentTracking(id, () => {
      const snap = oursSnapshot(s);
      sink = (snap as Shape).total;
    });
  };
  warm(SMALL_OURS);
  warm(LARGE_OURS);

  // access vals in valtio-reactive once
  sink = SMALL_VR.total.value;
  sink = LARGE_VR.total.value;
});

// READ: computed chain
describe("read: computed chain", () => {
  bench("ours: proxy direct (small)", () => {
    sink = SMALL_OURS.total;
  });
  bench("valtio-reactive: total.value (small)", () => {
    sink = SMALL_VR.total.value;
  });

  bench("ours: proxy direct (large)", () => {
    sink = LARGE_OURS.total;
  });
  bench("valtio-reactive: total.value (large)", () => {
    sink = LARGE_VR.total.value;
  });
});

// WRITE: leaf updates
describe("write: leaf price", () => {
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

// WRITE: independent primitive
describe("write: taxRate", () => {
  bench("ours: small", () => {
    SMALL_OURS.taxRate = +(Math.min(0.5, SMALL_OURS.taxRate + 0.0005).toFixed(4));
  });
  bench("valtio-reactive: small", () => {
    SMALL_VR.base.taxRate = +(Math.min(0.5, SMALL_VR.base.taxRate + 0.0005).toFixed(4));
  });

  bench("ours: large", () => {
    LARGE_OURS.taxRate = +(Math.min(0.5, LARGE_OURS.taxRate + 0.0005).toFixed(4));
  });
  bench("valtio-reactive: large", () => {
    LARGE_VR.base.taxRate = +(Math.min(0.5, LARGE_VR.base.taxRate + 0.0005).toFixed(4));
  });
});

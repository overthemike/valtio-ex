// bench/compare-reactive.coc.bench.ts
import { bench, describe, beforeAll } from "vitest";
import { proxy as oursProxy, snapshot as oursSnapshot, withComponentTracking } from "../src/ripplio";
import { proxy as vProxy } from "valtio/vanilla";
import { computed as vComputed, batch as vBatch } from "valtio-reactive";

type Item = { id: string; price: number; qty: number };
let sink: unknown;

function makeRng(seedInit = 0xC0FFEE): () => number {
  let s = seedInit >>> 0;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 0x3fffffff) / 0x3fffffff; };
}
const rng = makeRng(0xA11CE);
const ri = (n: number) => Math.floor(rng() * n);

// ----- ours -----
type OursShape = {
  items: Item[];
  taxRate: number;
  get subtotal(): number;
  get tax(): number;
  get total(): number;
  get A(): { subtotal: number };
  get B(): { tax: number };
  get C(): { total: number };
};

function makeOurs(n: number): OursShape {
  const items: Item[] = Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, price: 1 + (i % 10), qty: 1 + (i % 3) }));
  return oursProxy({
    items,
    taxRate: 0.1,
    get subtotal() { return this.items.reduce((s: number, it: Item) => s + it.price * it.qty, 0); },
    get tax() { return this.subtotal * this.taxRate; },
    get total() { return this.subtotal + this.tax; },
    get A() { return { subtotal: this.subtotal }; },
    get B() { return { tax: this.A.subtotal * this.taxRate }; },
    get C() { return { total: this.A.subtotal + this.B.tax }; },
  } as OursShape);
}

// ----- valtio-reactive (signal + object) -----
type VRSignal = { base: { items: Item[]; taxRate: number }; subtotal: { readonly value: number }; tax: { readonly value: number }; total: { readonly value: number } };
type VRObject =  { base: { items: Item[]; taxRate: number }; A: { readonly subtotal: number }; B: { readonly tax: number }; C: { readonly total: number } };

function makeVRSignal(n: number): VRSignal {
  const items: Item[] = Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, price: 1 + (i % 10), qty: 1 + (i % 3) }));
  const base = vProxy({ items, taxRate: 0.1 });
  const subtotal = vComputed({ value: () => base.items.reduce((s, it) => s + it.price * it.qty, 0) });
  const tax      = vComputed({ value: () => subtotal.value * base.taxRate });
  const total    = vComputed({ value: () => subtotal.value + tax.value });
  return { base, subtotal, tax, total };
}

function makeVRObject(n: number): VRObject {
  const items: Item[] = Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, price: 1 + (i % 10), qty: 1 + (i % 3) }));
  const base = vProxy({ items, taxRate: 0.1 });
  const A = vComputed({ subtotal: () => base.items.reduce((s, it) => s + it.price * it.qty, 0) });
  const B = vComputed({ tax: () => A.subtotal * base.taxRate });
  const C = vComputed({ total: () => A.subtotal + B.tax });
  return { base, A, B, C };
}

// fixtures
const SMALL_OURS = makeOurs(200);
const LARGE_OURS = makeOurs(10_000);
const SMALL_VR_SIG = makeVRSignal(200);
const LARGE_VR_SIG = makeVRSignal(10_000);
const SMALL_VR_OBJ = makeVRObject(200);
const LARGE_VR_OBJ = makeVRObject(10_000);

// warm
beforeAll(() => {
  const CMP = Symbol("warm");
  void SMALL_OURS.total; void SMALL_OURS.C.total;
  void LARGE_OURS.total; void LARGE_OURS.C.total;
  withComponentTracking(CMP, () => { const s = oursSnapshot(SMALL_OURS); sink = (s as OursShape).total + (s as OursShape).C.total; });
  withComponentTracking(CMP, () => { const s = oursSnapshot(LARGE_OURS); sink = (s as OursShape).total + (s as OursShape).C.total; });
  sink = SMALL_VR_SIG.total.value; sink = LARGE_VR_SIG.total.value;
  sink = SMALL_VR_OBJ.C.total;     sink = LARGE_VR_OBJ.C.total;
});

// reads
describe("computed-of-computed (signal style)", () => {
  bench("ours: total [small]", () => { sink = SMALL_OURS.total; });
  bench("valtio-reactive: total.value [small]", () => { sink = SMALL_VR_SIG.total.value; });
  bench("ours: total [large]", () => { sink = LARGE_OURS.total; });
  bench("valtio-reactive: total.value [large]", () => { sink = LARGE_VR_SIG.total.value; });
});

describe("computed-of-computed (object style)", () => {
  bench("ours: C.total [small]", () => { sink = SMALL_OURS.C.total; });
  bench("valtio-reactive: C.total [small]", () => { sink = SMALL_VR_OBJ.C.total; });
  bench("ours: C.total [large]", () => { sink = LARGE_OURS.C.total; });
  bench("valtio-reactive: C.total [large]", () => { sink = LARGE_VR_OBJ.C.total; });
});

// writes
describe("leaf write → chain invalidation", () => {
  bench("ours [small]", () => { const i = ri(SMALL_OURS.items.length); SMALL_OURS.items[i].price += 1; });
  bench("valtio-reactive [small]", () => { const i = ri(SMALL_VR_SIG.base.items.length); SMALL_VR_SIG.base.items[i].price += 1; });
  bench("ours [large]", () => { const i = ri(LARGE_OURS.items.length); LARGE_OURS.items[i].price += 1; });
  bench("valtio-reactive [large]", () => { const i = ri(LARGE_VR_SIG.base.items.length); LARGE_VR_SIG.base.items[i].price += 1; });
});

// independent primitive
describe("taxRate write", () => {
  bench("ours [small]", () => { SMALL_OURS.taxRate = +(Math.min(0.5, SMALL_OURS.taxRate + 0.0005).toFixed(4)); });
  bench("valtio-reactive [small]", () => { SMALL_VR_SIG.base.taxRate = +(Math.min(0.5, SMALL_VR_SIG.base.taxRate + 0.0005).toFixed(4)); });
  bench("ours [large]", () => { LARGE_OURS.taxRate = +(Math.min(0.5, LARGE_OURS.taxRate + 0.0005).toFixed(4)); });
  bench("valtio-reactive [large]", () => { LARGE_VR_SIG.base.taxRate = +(Math.min(0.5, LARGE_VR_SIG.base.taxRate + 0.0005).toFixed(4)); });
});

// optional: batching showcase
describe("valtio-reactive batch()", () => {
  bench("batch two writes [small]", () => {
    vBatch(() => {
      const i = ri(SMALL_VR_SIG.base.items.length);
      SMALL_VR_SIG.base.items[i].qty += 1;
      SMALL_VR_SIG.base.taxRate = +(Math.min(0.5, SMALL_VR_SIG.base.taxRate + 0.0005).toFixed(4));
    });
    sink = SMALL_VR_SIG.total.value;
  });
});

// FineGrainedDemo.tsx
import { proxy } from "./ripplio";
import { useSnapshot } from "./react";

// ----- Store -----
const state = proxy({
  cart: {
    items: [
      { id: "a", name: "Widget", price: 10, qty: 1 },
      { id: "b", name: "Gadget", price: 20, qty: 2 },
    ],
    
  },
  taxRate: 0.1,
  prefs: { theme: "light" },
  get itemCount() {
    return this.cart.items.length
  },
  get subtotal() {
    return this.cart.items.reduce(
      (s: number, it: { price: number; qty: number }) => s + it.price * it.qty,
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

// ----- Components -----

// Reads only totals (computed chain)
// Re-renders when subtotal/tax/total change.
function TotalsPanel() {
  const snap = useSnapshot(state);
  return (
    <section style={{ border: "1px solid #ddd", padding: 12, borderRadius: 8, marginBottom: 12 }}>
      <h3>Totals</h3>
      <div>Subtotal: {snap.subtotal}</div>
      <div>Tax: {snap.tax}</div>
      <div>Total: {snap.total}</div>
    </section>
  );
}

// Reads only taxRate (independent primitive)
function TaxRateControl() {
  const {taxRate} = useSnapshot(state);
  return (
    <section style={{ border: "1px solid #ddd", padding: 12, borderRadius: 8, marginBottom: 12 }}>
      <h3>Tax Rate</h3>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span>Current: {taxRate}</span>
        <button onClick={() => (state.taxRate = +(Math.min(0.25, taxRate + 0.01)))}>+0.01</button>
        <button onClick={() => (state.taxRate = +(Math.max(0, taxRate - 0.01)))}>-0.01</button>
      </div>
    </section>
  );
}

// Reads only the length (structure-only read)
// Will update when items are added/removed, not when qty/price changes.
function ItemsHeader() {
  const {itemCount} = useSnapshot(state);
  return <h3>Items ({itemCount})</h3>;
}

// Lists rows without reading item contents itself.
// It only depends on length, so won't re-render on per-row qty/price changes.
function ItemsList() {
  const {itemCount: count} = useSnapshot(state);
  return (
    <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
      {Array.from({ length: count }, (_, i) => (
        <ItemRow key={i} index={i} />
      ))}
    </ul>
  );
}

// Each row reads only its own item
// Re-renders when that specific item's price/qty/name changes.
function ItemRow({ index }: { index: number }) {
  const row = useSnapshot(state.cart.items[index]);
  return (
    <li style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: 8, alignItems: "center" }}>
      <span>{row.name}</span>
      <span>Price: {row.price.toFixed(2)}</span>
      <span>Qty: {row.qty}</span>
      <button onClick={() => (state.cart.items[index].qty += 1)}>+1 qty</button>
    </li>
  );
}

// Adds a new item (affects count + totals)
function AddItemButton() {
  return (
    <button
      onClick={() => {
        const id = Math.random()
        state.cart.items.push({ id: `n${id}`, name: `New Item`, price: (Math.random() * 10), qty: 1 });
      }}
    >
      + Add Item
    </button>
  );
}

// Unrelated branch of state
function ThemePanel() {
  const {theme} = useSnapshot(state.prefs);
  return (
    <section style={{ border: "1px solid #ddd", padding: 12, borderRadius: 8, marginBottom: 12 }}>
      <h3>Theme</h3>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span>{theme}</span>
        <button onClick={() => (state.prefs.theme = theme === "light" ? "dark" : "light")}>Toggle Theme</button>
      </div>
    </section>
  );
}

// Demo root
export default function FineGrainedDemo() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 16, display: "grid", gap: 12 }}>
      <TotalsPanel />
      <TaxRateControl />
      <section style={{ border: "1px solid #ddd", padding: 12, borderRadius: 8 }}>
        <ItemsHeader />
        <ItemsList />
        <div style={{ marginTop: 8 }}>
          <AddItemButton />
        </div>
      </section>
      <ThemePanel />
    </div>
  );
}

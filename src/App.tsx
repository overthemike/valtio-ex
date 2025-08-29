import { useSnapshot } from "./valtio-hook";
import { proxy } from './valtio';

const state = proxy({
  items: [{ price: 10 }, { price: 20 }],
  taxRate: 0.1,

  get subtotal() {
    return this.items.reduce((sum: number, item: { price: number }) => sum + item.price, 0);
  },

  get tax() {
    return this.subtotal * this.taxRate; // depends on computed
  },

  get total() {
    return this.subtotal + this.tax; // nested computed
  },
});

export function Cart() {
  const snap = useSnapshot(state);
  return (
    <div>
      <div>Subtotal: {snap.subtotal}</div>
      <div>Tax: {snap.tax.toFixed(2)}</div>
      <div>Total: {snap.total}</div>
      <button onClick={() => { state.items[0].price = state.items[0].price + 1; }}>
        +$1 first item
      </button>
    </div>
  );
}

const counter = proxy({
  count: 0,
  get doubled() {
    return this.count * 2;
  },
});

export function Counter() {
  const snap = useSnapshot(counter);
  return (
    <div>
      <p>Count: {snap.count}</p>
      <p>Doubled: {snap.doubled}</p>
      <button onClick={() => (counter.count += 1)}>+1</button>
    </div>
  );
}

const todos = proxy({
  list: [] as { text: string; done: boolean }[],
  get completed() {
    return this.list.filter((t) => t.done);
  },
  get remaining() {
    return this.list.filter((t) => !t.done);
  },
});

export function TodoApp() {
  const snap = useSnapshot(todos);
  return (
    <div>
      <button
        onClick={() =>
          todos.list.push({ text: `Task ${todos.list.length + 1}`, done: false })
        }
      >
        Add Task
      </button>
      <ul>
        {snap.list.map((t, i) => (
          <li key={i}>
            <label>
              <input
                type="checkbox"
                checked={t.done}
                onChange={(e) => (todos.list[i].done = e.target.checked)}
              />
              {t.text}
            </label>
          </li>
        ))}
      </ul>
      <p>
        Completed: {snap.completed.length}, Remaining: {snap.remaining.length}
      </p>
    </div>
  );
}

const user = proxy({
  profile: {
    first: "Ada",
    last: "Lovelace",
  },
  get fullName() {
    return `${this.profile.first} ${this.profile.last}`;
  },
});

export function UserProfile() {
  const snap = useSnapshot(user);
  return (
    <div>
      <p>Name: {snap.fullName}</p>
      <button onClick={() => (user.profile.first = "Grace")}>Change First</button>
      <button onClick={() => (user.profile.last = "Hopper")}>Change Last</button>
    </div>
  );
}

const item = proxy({
  prefs: {
    theme: 'dark'
  },
  user: {
    name: "Michael"
  }
})

const ReplaceObjectRefEx = () => {
  const { name } = useSnapshot(item.user)

  return (
    <div>
      Hello {name}
      <button onClick={() => item.user = { name: 'Daishi'}}>Change name</button>
    </div>
  )
}


const App = () => {
  return (
    <div>
      <Cart />
      <Counter />
      <TodoApp />
      <UserProfile />
      <ReplaceObjectRefEx />
    </div>
  )
}

export default App
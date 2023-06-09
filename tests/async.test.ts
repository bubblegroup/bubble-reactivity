import { createEffect, flushSync } from "../src";
import { Computation } from "../src/core";
import { Effect } from "../src/effect";

it("should propagate loading state when calling read", async () => {
  let resolve: (value: unknown) => void;
  const comp = new Computation(new Promise((r) => (resolve = r)), null);
  const chain = new Computation(undefined, () => comp.read());

  expect(chain.read()).toBeUndefined();
  expect(comp.loading()).toBe(true);
  expect(chain.loading()).toBe(true);
  resolve!(1);
  await Promise.resolve();
  expect(comp.loading()).toBe(false);
  expect(chain.read()).toBe(1);
  expect(chain.loading()).toBe(false);
});

it("should handle two async sources", async () => {
  let resolve1: (value: number) => void;
  let resolve2: (value: number) => void;
  const comp1 = new Computation(
    new Promise<number>((r) => (resolve1 = r)),
    null
  );
  const comp2 = new Computation(
    new Promise<number>((r) => (resolve2 = r)),
    null
  );
  const chain = new Computation(undefined, () => {
    const c1 = comp1.read();
    const c2 = comp2.read();
    if (c1 && c2) return c1 + c2;
  });

  expect(chain.read()).toBeUndefined();
  expect(comp1.loading()).toBe(true);
  expect(comp2.loading()).toBe(true);
  resolve1!(1);
  await Promise.resolve();
  expect(comp1.loading()).toBe(false);
  expect(comp2.loading()).toBe(true);
  expect(chain.read()).toBeUndefined();
  resolve2!(2);
  await Promise.resolve();
  expect(comp2.loading()).toBe(false);
  expect(chain.read()).toBe(3);
});

it("should handle async memos", async () => {
  let resolve1: (value: number) => void;
  const comp = new Computation<number | undefined>(undefined, () => {
    return new Promise<number>((r) => (resolve1 = r));
  });
  const chain = new Computation(undefined, () => {
    const c2 = comp.read();
    if (c2) return c2 + 1;
  });

  expect(chain.read()).toBeUndefined();
  expect(comp.loading()).toBe(true);
  expect(chain.loading()).toBe(true);
  resolve1!(1);
  await Promise.resolve();
  expect(chain.read()).toBe(2);
  expect(comp.loading()).toBe(false);
  expect(chain.loading()).toBe(false);
});

it("should handle async memos chaining", async () => {
  let resolve1: (value: number) => void;
  let resolve2: (value: number) => void;
  const comp1 = new Computation(undefined, () => {
    return new Promise<number>((r) => (resolve1 = r));
  });
  const comp2 = new Computation<number | undefined>(undefined, () => {
    comp1.read();
    return new Promise<number>((r) => (resolve2 = r));
  });

  comp2.read();
  expect(comp2.loading()).toBe(true);
  expect(comp1.loading()).toBe(true);
  resolve2!(1);
  await Promise.resolve();
  expect(comp2.read()).toBe(1);
  expect(comp2.loading()).toBe(true);
  expect(comp1.loading()).toBe(true);
  resolve1!(2);
  await Promise.resolve();
  expect(comp2.read()).toBe(1);
  expect(comp1.loading()).toBe(false);
  expect(comp2.loading()).toBe(true);
});

it("should handle effects watching async memo state", async () => {
  let resolve1: (value: number) => void;
  const comp1 = new Computation<number | undefined>(undefined, () => {
    return new Promise<number>((r) => (resolve1 = r));
  });

  const effect = vi.fn(() => comp1.loading());
  createEffect(effect);

  comp1.read();
  flushSync();
  expect(effect).toBeCalledTimes(1);
  resolve1!(1);
  await Promise.resolve();
  flushSync();
  expect(effect).toBeCalledTimes(2);
});

it("should not rerun observers of async memos that load to same value", async () => {
  let resolve1: (value: number) => void;
  const comp = new Computation<number | undefined>(1, () => {
    return new Promise<number>((r) => (resolve1 = r));
  });
  const child = vi.fn(() => comp.read());
  const comp2 = new Computation(undefined, child);

  comp2.read();
  resolve1!(1);
  await Promise.resolve();
  comp2.read();
  expect(child).toBeCalledTimes(1);
});

it("should handle .wait() on async memos", async () => {
  let resolve1: (value: number) => void;
  const comp = new Computation<number>(undefined, () => {
    return new Promise<number>((r) => (resolve1 = r));
  });
  const before = vi.fn();
  const compute = vi.fn();
  const chain = new Computation(undefined, () => {
    before();
    const c2 = comp.wait();
    compute();
    return c2 + 1;
  });
  chain.read();
  expect(compute).toBeCalledTimes(0);
  resolve1!(1);
  chain.read();
  await Promise.resolve();
  chain.read();
  expect(compute).toBeCalledTimes(1);
  expect(before).toBeCalledTimes(2);
});

it("should handle async propagation to an effect resetting when value changes", () => {
  const promiseFactory = vi.fn(() => {
    return new Promise(() => {
      // never resolves
    });
  });
  const s = new Computation(1, null);
  const m = new Computation(undefined, () => {
    if (s.read() === 1) return promiseFactory();
    else return 2;
  });
  let loading = false;
  new Effect(undefined, () => {
    loading = m.loading();
  });
  flushSync();
  expect(loading).toBe(true);
  s.write(2);
  flushSync();
  expect(loading).toBe(false);
});

it("should handle async propagation to an effect completing", async () => {
  let resolve1: (value: number) => void;
  const s = new Computation(1, null);
  const m = new Computation(undefined, () => {
    if (s.read() === 1) return new Promise<number>((r) => (resolve1 = r));
    else return 2;
  });
  let loading = false;
  new Effect(undefined, () => {
    loading = m.loading();
  });
  flushSync();
  expect(loading).toBe(true);
  resolve1!(1);
  await Promise.resolve();
  flushSync();
  expect(loading).toBe(false);
});

it("should mark downstream async memos as loading on returning a promise", () => {
  const unresolvedPromise = new Promise<number>(() => {
    // never resolves
  });
  const s = new Computation(false, null);
  const m = new Computation(undefined, () => {
    if (s.read()) return unresolvedPromise;
    else return 2;
  });
  const m2 = new Computation(undefined, () => m.read());
  expect(m.loading()).toBe(false);
  expect(m2.loading()).toBe(false);
  s.write(true);
  expect(m2.loading()).toBe(true);
});

it("should throw when a promise rejects", async () => {
  let reject1: () => void;
  const rejectedPromise = new Promise<number>((_, reject) => {
    reject1 = () => reject(new Error("test"));
  });
  const m = new Computation(rejectedPromise, null);
  m.read();
  reject1!();
  await Promise.resolve();
  expect(() => m.read()).toThrow("test");
});

it("should throw when a computation promise rejects", async () => {
  let reject1: () => void;
  const rejectedPromise = new Promise<number>((_, reject) => {
    reject1 = () => reject(new Error("test"));
  });
  const m = new Computation(undefined, () => rejectedPromise);
  m.read();
  reject1!();
  await Promise.resolve();
  expect(() => m.read()).toThrow("test");
});

it("should not be marked as clean if stale promise is resolved", async () => {
  let resolve1: (value: number) => void;
  const promise1 = new Promise<number>((r) => (resolve1 = r));
  const promise2 = new Promise<number>(() => {
    // never resolves
  });
  const switcher = new Computation(true, null);
  const comp1 = new Computation(undefined, () => {
    if (switcher.read()) return promise1;
    else return promise2;
  });
  const waiting = vi.fn(() => comp1.read());
  const comp2 = new Computation(undefined, waiting);
  expect(comp2.loading()).toBe(true);
  expect(waiting).toBeCalledTimes(1);
  switcher.write(false);
  expect(comp2.loading()).toBe(true);
  resolve1!(1);
  await Promise.resolve();
  expect(comp2.loading()).toBe(true);
});

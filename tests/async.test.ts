import { createEffect } from "../src";
import { Computation, Effect, flushSync } from "../src/core";

it("should propagate loading when calling read", async () => {
  let resolve: (value: unknown) => void;
  const comp = new Computation(new Promise((r) => (resolve = r)), null);
  const chain = new Computation(undefined, () => comp.read());
  expect(chain.read()).toBeUndefined();
  expect(comp.state()._value).toBe(1);
  expect(chain.state().read()).toBe(true);
  resolve!(1);
  await Promise.resolve();
  expect(comp.state().read()).toBe(false);
  expect(chain.read()).toBe(1);
  expect(chain.state().read()).toBe(false);
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
    let c1 = comp1.read();
    let c2 = comp2.read();
    if (c1 && c2) return c1 + c2;
  });
  expect(chain.read()).toBeUndefined();
  expect(comp1.state().read()).toBe(true);
  expect(comp2.state().read()).toBe(true);
  resolve1!(1);
  await Promise.resolve();
  expect(comp1.state().read()).toBe(false);
  expect(comp2.state().read()).toBe(true);
  expect(chain.read()).toBeUndefined();
  resolve2!(2);
  await Promise.resolve();
  expect(comp2.state().read()).toBe(false);
  expect(chain.read()).toBe(3);
});

it("should handle async memos", async () => {
  let resolve1: (value: number) => void;
  const comp2 = new Computation<number | undefined>(undefined, () => {
    return new Promise<number>((r) => (resolve1 = r));
  });
  const chain = new Computation(undefined, () => {
    const c2 = comp2.read();
    if (c2) return c2 + 1;
  });
  expect(chain.read()).toBeUndefined();
  expect(comp2.state().read()).toBe(true);
  expect(chain.state().read()).toBe(true);
  resolve1!(1);
  await Promise.resolve();
  expect(chain.read()).toBe(2);
  expect(comp2.state().read()).toBe(false);
  expect(chain.state().read()).toBe(false);
});

it("should handle async memos chaining", async () => {
  let resolve1: (value: number) => void;
  let resolve2: (value: number) => void;
  const comp1 = new Computation(undefined, () => {
    return new Promise<number>((r) => (resolve1 = r));
  });
  const comp2 = new Computation<number | undefined>(undefined, () => {
    const c1 = comp1.read();
    return new Promise<number>((r) => (resolve2 = r));
  });
  comp2.read();
  expect(comp2.state().read()).toBe(true);
  expect(comp1.state().read()).toBe(true);
  resolve2!(1);
  await Promise.resolve();
  expect(comp2.read()).toBe(1);
  expect(comp2.state().read()).toBe(true);
  expect(comp1.state().read()).toBe(true);
  resolve1!(2);
  await Promise.resolve();
  expect(comp2.read()).toBe(1);
  expect(comp1.state().read()).toBe(false);
  expect(comp2.state().read()).toBe(true);
});

it("should handle effects watching async memo state", async () => {
  let resolve1: (value: number) => void;
  const comp1 = new Computation<number | undefined>(undefined, () => {
    return new Promise<number>((r) => (resolve1 = r));
  });
  let executions = 0;
  createEffect(() => {
    executions++;
    comp1.state().read();
  });
  comp1.read();
  flushSync();
  expect(executions).toBe(1);
  resolve1!(1);
  await Promise.resolve();
  flushSync();
  expect(executions).toBe(2);
});

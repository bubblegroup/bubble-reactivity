import { Computation } from "../src/core";

it("should propagate loading when calling wait", async () => {
  let resolve: (value: unknown) => void;
  const comp = new Computation(new Promise((r) => (resolve = r)), null);
  const chain = new Computation(undefined, () => comp.wait());
  expect(chain.read()).toBeUndefined();
  expect(comp._lstate).toBe(true);
  expect(chain._lstate).toBe(true);
  resolve!(1);
  await Promise.resolve();
  expect(comp._lstate).toBe(false);
  expect(chain.read()).toBe(1);
  expect(chain._lstate).toBe(false);
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
    let c1 = comp1.wait();
    let c2 = comp2.wait();
    if (c1 && c2) return c1 + c2;
  });
  expect(chain.read()).toBeUndefined();
  expect(comp1._lstate).toBe(true);
  expect(comp2._lstate).toBe(true);
  resolve1!(1);
  await Promise.resolve();
  expect(comp1._lstate).toBe(false);
  expect(comp2._lstate).toBe(true);
  expect(chain.read()).toBeUndefined();
  resolve2!(2);
  await Promise.resolve();
  expect(comp2._lstate).toBe(false);
  expect(chain.read()).toBe(3);
});

it("should handle async memos", async () => {
  let resolve1: (value: number) => void;
  let resolve2: (value: number) => void;
  const comp1 = new Computation(new Promise((r) => (resolve1 = r)), null);
  const comp2 = new Computation<number | undefined>(undefined, () => {
    const c1 = comp1.wait();
    if (c1) {
      return new Promise<number>((r) => (resolve2 = r));
    }
  });
  const chain = new Computation(undefined, () => {
    const c2 = comp2.wait();
    if (c2) return c2 + 1;
  });
  expect(chain.read()).toBeUndefined();
  expect(comp1._lstate).toBe(true);
  expect(comp2._lstate).toBe(true);
  resolve1!(1);
  await Promise.resolve();
  expect(comp1._lstate).toBe(false);
  expect(comp2._lstate).toBe(true);
  expect(chain.read()).toBeUndefined();
  resolve2!(2);
  await Promise.resolve();
  expect(comp2._lstate).toBe(false);
  expect(chain.read()).toBe(3);
});

it("should handle async memos with state objects", async () => {
  let resolve1: (value: number) => void;
  let resolve2: (value: number) => void;
  const comp1 = new Computation(
    new Promise<number>((r) => (resolve1 = r)),
    null
  );
  const comp2 = new Computation<number | undefined>(undefined, () => {
    const c1 = comp1.wait();
    if (c1) {
      return new Promise<number>((r) => (resolve2 = r));
    }
  });
  const chain = new Computation(undefined, () => {
    const c2 = comp2.wait();
    if (c2) return c2 + 1;
  });
  comp1.state();
  comp2.state();
  expect(chain.read()).toBeUndefined();
  expect(comp2.state().read()).toBe(true);
  expect(comp1.state().read()).toBe(true);
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

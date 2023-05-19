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

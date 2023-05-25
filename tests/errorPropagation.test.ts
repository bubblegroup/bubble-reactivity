import { Computation } from "../src/core";

it("should propagate errors through memos", () => {
  const m = new Computation(undefined, () => {
    throw new Error("test");
  });
  const c = new Computation(undefined, () => {
    return m.read();
  });
  expect(() => c.read()).toThrowError("test");
});

it("should recover from errors", () => {
  const errorThrower = vi.fn(() => {
    throw new Error("test");
  });
  const s = new Computation(1, null);
  const m = new Computation(undefined, () => {
    if (s.read() === 1) errorThrower();
    else return 2;
  });
  const c = new Computation(undefined, () => {
    return m.read();
  });
  expect(() => c.read()).toThrowError("test");
  s.write(2);
  expect(() => c.read()).not.toThrow();
});

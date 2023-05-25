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

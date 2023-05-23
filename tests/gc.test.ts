/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  Accessor,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  flushSync,
  getOwner,
} from "../src";
import { Owner } from "../src/owner";

function gc() {
  return new Promise((resolve) =>
    setTimeout(() => {
      flushSync(); // flush call stack (holds a reference)
      global.gc!();
      resolve(void 0);
    }, 0)
  );
}

if (global.gc) {
  it("should gc computed if there are no observers", async () => {
    const [$x] = createSignal(0);
    const ref = new WeakRef(createMemo(() => $x()));

    await gc();
    expect(ref.deref()).toBeUndefined();
  });

  it("should _not_ gc computed if there are observers", async () => {
    const [$x] = createSignal(0);
    let pointer;

    const ref = new WeakRef((pointer = createMemo(() => $x())));

    ref.deref()!();

    await gc();
    expect(ref.deref()).toBeDefined();

    pointer = undefined;
    await gc();
    expect(ref.deref()).toBeUndefined();
  });

  it("should gc root if disposed", async () => {
    const [$x] = createSignal(0);
    let ref!: WeakRef<Accessor<void>>;
    let pointer;

    const dispose = createRoot((dispose) => {
      ref = new WeakRef(
        (pointer = createMemo(() => {
          $x();
        }))
      );

      return dispose;
    });

    await gc();
    expect(ref.deref()).toBeDefined();

    dispose();
    await gc();
    expect(ref.deref()).toBeDefined();

    pointer = undefined;
    await gc();
    expect(ref.deref()).toBeUndefined();
  });

  it("should gc effect lazily", async () => {
    const [$x, setX] = createSignal(0);
    let ref!: WeakRef<Owner>;

    const dispose = createRoot((dispose) => {
      createEffect(() => {
        $x();
        ref = new WeakRef(getOwner()!);
      });

      return dispose;
    });

    await gc();
    expect(ref.deref()).toBeDefined();

    dispose();
    setX(1);

    await gc();
    expect(ref.deref()).toBeUndefined();
  });
} else {
  // Ignored when there is no access to global.gc
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  it("", () => {});
}

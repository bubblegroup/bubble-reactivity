import {
  createEffect,
  createMemo,
  createSignal,
  flushSync,
  onCleanup,
} from "../src";
import { createRoot, untrack } from "../src/core";

afterEach(() => flushSync());

it("should run effect", () => {
  const [$x, setX] = createSignal(0),
    effect = vi.fn(() => void $x());

  createEffect(effect);
  expect(effect).toHaveBeenCalledTimes(1);

  setX(1);
  flushSync();
  expect(effect).toHaveBeenCalledTimes(2);
});

it("should run effect on change", () => {
  const effect = vi.fn();

  const [$x, setX] = createSignal(10);
  const [$y, setY] = createSignal(10);

  const $a = createMemo(() => $x() + $y());
  const $b = createMemo(() => $a());

  createEffect(() => effect($b()));

  expect(effect).to.toHaveBeenCalledTimes(1);

  setX(20);
  flushSync();
  expect(effect).to.toHaveBeenCalledTimes(2);

  setY(20);
  flushSync();
  expect(effect).to.toHaveBeenCalledTimes(3);

  setX(20);
  setY(20);
  flushSync();
  expect(effect).to.toHaveBeenCalledTimes(3);
});

it("should handle nested effect", () => {
  const [$x, setX] = createSignal(0);
  const [$y, setY] = createSignal(0);

  const outerEffect = vi.fn();
  const innerEffect = vi.fn();
  const innerDispose = vi.fn();

  const stopEffect = createRoot((dispose) => {
    createEffect(() => {
      $x();
      outerEffect();
      createEffect(() => {
        $y();
        innerEffect();
        onCleanup(innerDispose);
      });
    });

    return dispose;
  });

  expect(outerEffect).toHaveBeenCalledTimes(1);
  expect(innerEffect).toHaveBeenCalledTimes(1);
  expect(innerDispose).toHaveBeenCalledTimes(0);

  setY(1);
  flushSync();
  expect(outerEffect).toHaveBeenCalledTimes(1);
  expect(innerEffect).toHaveBeenCalledTimes(2);
  expect(innerDispose).toHaveBeenCalledTimes(1);

  setY(2);
  flushSync();
  expect(outerEffect).toHaveBeenCalledTimes(1);
  expect(innerEffect).toHaveBeenCalledTimes(3);
  expect(innerDispose).toHaveBeenCalledTimes(2);

  innerEffect.mockReset();
  innerDispose.mockReset();

  setX(1);
  flushSync();
  expect(outerEffect).toHaveBeenCalledTimes(2);
  expect(innerEffect).toHaveBeenCalledTimes(1); // new one is created
  expect(innerDispose).toHaveBeenCalledTimes(1);

  setY(3);
  flushSync();
  expect(outerEffect).toHaveBeenCalledTimes(2);
  expect(innerEffect).toHaveBeenCalledTimes(2);
  expect(innerDispose).toHaveBeenCalledTimes(2);

  stopEffect();
  setX(10);
  setY(10);
  expect(outerEffect).toHaveBeenCalledTimes(2);
  expect(innerEffect).toHaveBeenCalledTimes(2);
  expect(innerDispose).toHaveBeenCalledTimes(3);
});

it("should stop effect", () => {
  const effect = vi.fn();

  const [$x, setX] = createSignal(10);

  const stopEffect = createRoot((dispose) => {
    createEffect(() => effect($x()));
    return dispose;
  });

  stopEffect();

  setX(20);
  flushSync();
  expect(effect).toHaveBeenCalledTimes(1);
});

it("should run all disposals before each new run", () => {
  const effect = vi.fn();
  const disposeA = vi.fn();
  const disposeB = vi.fn();

  function fnA() {
    onCleanup(disposeA);
  }

  function fnB() {
    onCleanup(disposeB);
  }

  const [$x, setX] = createSignal(0);

  createEffect(() => {
    effect();
    fnA(), fnB(), $x();
  });

  expect(effect).toHaveBeenCalledTimes(1);
  expect(disposeA).toHaveBeenCalledTimes(0);
  expect(disposeB).toHaveBeenCalledTimes(0);

  for (let i = 1; i <= 3; i += 1) {
    setX(i);
    flushSync();
    expect(effect).toHaveBeenCalledTimes(i + 1);
    expect(disposeA).toHaveBeenCalledTimes(i);
    expect(disposeB).toHaveBeenCalledTimes(i);
  }
});

it("should dispose of nested effect", () => {
  const [$x, setX] = createSignal(0);
  const innerEffect = vi.fn();

  const stopEffect = createRoot((dispose) => {
    createEffect(() => {
      createEffect(() => {
        innerEffect($x());
      });
    });

    return dispose;
  });

  stopEffect();

  setX(10);
  flushSync();
  expect(innerEffect).toHaveBeenCalledTimes(1);
  expect(innerEffect).not.toHaveBeenCalledWith(10);
});

it("should conditionally observe", () => {
  const [$x, setX] = createSignal(0);
  const [$y, setY] = createSignal(0);
  const [$condition, setCondition] = createSignal(true);

  const $a = createMemo(() => ($condition() ? $x() : $y()));
  const effect = vi.fn();

  createEffect(() => effect($a()));

  expect(effect).toHaveBeenCalledTimes(1);

  setY(1);
  flushSync();
  expect(effect).toHaveBeenCalledTimes(1);

  setX(1);
  flushSync();
  expect(effect).toHaveBeenCalledTimes(2);

  setCondition(false);
  flushSync();
  expect(effect).toHaveBeenCalledTimes(2);

  setY(2);
  flushSync();
  expect(effect).toHaveBeenCalledTimes(3);

  setX(3);
  flushSync();
  expect(effect).toHaveBeenCalledTimes(3);
});

it("should dispose of nested conditional effect", () => {
  const [$condition, setCondition] = createSignal(true);

  const disposeA = vi.fn();
  const disposeB = vi.fn();

  function fnA() {
    createEffect(() => {
      onCleanup(disposeA);
    });
  }

  function fnB() {
    createEffect(() => {
      onCleanup(disposeB);
    });
  }

  createEffect(() => ($condition() ? fnA() : fnB()));

  setCondition(false);
  flushSync();
  expect(disposeA).toHaveBeenCalledTimes(1);
});

// https://github.com/preactjs/signals/issues/152
it("should handle looped effects", () => {
  let values: number[] = [],
    loop = 2;

  const [$value, setValue] = createSignal(0);

  let x = 0;
  createEffect(() => {
    x++;
    values.push($value());
    for (let i = 0; i < loop; i++) {
      createEffect(() => {
        values.push($value() + i);
      });
    }
  });

  flushSync();

  expect(values).toHaveLength(3);
  expect(values.join(",")).toBe("0,0,1");

  loop = 1;
  values = [];
  setValue(1);
  flushSync();

  expect(values).toHaveLength(2);
  expect(values.join(",")).toBe("1,1");

  values = [];
  setValue(2);
  flushSync();

  expect(values).toHaveLength(2);
  expect(values.join(",")).toBe("2,2");
});

it("should apply changes in effect in same flush", async () => {
  const [$x, setX] = createSignal(0),
    [$y, setY] = createSignal(0);

  const $a = createMemo(() => {
      return $x() + 1;
    }),
    $b = createMemo(() => {
      return $a() + 2;
    });

  createEffect(() => {
    setX(untrack(() => $x()) + 1);
    $y();
  });

  expect($x()).toBe(1);
  expect($b()).toBe(4);
  expect($a()).toBe(2);

  setY(1);

  await Promise.resolve();

  expect($x()).toBe(2);
  expect($b()).toBe(5);
  expect($a()).toBe(3);

  setY(2);

  await Promise.resolve();

  expect($x()).toBe(3);
  expect($b()).toBe(6);
  expect($a()).toBe(4);
});

it("should run parent effect before child effect", () => {
  const [$x, setX] = createSignal(0);
  const $condition = createMemo(() => $x());

  let calls = 0;

  createEffect(() => {
    createEffect(() => {
      $x();
      calls++;
    });

    $condition();
  });

  setX(1);
  flushSync();
  expect(calls).toBe(2);
});

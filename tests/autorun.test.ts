/* eslint-disable */

import { flushSync } from "../src";
import {
  Autorun,
  Box,
  Switch,
  Watcher,
  autorun,
  autorun_top,
} from "../src/Autorun";

function pretty_count(times: number) {
  if (times === 1) {
    return "once";
  } else {
    return `${times} times`;
  }
}

/**
 * Wrapper class around an AutoRun that lets you spy on how many times its various
 * lifecycle callbacks have been run.
 */
class AutorunSpy {
  counts = {
    do: 0,
    while: 0,
    finally: 0,
  };
  name: string;
  autorun: Autorun;

  constructor(
    name: string,
    fn_or_options:
      | (() => void)
      | { do: () => void; while?: () => boolean; finally?: () => void }
  ) {
    this.name = name;

    const options =
      typeof fn_or_options === "object"
        ? fn_or_options
        : { do: fn_or_options, while: undefined, finally: undefined };

    // Wraps a function with a counter only if the function is present.
    const wrap = <T>(
      name: "do" | "while" | "finally",
      fn: () => T
    ): (() => T) => {
      return () => {
        this.counts[name]++;
        return fn();
      };
    };

    const wrapped = {
      do: wrap("do", options.do),
      while: options.while && wrap("while", options.while),
      finally: options.finally && wrap("finally", options.finally),
    };

    this.autorun = autorun(wrapped);
  }

  reset_counts() {
    this.counts = {
      do: 0,
      while: 0,
      finally: 0,
    };
  }

  invalidate() {
    this.autorun.invalidate();
  }

  destroy() {
    this.autorun.destroy();
  }

  pause() {
    this.autorun.pause();
  }

  unpause() {
    this.autorun.unpause();
  }

  // Assertions you can make about spied-on behavior

  assert_ran(times = 1) {
    const expected = pretty_count(times);
    const actual = pretty_count(this.counts.do);
    assert(
      this.counts.do === times,
      `Expected autorun '${this.name}' to run ${expected} but it ran ${actual}`
    );
  }

  assert_checked_condition(times = 1) {
    const expected = pretty_count(times);
    const actual = pretty_count(this.counts.while);
    assert(
      this.counts.while === times,
      `Expected condition of '${this.name}' to run ${expected} but it ran ${actual}`
    );
  }

  assert_finalized() {
    const times = pretty_count(this.counts.finally);
    assert(
      this.counts.finally === 1,
      `Expected finalizer of '${this.name}' to run once, but it ran ${times}`
    );
  }

  assert_not_finalized() {
    const times = pretty_count(this.counts.finally);
    assert(
      this.counts.finally === 0,
      `Expected finalizer of '${this.name}' not to run, but it ran ${times}`
    );
  }

  assert_alive() {
    assert(
      !this.autorun._is_destroyed,
      `Expected autorun '${this.name}' to be alive, but it was destroyed.`
    );
  }

  assert_destroyed() {
    assert(
      this.autorun._is_destroyed,
      `Expected autorun '${this.name}' to be destroyed, but it was alive.`
    );
  }
}

/**
 * Wrapper in the style of `u.autorun`.
 */
function autorun_spy(
  name: string | undefined,
  fn_or_options:
    | (() => void)
    | { do: () => void; while?: () => boolean; finally?: () => void }
) {
  if (!name) {
    name = "<anonymous>";
  }
  return new AutorunSpy(name, fn_or_options);
}

/**
 * Helper for resetting any number of spies/arrays of spies at once.
 */
function reset_counts(...spies: (AutorunSpy | AutorunSpy[])[]) {
  spies.forEach((spy) => {
    if (spy instanceof AutorunSpy) {
      spy.reset_counts();
    } else if (Array.isArray(spy)) {
      reset_counts(...spy);
    } else {
      throw new Error("non-spy passed to reset_counts");
    }
  });
}

/**
 * Wait for all scheduled autoruns to finish, by pausing the fiber
 */
afterEach(() => flushSync());

it("basic_autorun", () => {
  const A = autorun_spy("A", () => {});

  // Runs immediately, both on creation and invalidation (the second because
  // we're on the server in these tests).
  A.assert_ran(1);
  A.invalidate();
  A.assert_ran(2);
});

it("nested_autorun", () => {
  const B: AutorunSpy[] = [];
  const A = autorun_spy("A", () => {
    B.push(
      autorun_spy(`B[${B.length}]`, {
        do: () => {},
        finally: () => {},
      })
    );
  });

  A.assert_ran(1);
  assert.equal(1, B.length);
  B[0].assert_ran(1);

  // Invalidate B, without rerunning A
  reset_counts(A, B);
  B[0].invalidate();
  A.assert_ran(0);
  B[0].assert_ran(1);

  // Invalidate A, destroying B[0] and creating B[1]
  reset_counts(A, B);
  A.invalidate();
  A.assert_ran(1);
  B[0].assert_ran(0);
  B[0].assert_finalized();
  B[0].assert_destroyed();
  B[1].assert_ran(1);
});

it("pause_manual", () => {
  const A = autorun_spy("A", { do() {}, finally() {} });

  A.pause();

  // Should not run while paused
  A.invalidate();
  A.invalidate();
  A.assert_ran(1);

  // Should run once when unpaused, even though invalidated twice
  reset_counts(A);
  A.unpause();
  A.assert_ran(1);

  // Unpause should be idempotent
  reset_counts(A);
  A.unpause();
  A.assert_ran(0);

  // If not invalidated, shouldn't re-run when unpaused.
  reset_counts(A);
  A.pause();
  A.unpause();
  A.assert_ran(0);

  // Autorun should still be finalized if destroyed while paused
  reset_counts(A);
  A.pause();
  A.destroy();
  A.assert_finalized();
});

it("pause_condition", () => {
  const active = new Box<any>(true);

  const A = autorun_spy("A", {
    do: () => {},
    while: () => active.get(),
  });

  A.assert_ran(1);
  A.assert_checked_condition(1);

  // Condition doesn't get re-checked on invalidate
  reset_counts(A);
  A.invalidate();
  A.assert_ran(1);
  A.assert_checked_condition(0);

  // Autorun doesn't get re-run if condition is re-run. (We set the box to
  // something truthy to invalidate without making it pause and unpause.)
  reset_counts(A);
  active.set("truthy string");
  A.assert_ran(0);
  A.assert_checked_condition(1);

  // Changing the condition to false should actually pause it
  reset_counts(A);
  active.set(false);
  A.invalidate();
  A.assert_ran(0);

  // Changing the condition back should wake it up
  reset_counts(A);
  active.set(true);
  A.assert_ran(1);
});

it("pause_parent", () => {
  const active_outer = new Box(true);
  const active_inner = new Box(true);

  const B: AutorunSpy[] = [];
  const A = autorun_spy("A", {
    while: () => active_outer.get(),
    do: () => {
      const inner = autorun_spy(`B[${B.length}]`, {
        while: () => active_inner.get(),
        do: () => {},
      });
      B.push(inner);
    },
  });

  // Inner is paused when its parent is paused
  reset_counts(A, B);
  active_outer.set(false);
  B[0].invalidate();
  B[0].assert_ran(0);

  // Unpausing the parent lets the invalidated child run
  reset_counts(A, B);
  active_outer.set(true);
  B[0].assert_ran(1);

  // Pausing both then unpausing just the child leave it paused
  reset_counts(A, B);
  active_outer.set(false);
  active_inner.set(false);
  active_inner.set(true);
  B[0].invalidate();
  B[0].assert_ran(0);
  // ... but then unpausing the parent runs it
  active_outer.set(true);
  B[0].assert_ran(1);

  // Pausing both then unpausing just the parent leave it paused
  reset_counts(A, B);
  active_inner.set(false);
  active_outer.set(false);
  active_outer.set(true);
  B[0].invalidate();
  B[0].assert_ran(0);
  // ... but then unpausing the child runs it
  active_inner.set(true);
  B[0].assert_ran(1);

  // Inner autorun's condition is destroyed along with it
  reset_counts(A, B);
  A.invalidate();
  B[0].assert_destroyed();
  active_inner.set(false);
  B[0].assert_checked_condition(0);
});

it("initially_paused", () => {
  const active = new Box(false);

  const A = autorun_spy("A", {
    do: () => {},
    while: () => active.get(),
  });

  A.assert_ran(0);
  active.set(true);
  A.assert_ran(1);

  A.reset_counts();
  active.set(false);
  active.set(true);
  A.assert_ran(0);
});

// Makes sure that a watcher inside an autorun, which throws not_ready the
// first time around, will cause the autorun to successfully re-run once and
// only once when its dependency is changed
it("not_ready_only_runs_once_on_ready", () => {
  const switch1 = new Switch("my test Switch 1");
  const watcher = new Watcher({
    fn: () => {
      return switch1.promise();
    },
  });
  const A = autorun_spy("A", {
    do: () => {
      watcher.get();
    },
  });
  A.assert_ran(1);
  switch1.turn_on();
  A.assert_ran(2);
});

it("autorun_top_nested", () => {
  const inner_ars: AutorunSpy[] = [];
  const A = autorun_spy("A", {
    do: () => {
      autorun_top(() => {
        inner_ars.push(
          autorun_spy("B" + inner_ars.length, {
            do: () => {},
          })
        );
      });
    },
  });

  A.assert_ran(1);
  assert.equal(1, inner_ars.length);
  inner_ars[0].assert_alive();
  inner_ars[0].assert_ran(1);

  A.invalidate();
  A.assert_ran(2);
  assert.equal(2, inner_ars.length);
  inner_ars[0].assert_alive();
  inner_ars[0].assert_ran(1);
  inner_ars[1].assert_alive();
  inner_ars[1].assert_ran(1);

  A.invalidate();
  A.assert_ran(3);
  assert.equal(3, inner_ars.length);
  inner_ars[0].assert_alive();
  inner_ars[0].assert_ran(1);
  inner_ars[1].assert_alive();
  inner_ars[1].assert_ran(1);
  inner_ars[2].assert_alive();
  inner_ars[2].assert_ran(1);
});

// TODO: add more tests
// - what happens when child and parent are both triggered at the same time

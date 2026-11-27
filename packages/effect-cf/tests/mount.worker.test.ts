import { env } from "cloudflare:workers";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";

import { DurableObject } from "../src/index";
import * as PoolWorkers from "../src/Vitest";

it.effect("mount: runs initialize once before the first method under an already-gated host", () => {
  const stub = env.TEST_COUNTER_DO!.getByName(`mount-init-${crypto.randomUUID()}`);

  return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
    Effect.gen(function* () {
      let initializeCount = 0;
      let pingSawInitialized = false;

      const build = DurableObject.mount(Layer.empty, {
        slot: { _tag: "Exclusive" },
        initialize: Effect.sync(() => {
          initializeCount++;
        }),
        rpc: {
          ping: () =>
            Effect.sync(() => {
              pingSawInitialized = initializeCount === 1;

              return "pong";
            }),
        },
      });

      const record = yield* build({ state: state.raw, env });
      const pong = yield* record.ping();

      assert.strictEqual(pong, "pong");
      assert.strictEqual(initializeCount, 1);
      assert.isTrue(pingSawInitialized);
    }).pipe(Effect.provide(PoolWorkers.layer)),
  );
});

it.effect("mount: an interrupted method stops the fiber it forked", () => {
  const stub = env.TEST_COUNTER_DO!.getByName(`mount-interrupt-${crypto.randomUUID()}`);

  return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
    Effect.gen(function* () {
      let interrupted = false;

      const build = DurableObject.mount(Layer.empty, {
        slot: { _tag: "Exclusive" },
        rpc: {
          slow: () =>
            Effect.never.pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true;
                }),
              ),
            ),
        },
      });

      const record = yield* build({ state: state.raw, env });
      const fiber = yield* Effect.forkChild(record.slow());

      yield* Effect.yieldNow;
      fiber.interruptUnsafe();
      yield* Fiber.await(fiber);

      for (let i = 0; i < 500 && !interrupted; i++) {
        yield* Effect.yieldNow;
      }

      assert.isTrue(interrupted);
    }).pipe(Effect.provide(PoolWorkers.layer)),
  );
});

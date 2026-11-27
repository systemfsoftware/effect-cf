# Hosted Durable Objects

`DurableObject.mount` builds the same options as `DurableObject.make` for a host that constructs the object itself and already owns the object's concurrency gate. Unlike `make`, it does not open a nested gate; it runs `initialize` inline and returns a plain record.

```ts
import { Effect, Layer } from "effect";
import { DurableObject } from "effect-cf";

const build = DurableObject.mount(Layer.empty, {
  slot: { _tag: "Exclusive" },
  initialize: Effect.void,
  rpc: {
    ping: () => Effect.succeed("pong"),
  },
});

// `state` is the native `DurableObjectState`, `env` the Worker env.
const record = yield * build({ state: nativeState, env });
const answer = yield * record.ping();
```

Each record property is a method that takes the handler's arguments and returns an `Effect`. Running the `Effect` runs the event on the object's shared runtime. Interrupting it aborts the underlying event, stopping any fiber the handler forked. The record is structural: it names no host and exposes no host type.

## The alarm slot

A Durable Object has exactly one physical alarm timestamp. `slot` is required, so the choice of who arms it is explicit.

- `{ _tag: "Exclusive" }` keeps `make`'s behaviour. The scheduler reads and writes the native alarm with `getAlarm`/`setAlarm`/`deleteAlarm`. The record includes an `alarm` method to call when the platform alarm fires. Use this only when nothing else on the object schedules the alarm.
- `{ _tag: "Delegated", delegate }` hands the slot to a host dispatcher that multiplexes the library's deadline with its own. `delegate` provides `schedule(at)` and `cancel`, both `Effect`s that do storage work only. The scheduler persists the deadline it hands off and calls the delegate inside the same transaction that writes the library's alarm row, so the row and the host's armed wake commit or roll back together. A failed delegate fails the transaction. In this mode the scheduler never calls `getAlarm`, `setAlarm` or `deleteAlarm`. The record omits `alarm` and exposes a `runAlarms` `Effect` that the host callback runs; it always succeeds, so the host's own callback retry and park policy never applies to library work.

The scheduler persists the handed-off deadline in its own table. On a fresh instance it re-sends the current earliest deadline when it differs from that persisted value, which covers an out-of-band change to the slot.

## Reserved names

`mount` refuses method names that collide with the entrypoint's own members — `RpcDefinition.reservedMethodNames`, `Object.prototype` method names, `ctx`, `env` and `runAlarms` — at construction, and repeats the named collisions in the error.

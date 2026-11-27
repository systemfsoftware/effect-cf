import { assert, it } from '@effect/vitest'
import { env } from 'cloudflare:workers'
import { DateTime, Effect, Exit, Layer } from 'effect'

import { DurableObjectAlarm } from '../src/index'
import * as PoolWorkers from '../src/Vitest'

const patchNativeAlarm = (raw: globalThis.DurableObjectStorage, nativeCalls: string[]) => {
  const setAlarm = raw.setAlarm.bind(raw)
  const deleteAlarm = raw.deleteAlarm.bind(raw)
  const getAlarm = raw.getAlarm.bind(raw)

  raw.setAlarm = (at) => {
    nativeCalls.push('setAlarm')

    return setAlarm(at)
  }
  raw.deleteAlarm = () => {
    nativeCalls.push('deleteAlarm')

    return deleteAlarm()
  }
  raw.getAlarm = () => {
    nativeCalls.push('getAlarm')

    return getAlarm()
  }
}

it.effect(
  'delegated slot: scheduling never touches the native alarm and hands the earliest deadline',
  () => {
    const stub = env.TEST_COUNTER_DO!.getByName(`delegated-slot-${crypto.randomUUID()}`)

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function*() {
        const nativeCalls: string[] = []
        const scheduled: number[] = []
        const rowsSeenInDelegate: number[] = []

        patchNativeAlarm(state.raw.storage, nativeCalls)

        const slot: DurableObjectAlarm.AlarmSlot = {
          _tag: 'Delegated',
          delegate: {
            schedule: (at) =>
              Effect.gen(function*() {
                scheduled.push(at)
                const cursor = yield* state.storage.sql.exec<{ n: number }>(
                  'SELECT COUNT(*) AS n FROM effect_cf_scheduled_alarms',
                )

                rowsSeenInDelegate.push((yield* cursor.toArray)[0]!.n)
              }).pipe(Effect.mapError((cause) => new DurableObjectAlarm.AlarmSlotError({ cause }))),
            cancel: Effect.void,
          },
        }

        const scheduler = DurableObjectAlarm.DurableObjectAlarm.layer.pipe(
          Layer.provideMerge(Layer.succeed(DurableObjectAlarm.AlarmSlot, slot)),
        )

        const now = Date.now()

        yield* Effect.gen(function*() {
          const alarms = yield* DurableObjectAlarm.DurableObjectAlarm

          for (const offset of [3_000, 2_000, 1_000]) {
            yield* alarms.scheduleAlarm({
              tag: 'job',
              id: `${offset}`,
              payload: null,
              runAt: DateTime.makeUnsafe(now + offset),
            })
          }
        }).pipe(Effect.provide(scheduler))

        assert.deepStrictEqual(nativeCalls, [])
        assert.isTrue(scheduled.length >= 3)
        assert.strictEqual(scheduled.at(-1), now + 1_000)
        assert.isTrue(rowsSeenInDelegate.every((n) => n >= 1))
      }).pipe(Effect.provide(PoolWorkers.layer)))
  },
)

it.effect(
  'delegated slot: a failed delegate rolls back the row and re-sends on the next write',
  () => {
    const stub = env.TEST_COUNTER_DO!.getByName(`delegated-fail-${crypto.randomUUID()}`)

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function*() {
        const scheduled: number[] = []
        let failNext = true

        const slot: DurableObjectAlarm.AlarmSlot = {
          _tag: 'Delegated',
          delegate: {
            schedule: (at) =>
              failNext
                ? Effect.fail(new DurableObjectAlarm.AlarmSlotError({ cause: new Error('down') }))
                : Effect.sync(() => {
                  scheduled.push(at)
                }),
            cancel: Effect.void,
          },
        }

        const scheduler = DurableObjectAlarm.DurableObjectAlarm.layer.pipe(
          Layer.provideMerge(Layer.succeed(DurableObjectAlarm.AlarmSlot, slot)),
        )

        const now = Date.now()
        const countRows = state.storage.sql
          .exec<{ n: number }>('SELECT COUNT(*) AS n FROM effect_cf_scheduled_alarms')
          .pipe(
            Effect.flatMap((cursor) => cursor.toArray),
            Effect.map((rows) => rows[0]?.n ?? 0),
            Effect.orElseSucceed(() => 0),
          )

        const first = yield* Effect.gen(function*() {
          const alarms = yield* DurableObjectAlarm.DurableObjectAlarm
          const exit = yield* Effect.exit(
            alarms.scheduleAlarm({
              tag: 'job',
              id: 'a',
              payload: null,
              runAt: DateTime.makeUnsafe(now + 1_000),
            }),
          )
          const count = yield* countRows

          return { exit, count }
        }).pipe(Effect.provide(scheduler))

        assert.isTrue(Exit.isFailure(first.exit))
        assert.strictEqual(first.count, 0)
        assert.deepStrictEqual(scheduled, [])

        failNext = false

        const second = yield* Effect.gen(function*() {
          const alarms = yield* DurableObjectAlarm.DurableObjectAlarm

          yield* alarms.scheduleAlarm({
            tag: 'job',
            id: 'a',
            payload: null,
            runAt: DateTime.makeUnsafe(now + 1_000),
          })

          return yield* countRows
        }).pipe(Effect.provide(scheduler))

        assert.strictEqual(second, 1)
        assert.deepStrictEqual(scheduled, [now + 1_000])
      }).pipe(Effect.provide(PoolWorkers.layer)))
  },
)

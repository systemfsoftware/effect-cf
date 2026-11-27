import { Effect, Layer } from 'effect'

import { DurableObject } from '../src/index'

// @ts-expect-error mount requires an explicit slot
DurableObject.mount(Layer.empty, {})

// @ts-expect-error a Delegated slot requires a delegate
DurableObject.mount(Layer.empty, { slot: { _tag: 'Delegated' } })

DurableObject.mount(Layer.empty, {
  slot: {
    _tag: 'Delegated',
    delegate: { schedule: () => Effect.void, cancel: Effect.void },
  },
})

DurableObject.mount(Layer.empty, { slot: { _tag: 'Exclusive' } })

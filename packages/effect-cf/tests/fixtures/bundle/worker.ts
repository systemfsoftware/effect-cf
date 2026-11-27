import { Worker } from '@systemfsoftware/effect-cf'
import { Effect, Layer } from 'effect'

export default Worker.make(Layer.empty, {
  fetch: Effect.sync(() => new Response('ok')),
})

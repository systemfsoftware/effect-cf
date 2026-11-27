import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as Tracer from "effect/Tracer";
import type { ManagedRuntime } from "effect";

import { NativeRequest } from "../Worker";
import type { WorkerEnv } from "../Environment";
import { DurableObjectState, fromDurableObjectState } from "../DurableObjectState";
import {
  AlarmSlot,
  DurableObjectAlarm,
  DispatchAfterEvent,
  HasDueAlarms,
  RunAlarm,
  ResponseEvent,
  dispatchRawAlarm,
  type InvalidAlarmRegistrationError,
  type InvalidScheduleConfigurationError,
} from "../DurableObjectAlarm";
import { fromWebSocket } from "../DurableObjectWebSocket";
import * as Runtime from "./Runtime";
import * as Telemetry from "./Telemetry";
import type {
  DurableObjectOptionsBase,
  DurableObjectRpc,
  HandlerContext,
  RunOptions,
  RuntimeContext,
} from "../DurableObject";

export const scheduleTelemetryFlush: Effect.Effect<void, never, DurableObjectState> =
  Telemetry.scheduleTelemetryFlush((flush) =>
    Effect.flatMap(DurableObjectState, (state) => state.waitUntil(flush)),
  );

const abortOnSignal = (signal: AbortSignal): Effect.Effect<never> =>
  Effect.callback<never>((resume) => {
    if (signal.aborted) {
      resume(Effect.interrupt);

      return;
    }
    const onAbort = () => resume(Effect.interrupt);

    signal.addEventListener("abort", onAbort, { once: true });

    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

export interface InstanceHost {
  readonly state: globalThis.DurableObjectState;
  readonly env: WorkerEnv;
  readonly gate: (run: () => Promise<void>) => Promise<void>;
}

export interface DurableObjectInstance<ROut, REvent, RAlarm, LayerError> {
  readonly runtime: ManagedRuntime.ManagedRuntime<
    RuntimeContext<ROut | RAlarm>,
    LayerError | InvalidAlarmRegistrationError
  >;
  run<A, E>(
    effect: Effect.Effect<A, E, HandlerContext<ROut | REvent | RAlarm>>,
    runOptions?: RunOptions,
  ): Promise<A>;
  fetch(request: Request): Promise<Response>;
  runAlarm(native: boolean, alarmInfo?: globalThis.AlarmInvocationInfo): Promise<void>;
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> | void;
  webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> | void;
  webSocketError(socket: WebSocket, cause: unknown): Promise<void> | void;
  readonly hasInitialize: boolean;
  prepareContext(): Promise<void>;
  runInitialize(): Promise<void>;
  startInitialize(): void;
}

export function makeInstance<
  ROut,
  LayerError,
  REvent = never,
  EventLayerError = never,
  Rpc extends DurableObjectRpc<NoInfer<ROut> | REvent | NoInfer<RAlarm>> = Record<never, never>,
  RAlarm = never,
>(
  layer: Layer.Layer<ROut, LayerError, RuntimeContext<NoInfer<RAlarm>>>,
  options: DurableObjectOptionsBase<ROut, REvent, EventLayerError, Rpc, RAlarm>,
  host: InstanceHost,
  slot?: AlarmSlot,
): DurableObjectInstance<ROut, REvent, RAlarm, LayerError> {
  const { state, env } = host;
  const registration =
    options.alarms !== undefined && !Effect.isEffect(options.alarms) ? options.alarms : undefined;
  const legacyAlarms = Effect.isEffect(options.alarms)
    ? options.alarms.pipe(Effect.asVoid)
    : undefined;

  const effectiveSlot: AlarmSlot = slot ?? { _tag: "Exclusive" };
  // SAFETY: providing `AlarmSlot` only widens the layer's output context; it stays a `DurableObjectAlarm` layer over `DurableObjectState`.
  const alarmLayer = DurableObjectAlarm.layer.pipe(
    Layer.provideMerge(Layer.succeed(AlarmSlot, effectiveSlot)),
  ) as Layer.Layer<DurableObjectAlarm, never, DurableObjectState>;
  const baseServices = alarmLayer.pipe(
    Layer.provideMerge(Layer.succeed(DurableObjectState, fromDurableObjectState(state))),
  );
  // SAFETY: RAlarm is inferred only from the registration's layer; without a registration it is never.
  const services = (registration?.layer ?? Layer.empty).pipe(
    Layer.provideMerge(baseServices),
  ) as Layer.Layer<DurableObjectState | DurableObjectAlarm | RAlarm, InvalidAlarmRegistrationError>;

  const runtime = Runtime.makeEntrypointRuntime<
    ROut,
    LayerError,
    DurableObjectState | DurableObjectAlarm | RAlarm,
    InvalidAlarmRegistrationError
  >(layer, env, services);

  const run = <A, E>(
    effect: Effect.Effect<A, E, HandlerContext<ROut | REvent | RAlarm>>,
    runOptions: RunOptions = {},
  ): Promise<A> => {
    const eventLayer = runOptions.eventLayer === false ? undefined : options.eventLayer;
    const parent = runOptions.rpc?.parent;
    const parentSpan = parent === undefined ? undefined : Tracer.externalSpan(parent);
    const afterResponse = runOptions.event === "rpc" || runOptions.event === "fetch";
    let dispatchAfterEvent = false;
    const runEffect =
      runOptions.signal === undefined
        ? effect
        : Effect.raceFirst(effect, abortOnSignal(runOptions.signal));
    const handler = afterResponse
      ? runEffect.pipe(
          Effect.provideService(ResponseEvent, true),
          Effect.onExit(() =>
            Effect.flatMap(DurableObjectAlarm, (alarms) =>
              Effect.map(alarms[DispatchAfterEvent], (enabled) => {
                dispatchAfterEvent = enabled;
              }),
            ),
          ),
        )
      : runEffect;
    let response: Promise<A>;

    if (eventLayer === undefined) {
      // SAFETY: initialize cannot require event services; without an event layer, all requirements are already provided.
      response = Runtime.runEventPromise(
        runtime,
        // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
        handler as Effect.Effect<A, E, HandlerContext<ROut | RAlarm>>,
        undefined,
        parentSpan,
        runOptions.onFailure,
      );
    } else {
      response = Runtime.runEventPromise<
        A,
        E,
        RuntimeContext<ROut | RAlarm>,
        REvent,
        EventLayerError,
        LayerError | InvalidAlarmRegistrationError
      >(runtime, handler, eventLayer, parentSpan, runOptions.onFailure);
    }

    if (!afterResponse) return response;

    return response.finally(() => {
      if (dispatchAfterEvent) {
        state.waitUntil(
          Effect.runPromise(
            Effect.yieldNow.pipe(Effect.andThen(Effect.promise(() => runAlarm(false)))),
          ),
        );
      }
    });
  };

  const fetch = (request: Request): Promise<Response> => {
    const fetchHandler = options.fetch;

    if (fetchHandler === undefined) {
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }

    return run(Effect.provideService(fetchHandler, NativeRequest, request), {
      event: "fetch",
    });
  };

  const runAlarm = (native: boolean, alarmInfo?: globalThis.AlarmInvocationInfo): Promise<void> => {
    const event = (beginDispatch: Effect.Effect<void, InvalidScheduleConfigurationError>) => {
      const alarmEffect = Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm;

        if (!native && !(yield* alarms[HasDueAlarms])) return;
        const rawAlarm = options.alarm?.(alarmInfo);
        const customAlarm =
          legacyAlarms === undefined
            ? (rawAlarm ?? Effect.void)
            : legacyAlarms.pipe(Effect.andThen(rawAlarm ?? Effect.void));

        yield* beginDispatch;
        yield* registration === undefined || rawAlarm !== undefined
          ? dispatchRawAlarm(customAlarm, registration)
          : registration.run.pipe(Effect.asVoid);
      }).pipe(Effect.onExit(() => scheduleTelemetryFlush));

      return Runtime.scopeEvent(
        options.eventLayer === undefined
          ? alarmEffect
          : alarmEffect.pipe(Effect.provide(options.eventLayer, { local: true })),
      );
    };

    return run(
      Effect.flatMap(DurableObjectAlarm, (alarms) => alarms[RunAlarm](event, native)),
      {
        event: "alarm",
        eventLayer: false,
      },
    );
  };

  const webSocketMessage = (
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> | void => {
    if (options.webSocketMessage !== undefined) {
      return run(options.webSocketMessage(fromWebSocket(socket), message), {
        event: "webSocketMessage",
      });
    }
  };

  const webSocketClose = (
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> | void => {
    if (options.webSocketClose !== undefined) {
      return run(options.webSocketClose(fromWebSocket(socket), code, reason, wasClean), {
        event: "webSocketClose",
      });
    }
  };

  const webSocketError = (socket: WebSocket, cause: unknown): Promise<void> | void => {
    if (options.webSocketError !== undefined) {
      return run(options.webSocketError(fromWebSocket(socket), cause), {
        event: "webSocketError",
      });
    }
  };

  const initialize = options.initialize;

  const prepareContext = async (): Promise<void> => {
    await Effect.runPromise(runtime.contextEffect, {
      scheduler: new Scheduler.MixedScheduler("sync"),
    });
  };

  const runInitialize = () =>
    initialize === undefined ? Promise.resolve() : run(initialize, { eventLayer: false });

  const startInitialize = (): void => {
    if (initialize === undefined) return;
    state.waitUntil(
      host.gate(async () => {
        await prepareContext();
        state.waitUntil(runInitialize());
      }),
    );
  };

  return {
    runtime,
    run,
    fetch,
    runAlarm,
    webSocketMessage,
    webSocketClose,
    webSocketError,
    hasInitialize: initialize !== undefined,
    prepareContext,
    runInitialize,
    startInitialize,
  };
}

import { DurableObject as CloudflareDurableObject } from "cloudflare:workers";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { Digest, SecureRandom } from "effect/crypto";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import type { Scope } from "effect";

import { NativeRequest } from "./Worker";
import { WorkerEnvironment, type WorkerEnv } from "./Environment";
import { DurableObjectState } from "./DurableObjectState";
import {
  AlarmSlot,
  DurableObjectAlarm,
  type AlarmRegistration,
  type AlarmService,
} from "./DurableObjectAlarm";
import type { DurableWebSocket } from "./DurableObjectWebSocket";
import * as RpcDefinition from "./RpcDefinition";
import * as Entrypoint from "./internal/Entrypoint";
import {
  makeInstance,
  scheduleTelemetryFlush,
  type DurableObjectInstance,
} from "./internal/Instance";
import * as Runtime from "./internal/Runtime";
import type { ReceiverOptions, RpcInvocationInfo, RpcTraceContext } from "./RpcTracing";

export type { BindingNotFoundError, BindingValidationError } from "./Binding";
export type {
  DurableObjectFetchError,
  DurableObjectNamespaceClient,
  DurableObjectRpcError,
  DurableObjectStubClient,
  StubCall,
  StubRpc,
  StubScopedCall,
} from "./DurableObjectNamespace";

const reservedMethodNames: ReadonlySet<string> = RpcDefinition.reservedMethodNames;

export type RuntimeContext<ROut> =
  | Digest.Digest
  | SecureRandom.SecureRandom
  | DurableObjectState
  | DurableObjectAlarm
  | WorkerEnvironment
  | ROut;

export type HandlerContext<ROut> = RuntimeContext<ROut> | Scope.Scope;

type FetchContext<ROut> = HandlerContext<ROut> | NativeRequest;
/** Metadata available before an event effect or its event layer starts. */
export interface RunOptions extends Runtime.RunOptions {
  readonly eventLayer?: boolean;
  readonly signal?: AbortSignal;
  readonly event?:
    | "fetch"
    | "rpc"
    | "alarm"
    | "webSocketMessage"
    | "webSocketClose"
    | "webSocketError";
  readonly rpc?: RpcInvocationInfo;
}

/** Override to instrument the whole event, then call super[RunSymbol]. */
export const RunSymbol = Symbol.for("effect-cf/DurableObject/run");

/**
 * Effect type for Durable Object lifecycle and RPC handlers.
 */
export type DurableObjectHandler<ROut, A = unknown> = Effect.Effect<
  A,
  unknown,
  HandlerContext<ROut>
>;

/**
 * Shape of Durable Object RPC handlers passed to {@link make}.
 */
export type DurableObjectRpc<ROut> = Record<
  string,
  (...args: Array<any>) => DurableObjectHandler<ROut>
>;

export type DurableObjectRpcApi<Rpc extends DurableObjectRpc<ROut>, ROut> = {
  readonly [Key in keyof Rpc]: Rpc[Key] extends (
    ...args: infer Args
  ) => Effect.Effect<infer A, unknown, HandlerContext<ROut>>
    ? (...args: Args) => Promise<A>
    : never;
};

export type RpcHandlers<ROut, Api> = {
  readonly [
    Key in keyof Api as Key extends keyof CloudflareDurableObject<WorkerEnv>
      ? never
      : Key extends string
        ? [Api[Key]] extends [never]
          ? never
          : Api[Key] extends (...args: Array<any>) => Promise<any>
            ? Key
            : never
        : never
  ]: Api[Key] extends (...args: infer Args) => Promise<infer A>
    ? (...args: Args) => DurableObjectHandler<ROut, A>
    : never;
};

export interface DurableObjectOptionsBase<
  RRuntime,
  REvent = never,
  EventLayerError = never,
  Rpc extends DurableObjectRpc<RRuntime | REvent | RAlarm> = Record<never, never>,
  RAlarm = never,
> {
  /**
   * Layer provided around each Cloudflare event handled by this Durable Object.
   *
   * The layer is built inside the event's Effect scope and finalized when the
   * event effect completes. It is not applied to `initialize`, which is an
   * instance-load lifecycle hook rather than a platform event.
   */
  readonly eventLayer?: Layer.Layer<
    REvent,
    EventLayerError,
    RuntimeContext<NoInfer<RRuntime | RAlarm>>
  >;
  /**
   * Effect run when Cloudflare loads this Durable Object instance into memory.
   *
   * The base layer is acquired before incoming events are admitted. The hook
   * itself runs in the background; start it with
   * `DurableObjectState.blockConcurrencyWhile` when incoming events should
   * wait for setup to finish. Cloudflare may construct
   * the same Durable Object id again after eviction or restart; use Durable
   * Object storage if work must happen only once per id.
   */
  readonly initialize?: Effect.Effect<void, unknown, HandlerContext<NoInfer<RRuntime | RAlarm>>>;
  /**
   * Optional RPC methods exposed as Durable Object instance methods.
   *
   * After every invocation, the configured OTLP flusher is scheduled through
   * `DurableObjectState.waitUntil`, including when the handler fails. The
   * scheduled flush silently settles within two seconds even if the exporter
   * does not.
   */
  readonly rpc?: Rpc;
  /** Accept live native trace metadata. The client must also enable rpcTracing. */
  readonly rpcTracing?: ReceiverOptions;
  readonly fetch?: Effect.Effect<
    Response,
    unknown,
    FetchContext<NoInfer<RRuntime | REvent | RAlarm>>
  >;

  /** Register handlers to provide their typed scheduler to application layers and all DO events. */
  readonly alarms?:
    | Effect.Effect<unknown, unknown, HandlerContext<NoInfer<RRuntime> | REvent | NoInfer<RAlarm>>>
    | AlarmRegistration<
        RAlarm,
        HandlerContext<NoInfer<RRuntime> | REvent | NoInfer<RAlarm>>,
        unknown
      >;
  /**
   * Optional raw alarm handler.
   *
   * After every invocation, the configured OTLP flusher is scheduled through
   * `DurableObjectState.waitUntil`, including when the handler fails. The
   * scheduled flush silently settles within two seconds even if the exporter
   * does not.
   */
  readonly alarm?: (
    alarmInfo?: globalThis.AlarmInvocationInfo,
  ) => Effect.Effect<void, unknown, HandlerContext<NoInfer<RRuntime> | REvent | NoInfer<RAlarm>>>;
  readonly webSocketMessage?: (
    socket: DurableWebSocket,
    message: string | ArrayBuffer,
  ) => Effect.Effect<void, unknown, HandlerContext<NoInfer<RRuntime> | REvent | NoInfer<RAlarm>>>;
  readonly webSocketClose?: (
    socket: DurableWebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => Effect.Effect<void, unknown, HandlerContext<NoInfer<RRuntime> | REvent | NoInfer<RAlarm>>>;
  readonly webSocketError?: (
    socket: DurableWebSocket,
    cause: unknown,
  ) => Effect.Effect<void, unknown, HandlerContext<NoInfer<RRuntime> | REvent | NoInfer<RAlarm>>>;
}

// Providing a scheduler through an ordinary layer does not install its dispatcher.
type CheckAlarmRegistration<RProvided, RAlarm> = [
  Exclude<Extract<NoInfer<RProvided>, AlarmService>, NoInfer<RAlarm>>,
] extends [never]
  ? unknown
  : never;

/** A declared event or alarm service must have its corresponding provider. */
export type DurableObjectOptions<
  RRuntime,
  REvent = never,
  EventLayerError = never,
  Rpc extends DurableObjectRpc<RRuntime | REvent | RAlarm> = Record<never, never>,
  RAlarm = never,
> = DurableObjectOptionsBase<RRuntime, REvent, EventLayerError, Rpc, RAlarm> &
  CheckAlarmRegistration<RRuntime | REvent, RAlarm> &
  ([Exclude<REvent, RuntimeContext<RRuntime | RAlarm> | Scope.Scope>] extends [never]
    ? unknown
    : {
        readonly eventLayer: Layer.Layer<
          REvent,
          EventLayerError,
          RuntimeContext<NoInfer<RRuntime | RAlarm>>
        >;
      }) &
  ([RAlarm] extends [never]
    ? unknown
    : {
        readonly alarms: AlarmRegistration<
          RAlarm,
          HandlerContext<NoInfer<RRuntime> | REvent | NoInfer<RAlarm>>,
          unknown
        >;
      });

/**
 * Cloudflare `DurableObject` constructor produced by {@link make}.
 */
export type DurableObjectClass<Rpc extends DurableObjectRpc<ROut>, ROut> = new (
  state: globalThis.DurableObjectState,
  env: WorkerEnv,
) => CloudflareDurableObject<WorkerEnv> &
  DurableObjectRpcApi<Rpc, ROut> & {
    alarm(alarmInfo?: globalThis.AlarmInvocationInfo): Promise<void> | void;
    [RunSymbol]<A, E>(
      effect: Effect.Effect<A, E, HandlerContext<ROut>>,
      options?: RunOptions,
    ): Promise<A>;
  };

/**
 * Builds a Durable Object whose base `layer` lives for the in-memory instance.
 * Cloudflare does not expose an eviction or shutdown hook, so finalizers in
 * that layer are not guaranteed to run. Put resources that require timely
 * release in `eventLayer`, whose scope closes after each handled event.
 */
export function make<ROut, LayerError>(
  layer: Layer.Layer<ROut, LayerError, RuntimeContext<never>> & CheckAlarmRegistration<ROut, never>,
): DurableObjectClass<Record<never, never>, ROut>;
export function make<
  ROut,
  LayerError,
  REvent = never,
  EventLayerError = never,
  const Rpc extends DurableObjectRpc<NoInfer<ROut> | REvent | NoInfer<RAlarm>> = Record<
    never,
    never
  >,
  RAlarm = never,
>(
  layer: Layer.Layer<ROut, LayerError, RuntimeContext<NoInfer<RAlarm>>>,
  options: DurableObjectOptions<ROut, REvent, EventLayerError, Rpc, RAlarm>,
): DurableObjectClass<Rpc, ROut | REvent | RAlarm>;
export function make<
  ROut,
  LayerError,
  REvent = never,
  EventLayerError = never,
  const Rpc extends DurableObjectRpc<NoInfer<ROut> | REvent | NoInfer<RAlarm>> = Record<
    never,
    never
  >,
  RAlarm = never,
>(
  layer: Layer.Layer<ROut, LayerError, RuntimeContext<NoInfer<RAlarm>>>,
  options: DurableObjectOptionsBase<ROut, REvent, EventLayerError, Rpc, RAlarm> = {},
): DurableObjectClass<Rpc, ROut | REvent | RAlarm> {
  class EffectDurableObject extends CloudflareDurableObject<WorkerEnv> {
    readonly runtime: DurableObjectInstance<ROut, REvent, RAlarm, LayerError>["runtime"];
    readonly #instance: DurableObjectInstance<ROut, REvent, RAlarm, LayerError>;

    constructor(state: globalThis.DurableObjectState, env: WorkerEnv) {
      super(state, env);

      const instance = makeInstance(layer, options, {
        state,
        env,
        gate: (run) => state.blockConcurrencyWhile(run),
      });

      this.#instance = instance;
      this.runtime = instance.runtime;
      instance.startInitialize();
    }

    [RunSymbol]<A, E>(
      effect: Effect.Effect<A, E, HandlerContext<ROut | REvent | RAlarm>>,
      runOptions: RunOptions = {},
    ): Promise<A> {
      return this.#instance.run(effect, runOptions);
    }

    fetch(request: Request): Promise<Response> {
      return this.#instance.fetch(request);
    }

    alarm(alarmInfo?: globalThis.AlarmInvocationInfo): Promise<void> {
      return this.#instance.runAlarm(true, alarmInfo);
    }

    webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> | void {
      return this.#instance.webSocketMessage(socket, message);
    }

    webSocketClose(
      socket: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean,
    ): Promise<void> | void {
      return this.#instance.webSocketClose(socket, code, reason, wasClean);
    }

    webSocketError(socket: WebSocket, cause: unknown): Promise<void> | void {
      return this.#instance.webSocketError(socket, cause);
    }
  }

  Entrypoint.defineEntrypointRpcMethods<EffectDurableObject>(
    "Durable Object",
    EffectDurableObject.prototype,
    options.rpc,
    reservedMethodNames,
    (self, effect, rpc) => self[RunSymbol](effect, { event: "rpc", rpc }),
    () => scheduleTelemetryFlush,
    options.rpcTracing,
  );

  return Entrypoint.assumeEntrypointClass<DurableObjectClass<Rpc, ROut | REvent | RAlarm>>(
    EffectDurableObject,
  );
}

export type ReservedMountKey =
  | RpcDefinition.ReservedMethodName
  | "toString"
  | "toLocaleString"
  | "valueOf"
  | "hasOwnProperty"
  | "isPrototypeOf"
  | "propertyIsEnumerable"
  | "__defineGetter__"
  | "__defineSetter__"
  | "__lookupGetter__"
  | "__lookupSetter__"
  | "__proto__"
  | "ctx"
  | "env"
  | "runAlarms";

const reservedMountKeys: ReadonlySet<string> = new Set<string>([
  ...RpcDefinition.reservedMethodNames,
  ...Object.getOwnPropertyNames(Object.prototype),
  "ctx",
  "env",
  "runAlarms",
]);

export interface MountHost {
  readonly state: globalThis.DurableObjectState;
  readonly env: WorkerEnv;
}

export type MountedMethod<Handler> = Handler extends (
  ...args: infer Args
) => Effect.Effect<infer A, infer _E, infer _R>
  ? (...args: Args) => Effect.Effect<A, unknown>
  : never;

export type MountedRecord<Rpc> = {
  readonly [K in keyof Rpc]: MountedMethod<Rpc[K]>;
} & {
  readonly alarm?: (alarmInfo?: globalThis.AlarmInvocationInfo) => Effect.Effect<void, unknown>;
  readonly runAlarms?: Effect.Effect<void, never>;
};

const MOUNT_SERVICE = "Durable Object";

export function mount<
  ROut,
  LayerError,
  REvent = never,
  EventLayerError = never,
  const Rpc extends DurableObjectRpc<NoInfer<ROut> | REvent | NoInfer<RAlarm>> = Record<
    never,
    never
  >,
  RAlarm = never,
>(
  layer: Layer.Layer<ROut, LayerError, RuntimeContext<NoInfer<RAlarm>>>,
  options: DurableObjectOptionsBase<ROut, REvent, EventLayerError, Rpc, RAlarm> & {
    readonly slot: AlarmSlot;
  },
): (host: MountHost) => Effect.Effect<MountedRecord<Rpc>, unknown> {
  return (host) =>
    Effect.gen(function* () {
      const instance = makeInstance(
        layer,
        options,
        { state: host.state, env: host.env, gate: (run) => run() },
        options.slot,
      );

      if (instance.hasInitialize) {
        yield* Effect.promise(() => instance.prepareContext());
        yield* Effect.promise(() => instance.runInitialize());
      }

      const rpcTracing = options.rpcTracing;
      // SAFETY: the options' `rpc` record was already validated by `make`'s typing; here it is read structurally as handler effects.
      const handlers = (options.rpc ?? {}) as Record<
        string,
        (...args: Array<any>) => Effect.Effect<any, any, any>
      >;
      const record: Record<
        string,
        | ((...args: Array<unknown>) => Effect.Effect<unknown, unknown>)
        | ((alarmInfo?: globalThis.AlarmInvocationInfo) => Effect.Effect<void, unknown>)
        | Effect.Effect<void, never>
      > = {};

      for (const [key, handler] of Object.entries(handlers)) {
        if (reservedMountKeys.has(key)) {
          throw new Error(`Cannot mount a Durable Object method named "${key}"`);
        }
        record[key] = (...args: Array<unknown>) =>
          Effect.withFiber((fiber) => {
            const prepared = Entrypoint.prepareEntrypointRpcHandler(
              handler,
              args,
              MOUNT_SERVICE,
              key,
              rpcTracing ?? { service: MOUNT_SERVICE },
            );
            const hostSpan = Option.getOrUndefined(
              Context.getOption(fiber.context, Tracer.ParentSpan),
            );
            const parent: RpcTraceContext | undefined =
              prepared.invocation.parent ??
              (hostSpan === undefined
                ? undefined
                : {
                    _tag: "effect-cf/RpcTraceContext/v1",
                    traceId: hostSpan.traceId,
                    spanId: hostSpan.spanId,
                    sampled: hostSpan.sampled,
                  });
            const controller = new AbortController();

            return Effect.callback<unknown, unknown>((resume) => {
              // SAFETY: the prepared handler is an event effect over this instance's handler context.
              instance
                .run(
                  prepared.handler as Effect.Effect<
                    unknown,
                    unknown,
                    HandlerContext<ROut | REvent | RAlarm>
                  >,
                  {
                    event: "rpc",
                    rpc: { ...prepared.invocation, parent },
                    signal: controller.signal,
                  },
                )
                .then(
                  (value) => resume(Effect.succeed(value)),
                  (error) => resume(Effect.fail(error)),
                );

              return Effect.sync(() => controller.abort());
            });
          });
      }

      if (options.slot._tag === "Exclusive") {
        record.alarm = (alarmInfo?: globalThis.AlarmInvocationInfo) =>
          Effect.callback<void, unknown>((resume) => {
            instance.runAlarm(true, alarmInfo).then(
              () => resume(Effect.void),
              (error) => resume(Effect.fail(error)),
            );
          });
      } else {
        record.runAlarms = Effect.callback<void>((resume) => {
          instance.runAlarm(true).then(
            () => resume(Effect.void),
            () => resume(Effect.void),
          );
        });
      }

      // SAFETY: `record` holds one mounted method per rpc key plus the slot's alarm entry, matching `MountedRecord`.
      return record as MountedRecord<Rpc>;
    });
}

export type {
  Api,
  Definition,
  HandlerEffect,
  Handlers,
  LayerOptions,
  Method,
  Methods,
  NativeSchema,
  NoReservedMethods,
  Options,
  ReservedMethodName,
  RpcSchema,
  ServerApi,
  ServiceFreeSchema,
  TagClass,
} from "./DurableObjectDefinition";

export { implement, method, native, Tag } from "./DurableObjectDefinition";

// Preserve the original public type export while using a domain-role name internally.
export type { DurableObjectRpcApi as "DurableObjectRpcShape" };

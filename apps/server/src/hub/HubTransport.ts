/**
 * HubTransport - the wire to a Puff Collab team hub: JSON over HTTP for the
 * link and project endpoints, and one WebSocket for sync. HubSync speaks the
 * protocol (hub.ts); this only moves bytes, so tests swap in a fake hub.
 *
 * The environment credential travels only in the `Authorization` header and
 * is never logged.
 *
 * @module HubTransport
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Cause from "effect/Cause";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

class HubTransportError extends Schema.TaggedError<HubTransportError>()("HubTransportError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Could not reach the team hub (${this.operation}).`;
  }
}

interface HubHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/** How a sync socket ended. 1006 when it dropped without a close frame. */
export interface HubSocketClose {
  readonly code: number;
  readonly reason: string;
}

export interface HubSocket {
  /** Sends one text frame; a closed socket drops it. */
  readonly send: (frame: string) => Effect.Effect<void>;
  /** Text frames in arrival order; ends when the socket closes. */
  readonly incoming: Stream.Stream<string>;
  /** Waits for the socket to close. */
  readonly closed: Effect.Effect<HubSocketClose>;
  readonly close: (code?: number, reason?: string) => Effect.Effect<void>;
}

export class HubTransport extends Context.Service<
  HubTransport,
  {
    readonly request: (input: {
      readonly method: "GET" | "POST" | "DELETE";
      readonly url: string;
      readonly body?: unknown;
      readonly bearer?: string;
    }) => Effect.Effect<HubHttpResponse, HubTransportError>;
    /** Opens the sync socket; it closes with the scope. */
    readonly connect: (input: {
      readonly url: string;
      readonly bearer: string;
    }) => Effect.Effect<HubSocket, HubTransportError, Scope.Scope>;
  }
>()("t3/hub/HubTransport") {}

const HTTP_TIMEOUT = "15 seconds";
const OPEN_TIMEOUT = "15 seconds";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const makeRequest = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const request: HubTransport["Service"]["request"] = (input) =>
    Effect.gen(function* () {
      let outgoing = HttpClientRequest.make(input.method)(input.url).pipe(
        HttpClientRequest.acceptJson,
      );
      if (input.bearer !== undefined) {
        outgoing = HttpClientRequest.bearerToken(outgoing, input.bearer);
      }
      if (input.body !== undefined) {
        outgoing = HttpClientRequest.bodyJsonUnsafe(outgoing, input.body);
      }
      const response = yield* client.execute(outgoing);
      const text = yield* response.text;
      return {
        status: response.status,
        body: text.length === 0 ? null : Option.getOrNull(decodeJson(text)),
      } satisfies HubHttpResponse;
    }).pipe(
      Effect.timeout(HTTP_TIMEOUT),
      Effect.mapError(
        (cause) => new HubTransportError({ operation: `${input.method} request`, cause }),
      ),
    );
  return request;
});

const connect: HubTransport["Service"]["connect"] = (input) =>
  Effect.gen(function* () {
    const incoming = yield* Queue.unbounded<string, Cause.Done>();
    const closed = yield* Deferred.make<HubSocketClose>();
    const socket = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new NodeSocket.NodeWS.WebSocket(input.url, {
            headers: { authorization: `Bearer ${input.bearer}` },
          }),
      ),
      (socket) => Effect.sync(() => socket.terminate()),
    );
    const finish = (code: number, reason: string) => {
      Queue.endUnsafe(incoming);
      Deferred.doneUnsafe(closed, Effect.succeed({ code, reason }));
    };
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      Queue.offerUnsafe(incoming, data.toString());
    });
    socket.on("close", (code, reason) => finish(code, reason.toString()));
    socket.on("error", () => finish(1006, "socket error"));
    yield* Effect.callback<void, HubTransportError>((resume) => {
      if (socket.readyState === socket.OPEN) return resume(Effect.void);
      socket.once("open", () => resume(Effect.void));
      socket.once("unexpected-response", (_request, response) =>
        resume(
          Effect.fail(
            new HubTransportError({
              operation: "sync upgrade",
              cause: `HTTP ${response.statusCode ?? "error"}`,
            }),
          ),
        ),
      );
      socket.once("error", (cause) =>
        resume(Effect.fail(new HubTransportError({ operation: "sync connect", cause }))),
      );
    }).pipe(
      Effect.timeoutOrElse({
        duration: OPEN_TIMEOUT,
        orElse: () =>
          Effect.fail(new HubTransportError({ operation: "sync connect", cause: "timeout" })),
      }),
    );
    return {
      send: (frame) =>
        Effect.sync(() => {
          if (socket.readyState === socket.OPEN) socket.send(frame);
        }),
      incoming: Stream.fromQueue(incoming),
      closed: Deferred.await(closed),
      close: (code = 1000, reason = "") => Effect.sync(() => socket.close(code, reason)),
    } satisfies HubSocket;
  });

export const layer = Layer.effect(
  HubTransport,
  makeRequest.pipe(Effect.map((request) => HubTransport.of({ request, connect }))),
).pipe(Layer.provide(FetchHttpClient.layer));

import { Handled } from "./jsonrpc.js";
import type {
  ConnectionBuilder,
  ConnectionContext,
  JsonRpcId,
  MaybePromise,
  RequestResponder,
} from "./jsonrpc.js";

/**
 * Parser used by custom methods to validate or transform raw JSON-RPC params.
 *
 * A Zod schema can be passed directly because schemas expose a compatible
 * `parse(...)` method.
 */
export type ParamsParser<Params> =
  | {
      /**
       * Parses raw JSON-RPC params into the handler's typed params.
       */
      parse: (params: unknown) => Params;
    }
  | ((params: unknown) => Params);

export function parseParams<Params>(
  parser: ParamsParser<Params> | undefined,
  params: unknown,
): Params {
  if (!parser) {
    return params as Params;
  }

  if (typeof parser === "function") {
    return parser(params);
  }

  return parser.parse(params);
}

type MethodSpec<Params> = {
  method: string;
  params?: ParamsParser<Params>;
};

export function registerAppRequest<Params, HandlerResponse, Response, Context>(
  builder: ConnectionBuilder,
  spec: MethodSpec<Params>,
  context: (
    params: Params,
    cx: ConnectionContext,
    signal: AbortSignal,
    requestId: JsonRpcId,
    method: string,
  ) => Context,
  handler: (context: Context) => MaybePromise<HandlerResponse>,
  serializeResponse?: (response: HandlerResponse) => Response,
  lifecycle?: {
    afterResponse(
      params: Params,
      response: Response,
      cx: ConnectionContext,
    ): void;
    onError(cx: ConnectionContext, error: unknown): void;
  },
): void {
  const handle = async (
    params: Params,
    responder: RequestResponder<Response>,
    cx: ConnectionContext,
    method: string,
  ) => {
    try {
      const response = await handler(
        context(params, cx, responder.signal, responder.id, method),
      );
      const sentResponse = serializeResponse
        ? serializeResponse(response)
        : (response as unknown as Response);
      await responder.respond(sentResponse);
      lifecycle?.afterResponse(params, sentResponse, cx);
    } catch (error) {
      lifecycle?.onError(cx, error);
      throw error;
    }
  };
  if (spec.method === "*") {
    builder.withFallbackHandler({
      handleMessage: async (message, cx) => {
        if (message.kind !== "request") return Handled.no(message);
        await handle(
          message.params as Params,
          message.responder as RequestResponder<Response>,
          cx,
          message.method,
        );
        return Handled.yes();
      },
    });
  } else {
    builder.onReceiveRequest<Params, Response>(
      spec.method,
      (params) => parseParams(spec.params, params),
      (params, responder, cx) => handle(params, responder, cx, spec.method),
    );
  }
}

export function registerAppNotification<Params, Context>(
  builder: ConnectionBuilder,
  spec: MethodSpec<Params>,
  context: (
    params: Params,
    cx: ConnectionContext,
    signal: AbortSignal,
    method: string,
  ) => Context,
  handler: (context: Context) => MaybePromise<void>,
): void {
  if (spec.method === "*") {
    builder.withFallbackHandler({
      handleMessage: async (message, cx) => {
        if (message.kind !== "notification") return Handled.no(message);
        await handler(
          context(message.params as Params, cx, cx.signal, message.method),
        );
        return Handled.yes();
      },
    });
  } else {
    builder.onReceiveNotification(
      spec.method,
      (params) => parseParams(spec.params, params),
      (params, cx) => handler(context(params, cx, cx.signal, spec.method)),
    );
  }
}

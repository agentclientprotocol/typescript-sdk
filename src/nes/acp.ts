import * as acp from "../v1/unstable/acp.js";
import * as core from "../v1/unstable/schema/zod.gen.js";
import { defaultOnError, vecSkipError } from "../core/schema-deserialize.js";
import * as validate from "./schema/zod.gen.js";
import type * as schema from "./schema/types.gen.js";

export * from "../v1/unstable/acp.js";
export type { SessionId } from "../v1/unstable/acp.js";
export type * from "./schema/types.gen.js";
export * as validate from "./schema/zod.gen.js";

export const methods = {
  ...acp.methods,
  agent: {
    ...acp.methods.agent,
    nes: {
      start: "nes/start",
      suggest: "nes/suggest",
      close: "nes/close",
      accept: "nes/accept",
      reject: "nes/reject",
    },
    document: {
      didOpen: "document/didOpen",
      didChange: "document/didChange",
      didClose: "document/didClose",
      didSave: "document/didSave",
      didFocus: "document/didFocus",
    },
  },
} as const;

export const AGENT_METHODS = {
  ...acp.AGENT_METHODS,
  nes_start: methods.agent.nes.start,
  nes_suggest: methods.agent.nes.suggest,
  nes_close: methods.agent.nes.close,
  nes_accept: methods.agent.nes.accept,
  nes_reject: methods.agent.nes.reject,
  document_did_open: methods.agent.document.didOpen,
  document_did_change: methods.agent.document.didChange,
  document_did_close: methods.agent.document.didClose,
  document_did_save: methods.agent.document.didSave,
  document_did_focus: methods.agent.document.didFocus,
} as const;

export type ClientCapabilities = acp.ClientCapabilities & {
  nes?: schema.ClientNesCapabilities | null;
  positionEncodings?: schema.PositionEncodingKind[];
};

export type AgentCapabilities = acp.AgentCapabilities & {
  nes?: schema.NesCapabilities | null;
  positionEncoding?: schema.PositionEncodingKind | null;
};

export type InitializeRequest = Omit<
  acp.InitializeRequest,
  "clientCapabilities"
> & { clientCapabilities?: ClientCapabilities };

export type InitializeResponse = Omit<
  acp.InitializeResponse,
  "agentCapabilities"
> & { agentCapabilities?: AgentCapabilities };

// Only the retired fields are frozen; all other ACP capabilities stay current.
export const zClientCapabilities = core.zClientCapabilities.extend({
  nes: defaultOnError(
    validate.zClientNesCapabilities.nullish(),
    () => undefined,
  ),
  positionEncodings: defaultOnError(
    vecSkipError(validate.zPositionEncodingKind).optional(),
    () => [],
  ),
});

export const zAgentCapabilities = core.zAgentCapabilities.extend({
  nes: defaultOnError(validate.zNesCapabilities.nullish(), () => undefined),
  positionEncoding: defaultOnError(
    validate.zPositionEncodingKind.nullish(),
    () => undefined,
  ),
});

export const zInitializeRequest = core.zInitializeRequest.extend({
  clientCapabilities: defaultOnError(
    zClientCapabilities.optional().default(() => zClientCapabilities.parse({})),
    () => zClientCapabilities.parse({}),
  ),
});

export const zInitializeResponse = core.zInitializeResponse.extend({
  agentCapabilities: defaultOnError(
    zAgentCapabilities.optional().default(() => zAgentCapabilities.parse({})),
    () => zAgentCapabilities.parse({}),
  ),
});

export type AgentRequestHandlersByMethod = Omit<
  acp.AgentRequestHandlersByMethod,
  "initialize"
> & {
  initialize: acp.AgentRequestHandler<InitializeRequest, InitializeResponse>;
  "nes/start": acp.AgentRequestHandler<
    schema.StartNesRequest,
    schema.StartNesResponse
  >;
  "nes/suggest": acp.AgentRequestHandler<
    schema.SuggestNesRequest,
    schema.SuggestNesResponse
  >;
  "nes/close": acp.AgentRequestHandler<
    schema.CloseNesRequest,
    schema.CloseNesResponse | void
  >;
};

export type AgentNotificationHandlersByMethod =
  acp.AgentNotificationHandlersByMethod & {
    "nes/accept": acp.AgentNotificationHandler<schema.AcceptNesNotification>;
    "nes/reject": acp.AgentNotificationHandler<schema.RejectNesNotification>;
    "document/didOpen": acp.AgentNotificationHandler<schema.DidOpenDocumentNotification>;
    "document/didChange": acp.AgentNotificationHandler<schema.DidChangeDocumentNotification>;
    "document/didClose": acp.AgentNotificationHandler<schema.DidCloseDocumentNotification>;
    "document/didSave": acp.AgentNotificationHandler<schema.DidSaveDocumentNotification>;
    "document/didFocus": acp.AgentNotificationHandler<schema.DidFocusDocumentNotification>;
  };

export type AgentRequestMethod = keyof AgentRequestHandlersByMethod;
export type AgentNotificationMethod = keyof AgentNotificationHandlersByMethod;
export type AgentRequestParamsByMethod = {
  [Method in AgentRequestMethod]: Parameters<
    AgentRequestHandlersByMethod[Method]
  >[0]["params"];
};
export type AgentRequestResponsesByMethod = {
  [Method in AgentRequestMethod]: Exclude<
    Awaited<ReturnType<AgentRequestHandlersByMethod[Method]>>,
    void
  >;
};
export type AgentNotificationParamsByMethod = {
  [Method in AgentNotificationMethod]: Parameters<
    AgentNotificationHandlersByMethod[Method]
  >[0]["params"];
};

const requestParsers = new Map<string, acp.ParamsParser<unknown>>([
  ["initialize", zInitializeRequest],
  [methods.agent.nes.start, validate.zStartNesRequest],
  [methods.agent.nes.suggest, validate.zSuggestNesRequest],
  [methods.agent.nes.close, validate.zCloseNesRequest],
]);
const notificationParsers = new Map<string, acp.ParamsParser<unknown>>([
  [methods.agent.nes.accept, validate.zAcceptNesNotification],
  [methods.agent.nes.reject, validate.zRejectNesNotification],
  [methods.agent.document.didOpen, validate.zDidOpenDocumentNotification],
  [methods.agent.document.didChange, validate.zDidChangeDocumentNotification],
  [methods.agent.document.didClose, validate.zDidCloseDocumentNotification],
  [methods.agent.document.didSave, validate.zDidSaveDocumentNotification],
  [methods.agent.document.didFocus, validate.zDidFocusDocumentNotification],
]);

export function agent(options?: acp.AppOptions): AgentApp {
  return new AgentApp(options);
}

export class AgentApp extends acp.AgentApp {
  override onRequest(
    method: "*",
    handler: acp.AgentRequestHandler<unknown, unknown>,
  ): this;
  override onRequest<Method extends AgentRequestMethod>(
    method: Method,
    handler: AgentRequestHandlersByMethod[Method],
  ): this;
  override onRequest<Params, Response>(
    method: string,
    params: acp.ParamsParser<Params>,
    handler: acp.AgentRequestHandler<Params, Response>,
  ): this;
  override onRequest<Params, Response>(
    method: string,
    handlerOrParams:
      | AgentRequestHandlersByMethod[AgentRequestMethod]
      | acp.AgentRequestHandler<unknown, unknown>
      | acp.ParamsParser<Params>,
    handler?: acp.AgentRequestHandler<Params, Response>,
  ): this {
    if (handler) {
      return super.onRequest(
        method,
        handlerOrParams as acp.ParamsParser<Params>,
        handler,
      );
    }
    const parser = requestParsers.get(method);
    if (parser) {
      const handle = handlerOrParams as acp.AgentRequestHandler<
        unknown,
        unknown
      >;
      return super.onRequest(method, parser, async (context) => {
        const response = await handle(context);
        return method === methods.agent.nes.close ? (response ?? {}) : response;
      });
    }
    return super.onRequest(
      method as acp.AgentRequestMethod,
      handlerOrParams as acp.AgentRequestHandlersByMethod[acp.AgentRequestMethod],
    );
  }

  override onNotification(
    method: "*",
    handler: acp.AgentNotificationHandler<unknown>,
  ): this;
  override onNotification<Method extends AgentNotificationMethod>(
    method: Method,
    handler: AgentNotificationHandlersByMethod[Method],
  ): this;
  override onNotification<Params>(
    method: string,
    params: acp.ParamsParser<Params>,
    handler: acp.AgentNotificationHandler<Params>,
  ): this;
  override onNotification<Params>(
    method: string,
    handlerOrParams:
      | AgentNotificationHandlersByMethod[AgentNotificationMethod]
      | acp.AgentNotificationHandler<unknown>
      | acp.ParamsParser<Params>,
    handler?: acp.AgentNotificationHandler<Params>,
  ): this {
    if (handler) {
      return super.onNotification(
        method,
        handlerOrParams as acp.ParamsParser<Params>,
        handler,
      );
    }
    const parser = notificationParsers.get(method);
    if (parser) {
      return super.onNotification(
        method,
        parser,
        handlerOrParams as acp.AgentNotificationHandler<unknown>,
      );
    }
    return super.onNotification(
      method as acp.AgentNotificationMethod,
      handlerOrParams as acp.AgentNotificationHandlersByMethod[acp.AgentNotificationMethod],
    );
  }
}

// Core contexts already send arbitrary methods. Specialize their method maps
// locally, without proxies, extra connections, or module augmentation.
export const ClientContext = acp.ClientContext;
export interface ClientContext extends acp.ClientContext {
  request<Method extends AgentRequestMethod>(
    method: Method,
    params: AgentRequestParamsByMethod[Method],
    options?: acp.SendRequestOptions,
  ): Promise<AgentRequestResponsesByMethod[Method]>;
  request<Response = unknown, Params = unknown>(
    method: string,
    params?: Params,
    options?: acp.SendRequestOptions,
  ): Promise<Response>;
  notify<Method extends AgentNotificationMethod>(
    method: Method,
    params: AgentNotificationParamsByMethod[Method],
  ): Promise<void>;
  notify<Params = unknown>(method: string, params?: Params): Promise<void>;
}

export interface ClientConnection extends acp.ClientConnection {
  readonly agent: ClientContext;
}
export type ClientConnectHandler = (
  connection: ClientConnection,
) => acp.MaybePromise<void>;
export type ClientHandlerContext<Params> = Omit<
  acp.ClientHandlerContext<Params>,
  "agent"
> & { agent: ClientContext };
export type ClientRequestContext<Params> = ClientHandlerContext<Params> & {
  requestId: acp.JsonRpcId;
};
export type ClientNotificationContext<Params> = ClientHandlerContext<Params>;
export type ClientRequestHandler<Params, Response> = (
  context: ClientRequestContext<Params>,
) => acp.MaybePromise<Response>;
export type ClientNotificationHandler<Params> = (
  context: ClientNotificationContext<Params>,
) => acp.MaybePromise<void>;
export type ClientRequestHandlersByMethod = {
  [Method in acp.ClientRequestMethod]: (
    context: ClientRequestContext<acp.ClientRequestParamsByMethod[Method]>,
  ) => ReturnType<acp.ClientRequestHandlersByMethod[Method]>;
};
export type ClientNotificationHandlersByMethod = {
  [Method in acp.ClientNotificationMethod]: ClientNotificationHandler<
    acp.ClientNotificationParamsByMethod[Method]
  >;
};

export function client(options?: acp.AppOptions): ClientApp {
  return new ClientApp(options);
}

// Client behavior is unchanged: the base implementation already sends arbitrary
// methods. Specialize every place a context is exposed, retaining its constructor.
export interface ClientApp extends acp.ClientApp {
  connect(target: acp.Stream | acp.AgentApp): ClientConnection;
  connectWith<T>(
    target: acp.Stream | acp.AgentApp,
    op: (context: ClientContext) => acp.MaybePromise<T>,
  ): Promise<T>;
  onConnect(handler: ClientConnectHandler): this;
  onRequest(method: "*", handler: ClientRequestHandler<unknown, unknown>): this;
  onRequest<Method extends acp.ClientRequestMethod>(
    method: Method,
    handler: ClientRequestHandlersByMethod[Method],
  ): this;
  onRequest<Params, Response>(
    method: string,
    params: acp.ParamsParser<Params>,
    handler: ClientRequestHandler<Params, Response>,
  ): this;
  onNotification(
    method: "*",
    handler: ClientNotificationHandler<unknown>,
  ): this;
  onNotification<Method extends acp.ClientNotificationMethod>(
    method: Method,
    handler: ClientNotificationHandlersByMethod[Method],
  ): this;
  onNotification<Params>(
    method: string,
    params: acp.ParamsParser<Params>,
    handler: ClientNotificationHandler<Params>,
  ): this;
}

export const ClientApp = acp.ClientApp as {
  new (options?: acp.AppOptions): ClientApp;
  readonly prototype: ClientApp;
};

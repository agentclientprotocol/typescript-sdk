import * as schema from "./schema/index.js";
import * as validate from "./schema/zod.gen.js";
export type * from "./schema/types.gen.js";
export * from "./schema/index.js";
export * from "./stream.js";
export {
  Connection,
  ConnectionBuilder,
  ConnectionContext,
  Handled,
  HandlerRegistration,
  RequestError,
  RequestResponder,
} from "./jsonrpc.js";
export type {
  AnyNotification,
  AnyMessage,
  AnyRequest,
  AnyResponse,
  ConnectionOptions,
  ErrorResponse,
  HandleResult,
  IncomingNotification,
  IncomingMessage,
  IncomingRequest,
  JsonRpcHandler,
  MaybePromise,
  NotificationCallback,
  NotificationHandler,
  RequestCallback,
  RequestHandler,
  Result,
} from "./jsonrpc.js";

import type { Stream } from "./stream.js";
import { Connection, Handled } from "./jsonrpc.js";
import type {
  AnyMessage,
  ConnectionBuilder,
  ConnectionContext,
  HandlerRegistration,
  IncomingMessage,
  JsonRpcHandler,
  MaybePromise,
} from "./jsonrpc.js";

function emptyObjectResponse<T>(response: T | null | undefined | void): T {
  return response ?? ({} as T);
}

function isStream(value: unknown): value is Stream {
  return (
    typeof value === "object" &&
    value !== null &&
    "readable" in value &&
    "writable" in value
  );
}

function memoryStreamPair(): [Stream, Stream] {
  const leftToRight = new TransformStream<AnyMessage>();
  const rightToLeft = new TransformStream<AnyMessage>();
  return [
    {
      readable: rightToLeft.readable,
      writable: leftToRight.writable,
    },
    {
      readable: leftToRight.readable,
      writable: rightToLeft.writable,
    },
  ];
}

function hasSessionId(message: IncomingMessage): boolean {
  const params = message.params;
  return (
    typeof params === "object" &&
    params !== null &&
    "sessionId" in params &&
    typeof params.sessionId === "string"
  );
}

function isRetryableClientSessionNotification(
  message: IncomingMessage,
): boolean {
  return (
    message.kind === "notification" &&
    message.method === schema.CLIENT_METHODS.session_update &&
    hasSessionId(message)
  );
}

export class AcpConnectionContext {
  constructor(private readonly cx: ConnectionContext) {}

  protected sendRequest<Req, Resp, Output = Resp>(
    method: string,
    params?: Req,
    mapResponse?: (response: Resp) => Output,
  ): Promise<Output> {
    return this.cx.sendRequest(method, params, mapResponse);
  }

  protected sendNotification<N>(method: string, params?: N): Promise<void> {
    return this.cx.sendNotification(method, params);
  }

  protected addDynamicHandler(handler: JsonRpcHandler): HandlerRegistration {
    return this.cx.addDynamicHandler(handler);
  }
}

export class AgentContext extends AcpConnectionContext {
  sessionUpdate(params: schema.SessionNotification): Promise<void> {
    return this.sendNotification(schema.CLIENT_METHODS.session_update, params);
  }

  requestPermission(
    params: schema.RequestPermissionRequest,
  ): Promise<schema.RequestPermissionResponse> {
    return this.sendRequest(
      schema.CLIENT_METHODS.session_request_permission,
      params,
    );
  }

  readTextFile(
    params: schema.ReadTextFileRequest,
  ): Promise<schema.ReadTextFileResponse> {
    return this.sendRequest(schema.CLIENT_METHODS.fs_read_text_file, params);
  }

  writeTextFile(
    params: schema.WriteTextFileRequest,
  ): Promise<schema.WriteTextFileResponse> {
    return this.sendRequest<
      schema.WriteTextFileRequest,
      schema.WriteTextFileResponse
    >(schema.CLIENT_METHODS.fs_write_text_file, params, emptyObjectResponse);
  }

  createTerminal(
    params: schema.CreateTerminalRequest,
  ): Promise<TerminalHandle> {
    return this.sendRequest<
      schema.CreateTerminalRequest,
      schema.CreateTerminalResponse,
      TerminalHandle
    >(
      schema.CLIENT_METHODS.terminal_create,
      params,
      (response) =>
        new TerminalHandle(response.terminalId, params.sessionId, {
          sendRequest: (method, request, mapResponse) =>
            this.sendRequest(method, request, mapResponse),
        }),
    );
  }

  unstable_createElicitation(
    params: schema.CreateElicitationRequest,
  ): Promise<schema.CreateElicitationResponse> {
    return this.sendRequest(schema.CLIENT_METHODS.elicitation_create, params);
  }

  unstable_completeElicitation(
    params: schema.CompleteElicitationNotification,
  ): Promise<void> {
    return this.sendNotification(
      schema.CLIENT_METHODS.elicitation_complete,
      params,
    );
  }

  extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendRequest(method, params);
  }

  extNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    return this.sendNotification(method, params);
  }
}

export class ClientContext extends AcpConnectionContext implements Agent {
  initialize(
    params: schema.InitializeRequest,
  ): Promise<schema.InitializeResponse> {
    return this.sendRequest(schema.AGENT_METHODS.initialize, params);
  }

  newSession(
    params: schema.NewSessionRequest,
  ): Promise<schema.NewSessionResponse> {
    return this.sendRequest(schema.AGENT_METHODS.session_new, params);
  }

  buildSession(cwd: string): SessionBuilder {
    return new SessionBuilder(this, { cwd, mcpServers: [] });
  }

  buildSessionFrom(request: schema.NewSessionRequest): SessionBuilder {
    return new SessionBuilder(this, request);
  }

  attachSession(
    response: schema.NewSessionResponse,
    registrations: HandlerRegistration[] = [],
  ): ActiveSession {
    const updates = new AsyncQueue<ActiveSessionMessage>();
    const sessionRegistration = this.addDynamicHandler({
      handleMessage: (message) => {
        if (
          message.kind !== "notification" ||
          message.method !== schema.CLIENT_METHODS.session_update
        ) {
          return Handled.no(message);
        }

        const notification = validate.zSessionNotification.parse(
          message.params,
        );
        if (notification.sessionId !== response.sessionId) {
          return Handled.no(message);
        }

        updates.enqueue({
          kind: "session_update",
          notification,
          update: notification.update,
        });
        return Handled.yes();
      },
      describe: () => `active-session:${response.sessionId}`,
    });

    return new ActiveSession(this, response, updates, [
      sessionRegistration,
      ...registrations,
    ]);
  }

  loadSession(
    params: schema.LoadSessionRequest,
  ): Promise<schema.LoadSessionResponse> {
    return this.sendRequest<
      schema.LoadSessionRequest,
      schema.LoadSessionResponse
    >(schema.AGENT_METHODS.session_load, params, emptyObjectResponse);
  }

  unstable_forkSession(
    params: schema.ForkSessionRequest,
  ): Promise<schema.ForkSessionResponse> {
    return this.sendRequest(schema.AGENT_METHODS.session_fork, params);
  }

  listSessions(
    params: schema.ListSessionsRequest,
  ): Promise<schema.ListSessionsResponse> {
    return this.sendRequest(schema.AGENT_METHODS.session_list, params);
  }

  deleteSession(
    params: schema.DeleteSessionRequest,
  ): Promise<schema.DeleteSessionResponse> {
    return this.sendRequest<
      schema.DeleteSessionRequest,
      schema.DeleteSessionResponse
    >(schema.AGENT_METHODS.session_delete, params, emptyObjectResponse);
  }

  resumeSession(
    params: schema.ResumeSessionRequest,
  ): Promise<schema.ResumeSessionResponse> {
    return this.sendRequest(schema.AGENT_METHODS.session_resume, params);
  }

  closeSession(
    params: schema.CloseSessionRequest,
  ): Promise<schema.CloseSessionResponse> {
    return this.sendRequest<
      schema.CloseSessionRequest,
      schema.CloseSessionResponse
    >(schema.AGENT_METHODS.session_close, params, emptyObjectResponse);
  }

  setSessionMode(
    params: schema.SetSessionModeRequest,
  ): Promise<schema.SetSessionModeResponse> {
    return this.sendRequest<
      schema.SetSessionModeRequest,
      schema.SetSessionModeResponse
    >(schema.AGENT_METHODS.session_set_mode, params, emptyObjectResponse);
  }

  setSessionConfigOption(
    params: schema.SetSessionConfigOptionRequest,
  ): Promise<schema.SetSessionConfigOptionResponse> {
    return this.sendRequest(
      schema.AGENT_METHODS.session_set_config_option,
      params,
    );
  }

  authenticate(
    params: schema.AuthenticateRequest,
  ): Promise<schema.AuthenticateResponse> {
    return this.sendRequest<
      schema.AuthenticateRequest,
      schema.AuthenticateResponse
    >(schema.AGENT_METHODS.authenticate, params, emptyObjectResponse);
  }

  unstable_listProviders(
    params: schema.ListProvidersRequest,
  ): Promise<schema.ListProvidersResponse> {
    return this.sendRequest(schema.AGENT_METHODS.providers_list, params);
  }

  unstable_setProvider(
    params: schema.SetProviderRequest,
  ): Promise<schema.SetProviderResponse> {
    return this.sendRequest<
      schema.SetProviderRequest,
      schema.SetProviderResponse
    >(schema.AGENT_METHODS.providers_set, params, emptyObjectResponse);
  }

  unstable_disableProvider(
    params: schema.DisableProviderRequest,
  ): Promise<schema.DisableProviderResponse> {
    return this.sendRequest<
      schema.DisableProviderRequest,
      schema.DisableProviderResponse
    >(schema.AGENT_METHODS.providers_disable, params, emptyObjectResponse);
  }

  logout(params: schema.LogoutRequest): Promise<schema.LogoutResponse> {
    return this.sendRequest<schema.LogoutRequest, schema.LogoutResponse>(
      schema.AGENT_METHODS.logout,
      params,
      emptyObjectResponse,
    );
  }

  prompt(params: schema.PromptRequest): Promise<schema.PromptResponse> {
    return this.sendRequest(schema.AGENT_METHODS.session_prompt, params);
  }

  cancel(params: schema.CancelNotification): Promise<void> {
    return this.sendNotification(schema.AGENT_METHODS.session_cancel, params);
  }

  unstable_startNes(
    params: schema.StartNesRequest,
  ): Promise<schema.StartNesResponse> {
    return this.sendRequest(schema.AGENT_METHODS.nes_start, params);
  }

  unstable_suggestNes(
    params: schema.SuggestNesRequest,
  ): Promise<schema.SuggestNesResponse> {
    return this.sendRequest(schema.AGENT_METHODS.nes_suggest, params);
  }

  unstable_closeNes(
    params: schema.CloseNesRequest,
  ): Promise<schema.CloseNesResponse> {
    return this.sendRequest<schema.CloseNesRequest, schema.CloseNesResponse>(
      schema.AGENT_METHODS.nes_close,
      params,
      emptyObjectResponse,
    );
  }

  unstable_didOpenDocument(
    params: schema.DidOpenDocumentNotification,
  ): Promise<void> {
    return this.sendNotification(
      schema.AGENT_METHODS.document_did_open,
      params,
    );
  }

  unstable_didChangeDocument(
    params: schema.DidChangeDocumentNotification,
  ): Promise<void> {
    return this.sendNotification(
      schema.AGENT_METHODS.document_did_change,
      params,
    );
  }

  unstable_didCloseDocument(
    params: schema.DidCloseDocumentNotification,
  ): Promise<void> {
    return this.sendNotification(
      schema.AGENT_METHODS.document_did_close,
      params,
    );
  }

  unstable_didSaveDocument(
    params: schema.DidSaveDocumentNotification,
  ): Promise<void> {
    return this.sendNotification(
      schema.AGENT_METHODS.document_did_save,
      params,
    );
  }

  unstable_didFocusDocument(
    params: schema.DidFocusDocumentNotification,
  ): Promise<void> {
    return this.sendNotification(
      schema.AGENT_METHODS.document_did_focus,
      params,
    );
  }

  unstable_acceptNes(params: schema.AcceptNesNotification): Promise<void> {
    return this.sendNotification(schema.AGENT_METHODS.nes_accept, params);
  }

  unstable_rejectNes(params: schema.RejectNesNotification): Promise<void> {
    return this.sendNotification(schema.AGENT_METHODS.nes_reject, params);
  }

  extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendRequest(method, params);
  }

  extNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    return this.sendNotification(method, params);
  }
}

class AsyncQueue<T> {
  private values: T[] = [];
  private waiters: Array<{
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  }> = [];
  private failed = false;
  private failure: unknown;

  enqueue(value: T): void {
    if (this.failed) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(value);
    } else {
      this.values.push(value);
    }
  }

  fail(error: unknown): void {
    if (this.failed) {
      return;
    }

    this.failed = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  next(): Promise<T> {
    if (this.values.length > 0) {
      return Promise.resolve(this.values.shift() as T);
    }

    if (this.failed) {
      return Promise.reject(this.failure);
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

export type ActiveSessionMessage =
  | {
      kind: "session_update";
      notification: schema.SessionNotification;
      update: schema.SessionUpdate;
    }
  | {
      kind: "stop";
      response: schema.PromptResponse;
      stopReason: schema.StopReason;
    };

export class SessionBuilder {
  private request: schema.NewSessionRequest;

  constructor(
    private cx: ClientContext,
    request: schema.NewSessionRequest,
  ) {
    this.request = {
      ...request,
      additionalDirectories: request.additionalDirectories
        ? [...request.additionalDirectories]
        : undefined,
      mcpServers: [...request.mcpServers],
    };
  }

  toRequest(): schema.NewSessionRequest {
    return {
      ...this.request,
      additionalDirectories: this.request.additionalDirectories
        ? [...this.request.additionalDirectories]
        : undefined,
      mcpServers: [...this.request.mcpServers],
    };
  }

  withAdditionalDirectories(additionalDirectories: string[]): this {
    this.request = {
      ...this.request,
      additionalDirectories: [...additionalDirectories],
    };
    return this;
  }

  withMcpServer(mcpServer: schema.McpServer): this {
    this.request = {
      ...this.request,
      mcpServers: [...this.request.mcpServers, mcpServer],
    };
    return this;
  }

  async startSession(): Promise<ActiveSession> {
    const response = await this.cx.newSession(this.toRequest());
    return this.cx.attachSession(response);
  }

  async runUntil<T>(
    op: (session: ActiveSession) => MaybePromise<T>,
  ): Promise<T> {
    const session = await this.startSession();
    try {
      return await op(session);
    } finally {
      session.dispose();
    }
  }
}

export class ActiveSession {
  constructor(
    private cx: ClientContext,
    private newSessionResponse: schema.NewSessionResponse,
    private updates: {
      enqueue(value: ActiveSessionMessage): void;
      fail(error: unknown): void;
      next(): Promise<ActiveSessionMessage>;
    },
    private registrations: HandlerRegistration[],
  ) {}

  get sessionId(): schema.SessionId {
    return this.newSessionResponse.sessionId;
  }

  get modes(): schema.SessionModeState | null | undefined {
    return this.newSessionResponse.modes;
  }

  get meta(): { [key: string]: unknown } | null | undefined {
    return this.newSessionResponse._meta;
  }

  response(): schema.NewSessionResponse {
    return this.newSessionResponse;
  }

  sendPrompt(
    prompt: string | schema.ContentBlock | Array<schema.ContentBlock>,
  ): Promise<schema.PromptResponse> {
    const response = this.cx.prompt({
      sessionId: this.sessionId,
      prompt: this.promptBlocks(prompt),
    });
    void response.then(
      (value) => {
        this.updates.enqueue({
          kind: "stop",
          response: value,
          stopReason: value.stopReason,
        });
      },
      (error) => {
        this.updates.fail(error);
      },
    );
    return response;
  }

  readUpdate(): Promise<ActiveSessionMessage> {
    return this.updates.next();
  }

  async readToString(): Promise<string> {
    let output = "";
    for (;;) {
      const message = await this.readUpdate();
      if (message.kind === "stop") {
        return output;
      }

      const { update } = message;
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ) {
        output += update.content.text;
      }
    }
  }

  dispose(): void {
    for (const registration of this.registrations.splice(0)) {
      registration.dispose();
    }
    this.updates.fail(new Error("Active session disposed"));
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  private promptBlocks(
    prompt: string | schema.ContentBlock | Array<schema.ContentBlock>,
  ): Array<schema.ContentBlock> {
    if (typeof prompt === "string") {
      return [{ type: "text", text: prompt }];
    }

    if (Array.isArray(prompt)) {
      return prompt;
    }

    return [prompt];
  }
}

export type AcpAppOptions = {
  name?: string;
};

export type ParamsParser<Params> =
  | {
      parse(params: unknown): Params;
    }
  | ((params: unknown) => Params);

export type AgentHandlerContext<Params> = {
  params: Params;
  client: AgentContext;
};

export type ClientHandlerContext<Params> = {
  params: Params;
  agent: ClientContext;
};

export type AcpRequestRoute<Params, Response, Cx> = {
  kind: "request";
  method: string;
  params?: ParamsParser<Params>;
  handler(context: Cx): MaybePromise<Response>;
};

export type AcpNotificationRoute<Params, Cx> = {
  kind: "notification";
  method: string;
  params?: ParamsParser<Params>;
  handler(context: Cx): MaybePromise<void>;
};

export type AgentRequestHandler<Params, Response> = (
  context: AgentHandlerContext<Params>,
) => MaybePromise<Response>;

export type AgentNotificationHandler<Params> = (
  context: AgentHandlerContext<Params>,
) => MaybePromise<void>;

export type ClientRequestHandler<Params, Response> = (
  context: ClientHandlerContext<Params>,
) => MaybePromise<Response>;

export type ClientNotificationHandler<Params> = (
  context: ClientHandlerContext<Params>,
) => MaybePromise<void>;

export type AgentRequestRoute<Params, Response> = AcpRequestRoute<
  Params,
  Response,
  AgentHandlerContext<Params>
>;

export type AgentNotificationRoute<Params> = AcpNotificationRoute<
  Params,
  AgentHandlerContext<Params>
>;

export type ClientRequestRoute<Params, Response> = AcpRequestRoute<
  Params,
  Response,
  ClientHandlerContext<Params>
>;

export type ClientNotificationRoute<Params> = AcpNotificationRoute<
  Params,
  ClientHandlerContext<Params>
>;

function parseParams<Params>(
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

function agentHandlerContext<Params>(
  params: Params,
  client: AgentContext,
): AgentHandlerContext<Params> {
  return {
    params,
    client,
  };
}

function clientHandlerContext<Params>(
  params: Params,
  agent: ClientContext,
): ClientHandlerContext<Params> {
  return {
    params,
    agent,
  };
}

const appBuilder = Symbol("appBuilder");

export function agent(options?: AcpAppOptions): AgentApp {
  return new AgentApp(options);
}

export class AgentApp {
  private readonly builder = Connection.builder();

  constructor(options: AcpAppOptions = {}) {
    if (options.name) {
      this.builder.name(options.name);
    }
  }

  [appBuilder](): ConnectionBuilder {
    return this.builder;
  }

  connect(stream: Stream): Connection;
  connect(client: ClientApp): Connection;
  connect(target: Stream | ClientApp): Connection {
    return this.connectTarget(target);
  }

  connectWith<T>(
    stream: Stream,
    op: (cx: AgentContext) => MaybePromise<T>,
  ): Promise<T>;
  connectWith<T>(
    client: ClientApp,
    op: (cx: AgentContext) => MaybePromise<T>,
  ): Promise<T>;
  connectWith<T>(
    target: Stream | ClientApp,
    op: (cx: AgentContext) => MaybePromise<T>,
  ): Promise<T> {
    return this.connectTarget(target).runUntil((cx) =>
      op(new AgentContext(cx)),
    );
  }

  route<Params, Response>(route: AgentRequestRoute<Params, Response>): this;
  route<Params>(route: AgentNotificationRoute<Params>): this;
  route<Params, Response>(
    route: AgentRequestRoute<Params, Response> | AgentNotificationRoute<Params>,
  ): this {
    if (route.kind === "request") {
      return this.request(route.method, route.params, route.handler);
    }

    return this.notification(route.method, route.params, route.handler);
  }

  initialize(
    handler: AgentRequestHandler<
      schema.InitializeRequest,
      schema.InitializeResponse
    >,
  ): this {
    return this.request(
      schema.AGENT_METHODS.initialize,
      (params) => validate.zInitializeRequest.parse(params),
      handler,
    );
  }

  newSession(
    handler: AgentRequestHandler<
      schema.NewSessionRequest,
      schema.NewSessionResponse
    >,
  ): this {
    return this.request(
      schema.AGENT_METHODS.session_new,
      (params) => validate.zNewSessionRequest.parse(params),
      handler,
    );
  }

  loadSession(
    handler: AgentRequestHandler<
      schema.LoadSessionRequest,
      schema.LoadSessionResponse
    >,
  ): this {
    return this.request(
      schema.AGENT_METHODS.session_load,
      (params) => validate.zLoadSessionRequest.parse(params),
      handler,
      emptyObjectResponse,
    );
  }

  unstable_forkSession(
    handler: AgentRequestHandler<
      schema.ForkSessionRequest,
      schema.ForkSessionResponse
    >,
  ): this {
    return this.request(
      schema.AGENT_METHODS.session_fork,
      (params) => validate.zForkSessionRequest.parse(params),
      handler,
    );
  }

  listSessions(
    handler: AgentRequestHandler<
      schema.ListSessionsRequest,
      schema.ListSessionsResponse
    >,
  ): this {
    return this.request(
      schema.AGENT_METHODS.session_list,
      (params) => validate.zListSessionsRequest.parse(params),
      handler,
    );
  }

  deleteSession(
    handler: AgentRequestHandler<
      schema.DeleteSessionRequest,
      schema.DeleteSessionResponse | void
    >,
  ): this {
    return this.request(
      schema.AGENT_METHODS.session_delete,
      (params) => validate.zDeleteSessionRequest.parse(params),
      handler,
      emptyObjectResponse,
    );
  }

  resumeSession(
    handler: AgentRequestHandler<
      schema.ResumeSessionRequest,
      schema.ResumeSessionResponse
    >,
  ): this {
    return this.request(
      schema.AGENT_METHODS.session_resume,
      (params) => validate.zResumeSessionRequest.parse(params),
      handler,
    );
  }

  closeSession(
    handler: AgentRequestHandler<
      schema.CloseSessionRequest,
      schema.CloseSessionResponse | void
    >,
  ): this {
    return this.request(
      schema.AGENT_METHODS.session_close,
      (params) => validate.zCloseSessionRequest.parse(params),
      handler,
      emptyObjectResponse,
    );
  }

  setSessionMode(
    handler: AgentRequestHandler<
      schema.SetSessionModeRequest,
      schema.SetSessionModeResponse | void
    >,
  ): this {
    return this.request(
      schema.AGENT_METHODS.session_set_mode,
      (params) => validate.zSetSessionModeRequest.parse(params),
      handler,
      emptyObjectResponse,
    );
  }

  setSessionConfigOption(
    handler: AgentRequestHandler<
      schema.SetSessionConfigOptionRequest,
      schema.SetSessionConfigOptionResponse
    >,
  ): this {
    return this.request(
      schema.AGENT_METHODS.session_set_config_option,
      (params) => validate.zSetSessionConfigOptionRequest.parse(params),
      handler,
    );
  }

  authenticate(
    handler: AgentRequestHandler<
      schema.AuthenticateRequest,
      schema.AuthenticateResponse | void
    >,
  ): this {
    return this.request(
      schema.AGENT_METHODS.authenticate,
      (params) => validate.zAuthenticateRequest.parse(params),
      handler,
      emptyObjectResponse,
    );
  }

  unstable_listProviders(
    handler: AgentRequestHandler<
      schema.ListProvidersRequest,
      schema.ListProvidersResponse
    >,
  ): this {
    return this.request(
      schema.AGENT_METHODS.providers_list,
      (params) => validate.zListProvidersRequest.parse(params),
      handler,
    );
  }

  unstable_setProvider(
    handler: AgentRequestHandler<
      schema.SetProviderRequest,
      schema.SetProviderResponse | void
    >,
  ): this {
    return this.request(
      schema.AGENT_METHODS.providers_set,
      (params) => validate.zSetProviderRequest.parse(params),
      handler,
      emptyObjectResponse,
    );
  }

  unstable_disableProvider(
    handler: AgentRequestHandler<
      schema.DisableProviderRequest,
      schema.DisableProviderResponse | void
    >,
  ): this {
    return this.request(
      schema.AGENT_METHODS.providers_disable,
      (params) => validate.zDisableProviderRequest.parse(params),
      handler,
      emptyObjectResponse,
    );
  }

  logout(
    handler: AgentRequestHandler<
      schema.LogoutRequest,
      schema.LogoutResponse | void
    >,
  ): this {
    return this.request(
      schema.AGENT_METHODS.logout,
      (params) => validate.zLogoutRequest.parse(params),
      handler,
      emptyObjectResponse,
    );
  }

  prompt(
    handler: AgentRequestHandler<schema.PromptRequest, schema.PromptResponse>,
  ): this {
    return this.request(
      schema.AGENT_METHODS.session_prompt,
      (params) => validate.zPromptRequest.parse(params),
      handler,
    );
  }

  cancel(handler: AgentNotificationHandler<schema.CancelNotification>): this {
    return this.notification(
      schema.AGENT_METHODS.session_cancel,
      (params) => validate.zCancelNotification.parse(params),
      handler,
    );
  }

  unstable_startNes(
    handler: AgentRequestHandler<
      schema.StartNesRequest,
      schema.StartNesResponse
    >,
  ): this {
    return this.request(
      schema.AGENT_METHODS.nes_start,
      (params) => validate.zStartNesRequest.parse(params),
      handler,
    );
  }

  unstable_suggestNes(
    handler: AgentRequestHandler<
      schema.SuggestNesRequest,
      schema.SuggestNesResponse
    >,
  ): this {
    return this.request(
      schema.AGENT_METHODS.nes_suggest,
      (params) => validate.zSuggestNesRequest.parse(params),
      handler,
    );
  }

  unstable_closeNes(
    handler: AgentRequestHandler<
      schema.CloseNesRequest,
      schema.CloseNesResponse | void
    >,
  ): this {
    return this.request(
      schema.AGENT_METHODS.nes_close,
      (params) => validate.zCloseNesRequest.parse(params),
      handler,
      emptyObjectResponse,
    );
  }

  unstable_didOpenDocument(
    handler: AgentNotificationHandler<schema.DidOpenDocumentNotification>,
  ): this {
    return this.notification(
      schema.AGENT_METHODS.document_did_open,
      (params) => validate.zDidOpenDocumentNotification.parse(params),
      handler,
    );
  }

  unstable_didChangeDocument(
    handler: AgentNotificationHandler<schema.DidChangeDocumentNotification>,
  ): this {
    return this.notification(
      schema.AGENT_METHODS.document_did_change,
      (params) => validate.zDidChangeDocumentNotification.parse(params),
      handler,
    );
  }

  unstable_didCloseDocument(
    handler: AgentNotificationHandler<schema.DidCloseDocumentNotification>,
  ): this {
    return this.notification(
      schema.AGENT_METHODS.document_did_close,
      (params) => validate.zDidCloseDocumentNotification.parse(params),
      handler,
    );
  }

  unstable_didSaveDocument(
    handler: AgentNotificationHandler<schema.DidSaveDocumentNotification>,
  ): this {
    return this.notification(
      schema.AGENT_METHODS.document_did_save,
      (params) => validate.zDidSaveDocumentNotification.parse(params),
      handler,
    );
  }

  unstable_didFocusDocument(
    handler: AgentNotificationHandler<schema.DidFocusDocumentNotification>,
  ): this {
    return this.notification(
      schema.AGENT_METHODS.document_did_focus,
      (params) => validate.zDidFocusDocumentNotification.parse(params),
      handler,
    );
  }

  unstable_acceptNes(
    handler: AgentNotificationHandler<schema.AcceptNesNotification>,
  ): this {
    return this.notification(
      schema.AGENT_METHODS.nes_accept,
      (params) => validate.zAcceptNesNotification.parse(params),
      handler,
    );
  }

  unstable_rejectNes(
    handler: AgentNotificationHandler<schema.RejectNesNotification>,
  ): this {
    return this.notification(
      schema.AGENT_METHODS.nes_reject,
      (params) => validate.zRejectNesNotification.parse(params),
      handler,
    );
  }

  private request<Params, Response, WireResponse = Response>(
    method: string,
    parser: ParamsParser<Params> | undefined,
    handler: AgentRequestHandler<Params, Response>,
    mapResponse?: (response: Response) => WireResponse,
  ): this {
    this.builder.onReceiveRequest(
      method,
      (params) => parseParams(parser, params),
      async (params, responder, cx) => {
        const response = await handler(
          agentHandlerContext(params, new AgentContext(cx)),
        );
        await responder.respond(
          (mapResponse ? mapResponse(response) : response) as WireResponse,
        );
      },
    );
    return this;
  }

  private notification<Params>(
    method: string,
    parser: ParamsParser<Params> | undefined,
    handler: AgentNotificationHandler<Params>,
  ): this {
    this.builder.onReceiveNotification(
      method,
      (params) => parseParams(parser, params),
      (params, cx) =>
        handler(agentHandlerContext(params, new AgentContext(cx))),
    );
    return this;
  }

  private connectTarget(target: Stream | ClientApp): Connection {
    if (isStream(target)) {
      return this.builder.connect(target);
    }

    const [thisStream, peerStream] = memoryStreamPair();
    const peerConnection = target.connect(peerStream);
    const connection = this.builder.connect(thisStream);
    void connection.closed.then(() => peerConnection.close());
    void peerConnection.closed.then(() => connection.close());
    return connection;
  }
}

export function client(options?: AcpAppOptions): ClientApp {
  return new ClientApp(options);
}

export class ClientApp {
  private readonly builder = Connection.builder();

  constructor(options: AcpAppOptions = {}) {
    if (options.name) {
      this.builder.name(options.name);
    }
    this.builder.withHandler({
      handleMessage: (message) =>
        Handled.no(message, isRetryableClientSessionNotification(message)),
      describe: () => "client-session-retry",
    });
  }

  [appBuilder](): ConnectionBuilder {
    return this.builder;
  }

  connect(stream: Stream): Connection;
  connect(agent: AgentApp): Connection;
  connect(target: Stream | AgentApp): Connection {
    return this.connectTarget(target);
  }

  connectWith<T>(
    stream: Stream,
    op: (cx: ClientContext) => MaybePromise<T>,
  ): Promise<T>;
  connectWith<T>(
    agent: AgentApp,
    op: (cx: ClientContext) => MaybePromise<T>,
  ): Promise<T>;
  connectWith<T>(
    target: Stream | AgentApp,
    op: (cx: ClientContext) => MaybePromise<T>,
  ): Promise<T> {
    return this.connectTarget(target).runUntil((cx) =>
      op(new ClientContext(cx)),
    );
  }

  route<Params, Response>(route: ClientRequestRoute<Params, Response>): this;
  route<Params>(route: ClientNotificationRoute<Params>): this;
  route<Params, Response>(
    route:
      | ClientRequestRoute<Params, Response>
      | ClientNotificationRoute<Params>,
  ): this {
    if (route.kind === "request") {
      return this.request(route.method, route.params, route.handler);
    }

    return this.notification(route.method, route.params, route.handler);
  }

  requestPermission(
    handler: ClientRequestHandler<
      schema.RequestPermissionRequest,
      schema.RequestPermissionResponse
    >,
  ): this {
    return this.request(
      schema.CLIENT_METHODS.session_request_permission,
      (params) => validate.zRequestPermissionRequest.parse(params),
      handler,
    );
  }

  sessionUpdate(
    handler: ClientNotificationHandler<schema.SessionNotification>,
  ): this {
    this.builder.withHandler({
      handleMessage: async (message, cx) => {
        if (
          message.kind !== "notification" ||
          message.method !== schema.CLIENT_METHODS.session_update
        ) {
          return Handled.no(message);
        }

        const params = validate.zSessionNotification.parse(message.params);
        await handler(clientHandlerContext(params, new ClientContext(cx)));
        return Handled.no(message);
      },
      describe: () => "client-session-update",
    });
    return this;
  }

  writeTextFile(
    handler: ClientRequestHandler<
      schema.WriteTextFileRequest,
      schema.WriteTextFileResponse
    >,
  ): this {
    return this.request(
      schema.CLIENT_METHODS.fs_write_text_file,
      (params) => validate.zWriteTextFileRequest.parse(params),
      handler,
      emptyObjectResponse,
    );
  }

  readTextFile(
    handler: ClientRequestHandler<
      schema.ReadTextFileRequest,
      schema.ReadTextFileResponse
    >,
  ): this {
    return this.request(
      schema.CLIENT_METHODS.fs_read_text_file,
      (params) => validate.zReadTextFileRequest.parse(params),
      handler,
    );
  }

  createTerminal(
    handler: ClientRequestHandler<
      schema.CreateTerminalRequest,
      schema.CreateTerminalResponse
    >,
  ): this {
    return this.request(
      schema.CLIENT_METHODS.terminal_create,
      (params) => validate.zCreateTerminalRequest.parse(params),
      handler,
    );
  }

  terminalOutput(
    handler: ClientRequestHandler<
      schema.TerminalOutputRequest,
      schema.TerminalOutputResponse
    >,
  ): this {
    return this.request(
      schema.CLIENT_METHODS.terminal_output,
      (params) => validate.zTerminalOutputRequest.parse(params),
      handler,
    );
  }

  releaseTerminal(
    handler: ClientRequestHandler<
      schema.ReleaseTerminalRequest,
      schema.ReleaseTerminalResponse | void
    >,
  ): this {
    return this.request(
      schema.CLIENT_METHODS.terminal_release,
      (params) => validate.zReleaseTerminalRequest.parse(params),
      handler,
      emptyObjectResponse,
    );
  }

  waitForTerminalExit(
    handler: ClientRequestHandler<
      schema.WaitForTerminalExitRequest,
      schema.WaitForTerminalExitResponse
    >,
  ): this {
    return this.request(
      schema.CLIENT_METHODS.terminal_wait_for_exit,
      (params) => validate.zWaitForTerminalExitRequest.parse(params),
      handler,
    );
  }

  killTerminal(
    handler: ClientRequestHandler<
      schema.KillTerminalRequest,
      schema.KillTerminalResponse | void
    >,
  ): this {
    return this.request(
      schema.CLIENT_METHODS.terminal_kill,
      (params) => validate.zKillTerminalRequest.parse(params),
      handler,
      emptyObjectResponse,
    );
  }

  unstable_createElicitation(
    handler: ClientRequestHandler<
      schema.CreateElicitationRequest,
      schema.CreateElicitationResponse
    >,
  ): this {
    return this.request(
      schema.CLIENT_METHODS.elicitation_create,
      (params) => validate.zCreateElicitationRequest.parse(params),
      handler,
    );
  }

  unstable_completeElicitation(
    handler: ClientNotificationHandler<schema.CompleteElicitationNotification>,
  ): this {
    return this.notification(
      schema.CLIENT_METHODS.elicitation_complete,
      (params) => validate.zCompleteElicitationNotification.parse(params),
      handler,
    );
  }

  private request<Params, Response, WireResponse = Response>(
    method: string,
    parser: ParamsParser<Params> | undefined,
    handler: ClientRequestHandler<Params, Response>,
    mapResponse?: (response: Response) => WireResponse,
  ): this {
    this.builder.onReceiveRequest(
      method,
      (params) => parseParams(parser, params),
      async (params, responder, cx) => {
        const response = await handler(
          clientHandlerContext(params, new ClientContext(cx)),
        );
        await responder.respond(
          (mapResponse ? mapResponse(response) : response) as WireResponse,
        );
      },
    );
    return this;
  }

  private notification<Params>(
    method: string,
    parser: ParamsParser<Params> | undefined,
    handler: ClientNotificationHandler<Params>,
  ): this {
    this.builder.onReceiveNotification(
      method,
      (params) => parseParams(parser, params),
      (params, cx) =>
        handler(clientHandlerContext(params, new ClientContext(cx))),
    );
    return this;
  }

  private connectTarget(target: Stream | AgentApp): Connection {
    if (isStream(target)) {
      return this.builder.connect(target);
    }

    const [thisStream, peerStream] = memoryStreamPair();
    const peerConnection = target.connect(peerStream);
    const connection = this.builder.connect(thisStream);
    void connection.closed.then(() => peerConnection.close());
    void peerConnection.closed.then(() => connection.close());
    return connection;
  }
}

const knownAgentMethods = new Set<string>(Object.values(schema.AGENT_METHODS));
const knownClientMethods = new Set<string>(
  Object.values(schema.CLIENT_METHODS),
);

function legacyAgentApp(implementation: Agent): AgentApp {
  const app = agent()
    .initialize((c) => implementation.initialize(c.params))
    .newSession((c) => implementation.newSession(c.params))
    .authenticate(
      async (c) => (await implementation.authenticate(c.params)) ?? {},
    )
    .prompt((c) => implementation.prompt(c.params))
    .cancel((c) => implementation.cancel(c.params));

  if (implementation.loadSession) {
    app.loadSession((c) => implementation.loadSession!(c.params));
  }
  if (implementation.listSessions) {
    app.listSessions((c) => implementation.listSessions!(c.params));
  }
  if (implementation.deleteSession) {
    app.deleteSession(
      async (c) => (await implementation.deleteSession!(c.params)) ?? {},
    );
  }
  if (implementation.unstable_forkSession) {
    app.unstable_forkSession((c) =>
      implementation.unstable_forkSession!(c.params),
    );
  }
  if (implementation.resumeSession) {
    app.resumeSession((c) => implementation.resumeSession!(c.params));
  }
  if (implementation.closeSession) {
    app.closeSession(
      async (c) => (await implementation.closeSession!(c.params)) ?? {},
    );
  }
  if (implementation.setSessionMode) {
    app.setSessionMode(
      async (c) => (await implementation.setSessionMode!(c.params)) ?? {},
    );
  }
  if (implementation.setSessionConfigOption) {
    app.setSessionConfigOption((c) =>
      implementation.setSessionConfigOption!(c.params),
    );
  }
  if (implementation.unstable_listProviders) {
    app.unstable_listProviders((c) =>
      implementation.unstable_listProviders!(c.params),
    );
  }
  if (implementation.unstable_setProvider) {
    app.unstable_setProvider(
      async (c) => (await implementation.unstable_setProvider!(c.params)) ?? {},
    );
  }
  if (implementation.unstable_disableProvider) {
    app.unstable_disableProvider(
      async (c) =>
        (await implementation.unstable_disableProvider!(c.params)) ?? {},
    );
  }
  if (implementation.logout) {
    app.logout(async (c) => (await implementation.logout!(c.params)) ?? {});
  }
  if (implementation.unstable_startNes) {
    app.unstable_startNes((c) => implementation.unstable_startNes!(c.params));
  }
  if (implementation.unstable_suggestNes) {
    app.unstable_suggestNes((c) =>
      implementation.unstable_suggestNes!(c.params),
    );
  }
  if (implementation.unstable_closeNes) {
    app.unstable_closeNes(
      async (c) => (await implementation.unstable_closeNes!(c.params)) ?? {},
    );
  }
  if (implementation.unstable_didOpenDocument) {
    app.unstable_didOpenDocument((c) =>
      implementation.unstable_didOpenDocument!(c.params),
    );
  }
  if (implementation.unstable_didChangeDocument) {
    app.unstable_didChangeDocument((c) =>
      implementation.unstable_didChangeDocument!(c.params),
    );
  }
  if (implementation.unstable_didCloseDocument) {
    app.unstable_didCloseDocument((c) =>
      implementation.unstable_didCloseDocument!(c.params),
    );
  }
  if (implementation.unstable_didSaveDocument) {
    app.unstable_didSaveDocument((c) =>
      implementation.unstable_didSaveDocument!(c.params),
    );
  }
  if (implementation.unstable_didFocusDocument) {
    app.unstable_didFocusDocument((c) =>
      implementation.unstable_didFocusDocument!(c.params),
    );
  }
  if (implementation.unstable_acceptNes) {
    app.unstable_acceptNes((c) => implementation.unstable_acceptNes!(c.params));
  }
  if (implementation.unstable_rejectNes) {
    app.unstable_rejectNes((c) => implementation.unstable_rejectNes!(c.params));
  }

  if (implementation.extMethod) {
    app[appBuilder]().withHandler({
      handleMessage: async (message) => {
        if (
          message.kind !== "request" ||
          knownAgentMethods.has(message.method)
        ) {
          return Handled.no(message);
        }

        await message.responder.respond(
          await implementation.extMethod!(
            message.method,
            message.params as Record<string, unknown>,
          ),
        );
        return Handled.yes();
      },
      describe: () => "legacy-agent-extension-request",
    });
  }
  if (implementation.extNotification) {
    app[appBuilder]().withHandler({
      handleMessage: async (message) => {
        if (
          message.kind !== "notification" ||
          knownAgentMethods.has(message.method)
        ) {
          return Handled.no(message);
        }

        await implementation.extNotification!(
          message.method,
          message.params as Record<string, unknown>,
        );
        return Handled.yes();
      },
      describe: () => "legacy-agent-extension-notification",
    });
  }

  return app;
}

function legacyClientApp(implementation: Client): ClientApp {
  const app = client()
    .requestPermission((c) => implementation.requestPermission(c.params))
    .sessionUpdate((c) => implementation.sessionUpdate(c.params))
    .writeTextFile(
      async (c) => (await implementation.writeTextFile?.(c.params)) ?? {},
    )
    .readTextFile(
      async (c) =>
        (await implementation.readTextFile?.(
          c.params,
        )) as schema.ReadTextFileResponse,
    )
    .createTerminal(
      async (c) =>
        (await implementation.createTerminal?.(
          c.params,
        )) as schema.CreateTerminalResponse,
    )
    .terminalOutput(
      async (c) =>
        (await implementation.terminalOutput?.(
          c.params,
        )) as schema.TerminalOutputResponse,
    )
    .releaseTerminal(
      async (c) => (await implementation.releaseTerminal?.(c.params)) ?? {},
    )
    .waitForTerminalExit(
      async (c) =>
        (await implementation.waitForTerminalExit?.(
          c.params,
        )) as schema.WaitForTerminalExitResponse,
    )
    .killTerminal(
      async (c) => (await implementation.killTerminal?.(c.params)) ?? {},
    );

  if (implementation.unstable_createElicitation) {
    app.unstable_createElicitation((c) =>
      implementation.unstable_createElicitation!(c.params),
    );
  }
  if (implementation.unstable_completeElicitation) {
    app.unstable_completeElicitation((c) =>
      implementation.unstable_completeElicitation!(c.params),
    );
  }

  if (implementation.extMethod) {
    app[appBuilder]().withHandler({
      handleMessage: async (message) => {
        if (
          message.kind !== "request" ||
          knownClientMethods.has(message.method)
        ) {
          return Handled.no(message);
        }

        await message.responder.respond(
          await implementation.extMethod!(
            message.method,
            message.params as Record<string, unknown>,
          ),
        );
        return Handled.yes();
      },
      describe: () => "legacy-client-extension-request",
    });
  }
  if (implementation.extNotification) {
    app[appBuilder]().withHandler({
      handleMessage: async (message) => {
        if (
          message.kind !== "notification" ||
          knownClientMethods.has(message.method)
        ) {
          return Handled.no(message);
        }

        await implementation.extNotification!(
          message.method,
          message.params as Record<string, unknown>,
        );
        return Handled.yes();
      },
      describe: () => "legacy-client-extension-notification",
    });
  }

  return app;
}

/**
 * An agent-side connection to a client.
 *
 * This class provides the agent's view of an ACP connection, allowing
 * agents to communicate with clients. It implements the {@link Client} interface
 * to provide methods for requesting permissions, accessing the file system,
 * and sending session updates.
 *
 * See protocol docs: [Agent](https://agentclientprotocol.com/protocol/overview#agent)
 *
 * @deprecated Prefer {@link agent}, which registers typed handlers with a
 * single context object and supports direct app composition.
 */
export class AgentSideConnection {
  private connection: Connection;

  /**
   * Creates a new agent-side connection to a client.
   *
   * This establishes the communication channel from the agent's perspective
   * following the ACP specification.
   *
   * @param toAgent - A function that creates an Agent handler to process incoming client requests
   * @param stream - The bidirectional message stream for communication. Typically created using
   *                 {@link ndJsonStream} for stdio-based connections.
   *
   * See protocol docs: [Communication Model](https://agentclientprotocol.com/protocol/overview#communication-model)
   *
   * @deprecated Prefer `agent({ name }).connect(stream)`.
   */
  constructor(toAgent: (conn: AgentSideConnection) => Agent, stream: Stream) {
    this.connection = legacyAgentApp(toAgent(this)).connect(stream);
  }

  /**
   * Handles session update notifications from the agent.
   *
   * This is a notification endpoint (no response expected) that sends
   * real-time updates about session progress, including message chunks,
   * tool calls, and execution plans.
   *
   * Note: Clients SHOULD continue accepting tool call updates even after
   * sending a `session/cancel` notification, as the agent may send final
   * updates before responding with the cancelled stop reason.
   *
   * See protocol docs: [Agent Reports Output](https://agentclientprotocol.com/protocol/prompt-turn#3-agent-reports-output)
   */
  sessionUpdate(params: schema.SessionNotification): Promise<void> {
    return this.connection.sendNotification(
      schema.CLIENT_METHODS.session_update,
      params,
    );
  }

  /**
   * Requests permission from the user for a tool call operation.
   *
   * Called by the agent when it needs user authorization before executing
   * a potentially sensitive operation. The client should present the options
   * to the user and return their decision.
   *
   * If the client cancels the prompt turn via `session/cancel`, it MUST
   * respond to this request with `RequestPermissionOutcome::Cancelled`.
   *
   * See protocol docs: [Requesting Permission](https://agentclientprotocol.com/protocol/tool-calls#requesting-permission)
   */
  requestPermission(
    params: schema.RequestPermissionRequest,
  ): Promise<schema.RequestPermissionResponse> {
    return this.connection.sendRequest(
      schema.CLIENT_METHODS.session_request_permission,
      params,
    );
  }

  /**
   * Reads content from a text file in the client's file system.
   *
   * Only available if the client advertises the `fs.readTextFile` capability.
   * Allows the agent to access file contents within the client's environment.
   *
   * See protocol docs: [Client](https://agentclientprotocol.com/protocol/overview#client)
   */
  readTextFile(
    params: schema.ReadTextFileRequest,
  ): Promise<schema.ReadTextFileResponse> {
    return this.connection.sendRequest(
      schema.CLIENT_METHODS.fs_read_text_file,
      params,
    );
  }

  /**
   * Writes content to a text file in the client's file system.
   *
   * Only available if the client advertises the `fs.writeTextFile` capability.
   * Allows the agent to create or modify files within the client's environment.
   *
   * See protocol docs: [Client](https://agentclientprotocol.com/protocol/overview#client)
   */
  writeTextFile(
    params: schema.WriteTextFileRequest,
  ): Promise<schema.WriteTextFileResponse> {
    return this.connection.sendRequest<
      schema.WriteTextFileRequest,
      schema.WriteTextFileResponse
    >(schema.CLIENT_METHODS.fs_write_text_file, params, emptyObjectResponse);
  }

  /**
   * Executes a command in a new terminal.
   *
   * Returns a `TerminalHandle` that can be used to get output, wait for exit,
   * kill the command, or release the terminal.
   *
   * The terminal can also be embedded in tool calls by using its ID in
   * `ToolCallContent` with type "terminal".
   *
   * @param params - The terminal creation parameters
   * @returns A handle to control and monitor the terminal
   */
  createTerminal(
    params: schema.CreateTerminalRequest,
  ): Promise<TerminalHandle> {
    return this.connection.sendRequest<
      schema.CreateTerminalRequest,
      schema.CreateTerminalResponse,
      TerminalHandle
    >(
      schema.CLIENT_METHODS.terminal_create,
      params,
      (response) =>
        new TerminalHandle(
          response.terminalId,
          params.sessionId,
          this.connection,
        ),
    );
  }

  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Creates an elicitation to request input from the user.
   *
   * @experimental
   */
  unstable_createElicitation(
    params: schema.CreateElicitationRequest,
  ): Promise<schema.CreateElicitationResponse> {
    return this.connection.sendRequest(
      schema.CLIENT_METHODS.elicitation_create,
      params,
    );
  }

  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Notifies the client that a URL-based elicitation is complete.
   *
   * @experimental
   */
  unstable_completeElicitation(
    params: schema.CompleteElicitationNotification,
  ): Promise<void> {
    return this.connection.sendNotification(
      schema.CLIENT_METHODS.elicitation_complete,
      params,
    );
  }

  /**
   * Extension method
   *
   * Allows the Agent to send an arbitrary request that is not part of the ACP spec.
   */
  extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.connection.sendRequest(method, params);
  }

  /**
   * Extension notification
   *
   * Allows the Agent to send an arbitrary notification that is not part of the ACP spec.
   */
  extNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    return this.connection.sendNotification(method, params);
  }

  /**
   * AbortSignal that aborts when the connection closes.
   *
   * This signal can be used to:
   * - Listen for connection closure: `connection.signal.addEventListener('abort', () => {...})`
   * - Check connection status synchronously: `if (connection.signal.aborted) {...}`
   * - Pass to other APIs (fetch, setTimeout) for automatic cancellation
   *
   * The connection closes when the underlying stream ends, either normally or due to an error.
   *
   * @example
   * ```typescript
   * const connection = new AgentSideConnection(agent, stream);
   *
   * // Listen for closure
   * connection.signal.addEventListener('abort', () => {
   *   console.log('Connection closed - performing cleanup');
   * });
   *
   * // Check status
   * if (connection.signal.aborted) {
   *   console.log('Connection is already closed');
   * }
   *
   * // Pass to other APIs
   * fetch(url, { signal: connection.signal });
   * ```
   */
  get signal(): AbortSignal {
    return this.connection.signal;
  }

  /**
   * Promise that resolves when the connection closes.
   *
   * The connection closes when the underlying stream ends, either normally or due to an error.
   * Once closed, the connection cannot send or receive any more messages.
   *
   * This is useful for async/await style cleanup:
   *
   * @example
   * ```typescript
   * const connection = new AgentSideConnection(agent, stream);
   * await connection.closed;
   * console.log('Connection closed - performing cleanup');
   * ```
   */
  get closed(): Promise<void> {
    return this.connection.closed;
  }
}

/**
 * Handle for controlling and monitoring a terminal created via `createTerminal`.
 *
 * Provides methods to:
 * - Get current output without waiting
 * - Wait for command completion
 * - Kill the running command
 * - Release terminal resources
 *
 * **Important:** Always call `release()` when done with the terminal to free resources.

 * The terminal supports async disposal via `Symbol.asyncDispose` for automatic cleanup.

 * You can use `await using` to ensure the terminal is automatically released when it
 * goes out of scope.
 */
export class TerminalHandle {
  private sessionId: string;
  private connection: Pick<Connection, "sendRequest">;

  constructor(
    public id: string,
    sessionId: string,
    conn: Pick<Connection, "sendRequest">,
  ) {
    this.sessionId = sessionId;
    this.connection = conn;
  }

  /**
   * Gets the current terminal output without waiting for the command to exit.
   */
  currentOutput(): Promise<schema.TerminalOutputResponse> {
    return this.connection.sendRequest(schema.CLIENT_METHODS.terminal_output, {
      sessionId: this.sessionId,
      terminalId: this.id,
    });
  }

  /**
   * Waits for the terminal command to complete and returns its exit status.
   */
  waitForExit(): Promise<schema.WaitForTerminalExitResponse> {
    return this.connection.sendRequest(
      schema.CLIENT_METHODS.terminal_wait_for_exit,
      {
        sessionId: this.sessionId,
        terminalId: this.id,
      },
    );
  }

  /**
   * Kills the terminal command without releasing the terminal.
   *
   * The terminal remains valid after killing, allowing you to:
   * - Get the final output with `currentOutput()`
   * - Check the exit status
   * - Release the terminal when done
   *
   * Useful for implementing timeouts or cancellation.
   */
  kill(): Promise<schema.KillTerminalResponse> {
    return this.connection.sendRequest<
      schema.KillTerminalRequest,
      schema.KillTerminalResponse
    >(
      schema.CLIENT_METHODS.terminal_kill,
      {
        sessionId: this.sessionId,
        terminalId: this.id,
      },
      emptyObjectResponse,
    );
  }

  /**
   * Releases the terminal and frees all associated resources.
   *
   * If the command is still running, it will be killed.
   * After release, the terminal ID becomes invalid and cannot be used
   * with other terminal methods.
   *
   * Tool calls that already reference this terminal will continue to
   * display its output.
   *
   * **Important:** Always call this method when done with the terminal.
   */
  release(): Promise<schema.ReleaseTerminalResponse | void> {
    return this.connection.sendRequest<
      schema.ReleaseTerminalRequest,
      schema.ReleaseTerminalResponse | void
    >(
      schema.CLIENT_METHODS.terminal_release,
      {
        sessionId: this.sessionId,
        terminalId: this.id,
      },
      emptyObjectResponse,
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.release();
  }
}

/**
 * A client-side connection to an agent.
 *
 * This class provides the client's view of an ACP connection, allowing
 * clients (such as code editors) to communicate with agents. It implements
 * the {@link Agent} interface to provide methods for initializing sessions, sending
 * prompts, and managing the agent lifecycle.
 *
 * See protocol docs: [Client](https://agentclientprotocol.com/protocol/overview#client)
 *
 * @deprecated Prefer {@link client}, which registers typed handlers with a
 * single context object and supports `connectWith` and session helpers.
 */
export class ClientSideConnection implements Agent {
  private connection: Connection;

  /**
   * Creates a new client-side connection to an agent.
   *
   * This establishes the communication channel between a client and agent
   * following the ACP specification.
   *
   * @param toClient - A function that creates a Client handler to process incoming agent requests
   * @param stream - The bidirectional message stream for communication. Typically created using
   *                 {@link ndJsonStream} for stdio-based connections.
   *
   * See protocol docs: [Communication Model](https://agentclientprotocol.com/protocol/overview#communication-model)
   *
   * @deprecated Prefer `client({ name }).connectWith(stream, async (agent) => ...)`.
   */
  constructor(toClient: (agent: Agent) => Client, stream: Stream) {
    this.connection = legacyClientApp(toClient(this)).connect(stream);
  }

  /**
   * Establishes the connection with a client and negotiates protocol capabilities.
   *
   * This method is called once at the beginning of the connection to:
   * - Negotiate the protocol version to use
   * - Exchange capability information between client and agent
   * - Determine available authentication methods
   *
   * The agent should respond with its supported protocol version and capabilities.
   *
   * See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/initialization)
   */
  initialize(
    params: schema.InitializeRequest,
  ): Promise<schema.InitializeResponse> {
    return this.connection.sendRequest(schema.AGENT_METHODS.initialize, params);
  }

  /**
   * Creates a new conversation session with the agent.
   *
   * Sessions represent independent conversation contexts with their own history and state.
   *
   * The agent should:
   * - Create a new session context
   * - Connect to any specified MCP servers
   * - Return a unique session ID for future requests
   *
   * The request may include `additionalDirectories` to expand the session's filesystem
   * scope beyond `cwd` without changing the base for relative paths.
   *
   * May return an `auth_required` error if the agent requires authentication.
   *
   * See protocol docs: [Session Setup](https://agentclientprotocol.com/protocol/session-setup)
   */
  newSession(
    params: schema.NewSessionRequest,
  ): Promise<schema.NewSessionResponse> {
    return this.connection.sendRequest(
      schema.AGENT_METHODS.session_new,
      params,
    );
  }

  /**
   * Loads an existing session to resume a previous conversation.
   *
   * This method is only available if the agent advertises the `loadSession` capability.
   *
   * The agent should:
   * - Restore the session context and conversation history
   * - Connect to the specified MCP servers
   * - Stream the entire conversation history back to the client via notifications
   *
   * The request may include `additionalDirectories` to set the complete list of
   * additional workspace roots for the loaded session.
   *
   * See protocol docs: [Loading Sessions](https://agentclientprotocol.com/protocol/session-setup#loading-sessions)
   */
  loadSession(
    params: schema.LoadSessionRequest,
  ): Promise<schema.LoadSessionResponse> {
    return this.connection.sendRequest<
      schema.LoadSessionRequest,
      schema.LoadSessionResponse
    >(schema.AGENT_METHODS.session_load, params, emptyObjectResponse);
  }

  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Forks an existing session to create a new independent session.
   *
   * Creates a new session based on the context of an existing one, allowing
   * operations like generating summaries without affecting the original session's history.
   *
   * The request may include `additionalDirectories` to set the complete list of
   * additional workspace roots for the forked session.
   *
   * This method is only available if the agent advertises the `session.fork` capability.
   *
   * @experimental
   */
  unstable_forkSession(
    params: schema.ForkSessionRequest,
  ): Promise<schema.ForkSessionResponse> {
    return this.connection.sendRequest(
      schema.AGENT_METHODS.session_fork,
      params,
    );
  }

  /**
   * Lists existing sessions from the agent.
   *
   * This method is only available if the agent advertises the `listSessions` capability.
   *
   * Returns a list of sessions with metadata like session ID, working directory,
   * title, and last update time. Supports filtering by working directory,
   * `additionalDirectories`, and cursor-based pagination.
   */
  listSessions(
    params: schema.ListSessionsRequest,
  ): Promise<schema.ListSessionsResponse> {
    return this.connection.sendRequest(
      schema.AGENT_METHODS.session_list,
      params,
    );
  }

  /**
   * Deletes an existing session returned by `session/list`.
   *
   * This method is only available if the agent advertises the `sessionCapabilities.delete` capability.
   */
  deleteSession(
    params: schema.DeleteSessionRequest,
  ): Promise<schema.DeleteSessionResponse> {
    return this.connection.sendRequest<
      schema.DeleteSessionRequest,
      schema.DeleteSessionResponse
    >(schema.AGENT_METHODS.session_delete, params, emptyObjectResponse);
  }

  /**
   * Resumes an existing session without returning previous messages.
   *
   * This method is only available if the agent advertises the `session.resume` capability.
   *
   * The agent should resume the session context, allowing the conversation to continue
   * without replaying the message history (unlike `session/load`).
   *
   * The request may include `additionalDirectories` to set the complete list of
   * additional workspace roots for the resumed session.
   */
  resumeSession(
    params: schema.ResumeSessionRequest,
  ): Promise<schema.ResumeSessionResponse> {
    return this.connection.sendRequest(
      schema.AGENT_METHODS.session_resume,
      params,
    );
  }

  /**
   * Closes an active session and frees up any resources associated with it.
   *
   * This method is only available if the agent advertises the `session.close` capability.
   *
   * The agent must cancel any ongoing work (as if `session/cancel` was called)
   * and then free up any resources associated with the session.
   */
  closeSession(
    params: schema.CloseSessionRequest,
  ): Promise<schema.CloseSessionResponse> {
    return this.connection.sendRequest<
      schema.CloseSessionRequest,
      schema.CloseSessionResponse
    >(schema.AGENT_METHODS.session_close, params, emptyObjectResponse);
  }

  /**
   * Sets the operational mode for a session.
   *
   * Allows switching between different agent modes (e.g., "ask", "architect", "code")
   * that affect system prompts, tool availability, and permission behaviors.
   *
   * The mode must be one of the modes advertised in `availableModes` during session
   * creation or loading. Agents may also change modes autonomously and notify the
   * client via `current_mode_update` notifications.
   *
   * This method can be called at any time during a session, whether the Agent is
   * idle or actively generating a turn.
   *
   * See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/session-modes)
   */
  setSessionMode(
    params: schema.SetSessionModeRequest,
  ): Promise<schema.SetSessionModeResponse> {
    return this.connection.sendRequest<
      schema.SetSessionModeRequest,
      schema.SetSessionModeResponse
    >(schema.AGENT_METHODS.session_set_mode, params, emptyObjectResponse);
  }

  /**
   * Set a configuration option for a given session.
   *
   * The response contains the full set of configuration options and their current values,
   * as changing one option may affect the available values or state of other options.
   */
  setSessionConfigOption(
    params: schema.SetSessionConfigOptionRequest,
  ): Promise<schema.SetSessionConfigOptionResponse> {
    return this.connection.sendRequest(
      schema.AGENT_METHODS.session_set_config_option,
      params,
    );
  }

  /**
   * Authenticates the client using the specified authentication method.
   *
   * Called when the agent requires authentication before allowing session creation.
   * The client provides the authentication method ID that was advertised during initialization.
   *
   * After successful authentication, the client can proceed to create sessions with
   * `newSession` without receiving an `auth_required` error.
   *
   * See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/initialization)
   */
  authenticate(
    params: schema.AuthenticateRequest,
  ): Promise<schema.AuthenticateResponse> {
    return this.connection.sendRequest<
      schema.AuthenticateRequest,
      schema.AuthenticateResponse
    >(schema.AGENT_METHODS.authenticate, params, emptyObjectResponse);
  }

  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Lists providers that can be configured by the client.
   *
   * This method is only available if the agent advertises the `providers` capability.
   *
   * @experimental
   */
  unstable_listProviders(
    params: schema.ListProvidersRequest,
  ): Promise<schema.ListProvidersResponse> {
    return this.connection.sendRequest(
      schema.AGENT_METHODS.providers_list,
      params,
    );
  }

  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Replaces the configuration for a provider.
   *
   * This method is only available if the agent advertises the `providers` capability.
   *
   * @experimental
   */
  unstable_setProvider(
    params: schema.SetProviderRequest,
  ): Promise<schema.SetProviderResponse> {
    return this.connection.sendRequest<
      schema.SetProviderRequest,
      schema.SetProviderResponse
    >(schema.AGENT_METHODS.providers_set, params, emptyObjectResponse);
  }

  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Disables a provider.
   *
   * This method is only available if the agent advertises the `providers` capability.
   *
   * @experimental
   */
  unstable_disableProvider(
    params: schema.DisableProviderRequest,
  ): Promise<schema.DisableProviderResponse> {
    return this.connection.sendRequest<
      schema.DisableProviderRequest,
      schema.DisableProviderResponse
    >(schema.AGENT_METHODS.providers_disable, params, emptyObjectResponse);
  }

  /**
   * Logout of the current authentication method.
   */
  logout(params: schema.LogoutRequest): Promise<schema.LogoutResponse> {
    return this.connection.sendRequest<
      schema.LogoutRequest,
      schema.LogoutResponse
    >(schema.AGENT_METHODS.logout, params, emptyObjectResponse);
  }

  /**
   * Processes a user prompt within a session.
   *
   * This method handles the whole lifecycle of a prompt:
   * - Receives user messages with optional context (files, images, etc.)
   * - Processes the prompt using language models
   * - Reports language model content and tool calls to the Clients
   * - Requests permission to run tools
   * - Executes any requested tool calls
   * - Returns when the turn is complete with a stop reason
   *
   * See protocol docs: [Prompt Turn](https://agentclientprotocol.com/protocol/prompt-turn)
   */
  prompt(params: schema.PromptRequest): Promise<schema.PromptResponse> {
    return this.connection.sendRequest(
      schema.AGENT_METHODS.session_prompt,
      params,
    );
  }

  /**
   * Cancels ongoing operations for a session.
   *
   * This is a notification sent by the client to cancel an ongoing prompt turn.
   *
   * Upon receiving this notification, the Agent SHOULD:
   * - Stop all language model requests as soon as possible
   * - Abort all tool call invocations in progress
   * - Send any pending `session/update` notifications
   * - Respond to the original `session/prompt` request with `StopReason::Cancelled`
   *
   * See protocol docs: [Cancellation](https://agentclientprotocol.com/protocol/prompt-turn#cancellation)
   */
  cancel(params: schema.CancelNotification): Promise<void> {
    return this.connection.sendNotification(
      schema.AGENT_METHODS.session_cancel,
      params,
    );
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Starts a NES (Next Edit Suggestions) session.
   *
   * @experimental
   */
  unstable_startNes(
    params: schema.StartNesRequest,
  ): Promise<schema.StartNesResponse> {
    return this.connection.sendRequest(schema.AGENT_METHODS.nes_start, params);
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Sends a NES suggestion request.
   *
   * @experimental
   */
  unstable_suggestNes(
    params: schema.SuggestNesRequest,
  ): Promise<schema.SuggestNesResponse> {
    return this.connection.sendRequest(
      schema.AGENT_METHODS.nes_suggest,
      params,
    );
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Closes a NES session.
   *
   * @experimental
   */
  unstable_closeNes(
    params: schema.CloseNesRequest,
  ): Promise<schema.CloseNesResponse> {
    return this.connection.sendRequest<
      schema.CloseNesRequest,
      schema.CloseNesResponse
    >(schema.AGENT_METHODS.nes_close, params, emptyObjectResponse);
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Notifies the agent that a document was opened.
   *
   * @experimental
   */
  unstable_didOpenDocument(
    params: schema.DidOpenDocumentNotification,
  ): Promise<void> {
    return this.connection.sendNotification(
      schema.AGENT_METHODS.document_did_open,
      params,
    );
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Notifies the agent that a document was changed.
   *
   * @experimental
   */
  unstable_didChangeDocument(
    params: schema.DidChangeDocumentNotification,
  ): Promise<void> {
    return this.connection.sendNotification(
      schema.AGENT_METHODS.document_did_change,
      params,
    );
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Notifies the agent that a document was closed.
   *
   * @experimental
   */
  unstable_didCloseDocument(
    params: schema.DidCloseDocumentNotification,
  ): Promise<void> {
    return this.connection.sendNotification(
      schema.AGENT_METHODS.document_did_close,
      params,
    );
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Notifies the agent that a document was saved.
   *
   * @experimental
   */
  unstable_didSaveDocument(
    params: schema.DidSaveDocumentNotification,
  ): Promise<void> {
    return this.connection.sendNotification(
      schema.AGENT_METHODS.document_did_save,
      params,
    );
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Notifies the agent that a document received focus.
   *
   * @experimental
   */
  unstable_didFocusDocument(
    params: schema.DidFocusDocumentNotification,
  ): Promise<void> {
    return this.connection.sendNotification(
      schema.AGENT_METHODS.document_did_focus,
      params,
    );
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Notifies the agent that a NES suggestion was accepted.
   *
   * @experimental
   */
  unstable_acceptNes(params: schema.AcceptNesNotification): Promise<void> {
    return this.connection.sendNotification(
      schema.AGENT_METHODS.nes_accept,
      params,
    );
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Notifies the agent that a NES suggestion was rejected.
   *
   * @experimental
   */
  unstable_rejectNes(params: schema.RejectNesNotification): Promise<void> {
    return this.connection.sendNotification(
      schema.AGENT_METHODS.nes_reject,
      params,
    );
  }

  /**
   * Extension method
   *
   * Allows the Client to send an arbitrary request that is not part of the ACP spec.
   */
  extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.connection.sendRequest(method, params);
  }

  /**
   * Extension notification
   *
   * Allows the Client to send an arbitrary notification that is not part of the ACP spec.
   */
  extNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    return this.connection.sendNotification(method, params);
  }

  /**
   * AbortSignal that aborts when the connection closes.
   *
   * This signal can be used to:
   * - Listen for connection closure: `connection.signal.addEventListener('abort', () => {...})`
   * - Check connection status synchronously: `if (connection.signal.aborted) {...}`
   * - Pass to other APIs (fetch, setTimeout) for automatic cancellation
   *
   * The connection closes when the underlying stream ends, either normally or due to an error.
   *
   * @example
   * ```typescript
   * const connection = new ClientSideConnection(client, stream);
   *
   * // Listen for closure
   * connection.signal.addEventListener('abort', () => {
   *   console.log('Connection closed - performing cleanup');
   * });
   *
   * // Check status
   * if (connection.signal.aborted) {
   *   console.log('Connection is already closed');
   * }
   *
   * // Pass to other APIs
   * fetch(url, { signal: connection.signal });
   * ```
   */
  get signal(): AbortSignal {
    return this.connection.signal;
  }

  /**
   * Promise that resolves when the connection closes.
   *
   * The connection closes when the underlying stream ends, either normally or due to an error.
   * Once closed, the connection cannot send or receive any more messages.
   *
   * This is useful for async/await style cleanup:
   *
   * @example
   * ```typescript
   * const connection = new ClientSideConnection(client, stream);
   * await connection.closed;
   * console.log('Connection closed - performing cleanup');
   * ```
   */
  get closed(): Promise<void> {
    return this.connection.closed;
  }
}

/**
 * The Client interface defines the interface that ACP-compliant clients must implement.
 *
 * Clients are typically code editors (IDEs, text editors) that provide the interface
 * between users and AI agents. They manage the environment, handle user interactions,
 * and control access to resources.
 */
export interface Client {
  /**
   * Requests permission from the user for a tool call operation.
   *
   * Called by the agent when it needs user authorization before executing
   * a potentially sensitive operation. The client should present the options
   * to the user and return their decision.
   *
   * If the client cancels the prompt turn via `session/cancel`, it MUST
   * respond to this request with `RequestPermissionOutcome::Cancelled`.
   *
   * See protocol docs: [Requesting Permission](https://agentclientprotocol.com/protocol/tool-calls#requesting-permission)
   */
  requestPermission(
    params: schema.RequestPermissionRequest,
  ): MaybePromise<schema.RequestPermissionResponse>;
  /**
   * Handles session update notifications from the agent.
   *
   * This is a notification endpoint (no response expected) that receives
   * real-time updates about session progress, including message chunks,
   * tool calls, and execution plans.
   *
   * Note: Clients SHOULD continue accepting tool call updates even after
   * sending a `session/cancel` notification, as the agent may send final
   * updates before responding with the cancelled stop reason.
   *
   * See protocol docs: [Agent Reports Output](https://agentclientprotocol.com/protocol/prompt-turn#3-agent-reports-output)
   */
  sessionUpdate(params: schema.SessionNotification): MaybePromise<void>;
  /**
   * Writes content to a text file in the client's file system.
   *
   * Only available if the client advertises the `fs.writeTextFile` capability.
   * Allows the agent to create or modify files within the client's environment.
   *
   * See protocol docs: [Client](https://agentclientprotocol.com/protocol/overview#client)
   */
  writeTextFile?(
    params: schema.WriteTextFileRequest,
  ): MaybePromise<schema.WriteTextFileResponse>;
  /**
   * Reads content from a text file in the client's file system.
   *
   * Only available if the client advertises the `fs.readTextFile` capability.
   * Allows the agent to access file contents within the client's environment.
   *
   * See protocol docs: [Client](https://agentclientprotocol.com/protocol/overview#client)
   */
  readTextFile?(
    params: schema.ReadTextFileRequest,
  ): MaybePromise<schema.ReadTextFileResponse>;

  /**
   * Creates a new terminal to execute a command.
   *
   * Only available if the `terminal` capability is set to `true`.
   *
   * The Agent must call `releaseTerminal` when done with the terminal
   * to free resources.

   * @see {@link https://agentclientprotocol.com/protocol/terminals | Terminal Documentation}
   */
  createTerminal?(
    params: schema.CreateTerminalRequest,
  ): MaybePromise<schema.CreateTerminalResponse>;

  /**
   * Gets the current output and exit status of a terminal.
   *
   * Returns immediately without waiting for the command to complete.
   * If the command has already exited, the exit status is included.
   *
   * @see {@link https://agentclientprotocol.com/protocol/terminals#getting-output | Getting Terminal Output}
   */
  terminalOutput?(
    params: schema.TerminalOutputRequest,
  ): MaybePromise<schema.TerminalOutputResponse>;

  /**
   * Releases a terminal and frees all associated resources.
   *
   * The command is killed if it hasn't exited yet. After release,
   * the terminal ID becomes invalid for all other terminal methods.
   *
   * Tool calls that already contain the terminal ID continue to
   * display its output.
   *
   * @see {@link https://agentclientprotocol.com/protocol/terminals#releasing-terminals | Releasing Terminals}
   */
  releaseTerminal?(
    params: schema.ReleaseTerminalRequest,
  ): MaybePromise<schema.ReleaseTerminalResponse | void>;

  /**
   * Waits for a terminal command to exit and returns its exit status.
   *
   * This method returns once the command completes, providing the
   * exit code and/or signal that terminated the process.
   *
   * @see {@link https://agentclientprotocol.com/protocol/terminals#waiting-for-exit | Waiting for Exit}
   */
  waitForTerminalExit?(
    params: schema.WaitForTerminalExitRequest,
  ): MaybePromise<schema.WaitForTerminalExitResponse>;

  /**
   * Kills a terminal command without releasing the terminal.
   *
   * While `releaseTerminal` also kills the command, this method keeps
   * the terminal ID valid so it can be used with other methods.
   *
   * Useful for implementing command timeouts that terminate the command
   * and then retrieve the final output.
   *
   * Note: Call `releaseTerminal` when the terminal is no longer needed.
   *
   * @see {@link https://agentclientprotocol.com/protocol/terminals#killing-commands | Killing Commands}
   */
  killTerminal?(
    params: schema.KillTerminalRequest,
  ): MaybePromise<schema.KillTerminalResponse | void>;

  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Creates an elicitation to request input from the user.
   *
   * @experimental
   */
  unstable_createElicitation?(
    params: schema.CreateElicitationRequest,
  ): MaybePromise<schema.CreateElicitationResponse>;

  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Called when a URL-based elicitation is complete.
   *
   * @experimental
   */
  unstable_completeElicitation?(
    params: schema.CompleteElicitationNotification,
  ): MaybePromise<void>;

  /**
   * Extension method
   *
   * Allows the Agent to send an arbitrary request that is not part of the ACP spec.
   *
   * To help avoid conflicts, it's a good practice to prefix extension
   * methods with a unique identifier such as domain name.
   */
  extMethod?(
    method: string,
    params: Record<string, unknown>,
  ): MaybePromise<Record<string, unknown>>;

  /**
   * Extension notification
   *
   * Allows the Agent to send an arbitrary notification that is not part of the ACP spec.
   */
  extNotification?(
    method: string,
    params: Record<string, unknown>,
  ): MaybePromise<void>;
}

/**
 * The Agent interface defines the interface that all ACP-compliant agents must implement.
 *
 * Agents are programs that use generative AI to autonomously modify code. They handle
 * requests from clients and execute tasks using language models and tools.
 */
export interface Agent {
  /**
   * Establishes the connection with a client and negotiates protocol capabilities.
   *
   * This method is called once at the beginning of the connection to:
   * - Negotiate the protocol version to use
   * - Exchange capability information between client and agent
   * - Determine available authentication methods
   *
   * The agent should respond with its supported protocol version and capabilities.
   *
   * See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/initialization)
   */
  initialize(
    params: schema.InitializeRequest,
  ): MaybePromise<schema.InitializeResponse>;
  /**
   * Creates a new conversation session with the agent.
   *
   * Sessions represent independent conversation contexts with their own history and state.
   *
   * The agent should:
   * - Create a new session context
   * - Connect to any specified MCP servers
   * - Return a unique session ID for future requests
   *
   * The request may include `additionalDirectories` to expand the session's filesystem
   * scope beyond `cwd` without changing the base for relative paths.
   *
   * May return an `auth_required` error if the agent requires authentication.
   *
   * See protocol docs: [Session Setup](https://agentclientprotocol.com/protocol/session-setup)
   */
  newSession(
    params: schema.NewSessionRequest,
  ): MaybePromise<schema.NewSessionResponse>;
  /**
   * Loads an existing session to resume a previous conversation.
   *
   * This method is only available if the agent advertises the `loadSession` capability.
   *
   * The agent should:
   * - Restore the session context and conversation history
   * - Connect to the specified MCP servers
   * - Stream the entire conversation history back to the client via notifications
   *
   * The request may include `additionalDirectories` to set the complete list of
   * additional workspace roots for the loaded session.
   *
   * See protocol docs: [Loading Sessions](https://agentclientprotocol.com/protocol/session-setup#loading-sessions)
   */
  loadSession?(
    params: schema.LoadSessionRequest,
  ): MaybePromise<schema.LoadSessionResponse>;
  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Forks an existing session to create a new independent session.
   *
   * Creates a new session based on the context of an existing one, allowing
   * operations like generating summaries without affecting the original session's history.
   *
   * The request may include `additionalDirectories` to set the complete list of
   * additional workspace roots for the forked session.
   *
   * This method is only available if the agent advertises the `session.fork` capability.
   *
   * @experimental
   */
  unstable_forkSession?(
    params: schema.ForkSessionRequest,
  ): MaybePromise<schema.ForkSessionResponse>;
  /**
   * Lists existing sessions from the agent.
   *
   * This method is only available if the agent advertises the `listSessions` capability.
   *
   * Returns a list of sessions with metadata like session ID, working directory,
   * title, and last update time. Supports filtering by working directory,
   * `additionalDirectories`, and cursor-based pagination.
   */
  listSessions?(
    params: schema.ListSessionsRequest,
  ): MaybePromise<schema.ListSessionsResponse>;
  /**
   * Deletes an existing session returned by `session/list`.
   *
   * This method is only available if the agent advertises the `sessionCapabilities.delete` capability.
   */
  deleteSession?(
    params: schema.DeleteSessionRequest,
  ): MaybePromise<schema.DeleteSessionResponse | void>;
  /**
   * Resumes an existing session without returning previous messages.
   *
   * This method is only available if the agent advertises the `session.resume` capability.
   *
   * The agent should resume the session context, allowing the conversation to continue
   * without replaying the message history (unlike `session/load`).
   *
   * The request may include `additionalDirectories` to set the complete list of
   * additional workspace roots for the resumed session.
   */
  resumeSession?(
    params: schema.ResumeSessionRequest,
  ): MaybePromise<schema.ResumeSessionResponse>;
  /**
   * Closes an active session and frees up any resources associated with it.
   *
   * This method is only available if the agent advertises the `session.close` capability.
   *
   * The agent must cancel any ongoing work (as if `session/cancel` was called)
   * and then free up any resources associated with the session.
   */
  closeSession?(
    params: schema.CloseSessionRequest,
  ): MaybePromise<schema.CloseSessionResponse | void>;
  /**
   * Sets the operational mode for a session.
   *
   * Allows switching between different agent modes (e.g., "ask", "architect", "code")
   * that affect system prompts, tool availability, and permission behaviors.
   *
   * The mode must be one of the modes advertised in `availableModes` during session
   * creation or loading. Agents may also change modes autonomously and notify the
   * client via `current_mode_update` notifications.
   *
   * This method can be called at any time during a session, whether the Agent is
   * idle or actively generating a turn.
   *
   * See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/session-modes)
   */
  setSessionMode?(
    params: schema.SetSessionModeRequest,
  ): MaybePromise<schema.SetSessionModeResponse | void>;
  /**
   * Set a configuration option for a given session.
   *
   * The response contains the full set of configuration options and their current values,
   * as changing one option may affect the available values or state of other options.
   */
  setSessionConfigOption?(
    params: schema.SetSessionConfigOptionRequest,
  ): MaybePromise<schema.SetSessionConfigOptionResponse>;
  /**
   * Authenticates the client using the specified authentication method.
   *
   * Called when the agent requires authentication before allowing session creation.
   * The client provides the authentication method ID that was advertised during initialization.
   *
   * After successful authentication, the client can proceed to create sessions with
   * `newSession` without receiving an `auth_required` error.
   *
   * See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/initialization)
   */
  authenticate(
    params: schema.AuthenticateRequest,
  ): MaybePromise<schema.AuthenticateResponse | void>;
  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Lists providers that can be configured by the client.
   *
   * This method is only available if the agent advertises the `providers` capability.
   *
   * @experimental
   */
  unstable_listProviders?(
    params: schema.ListProvidersRequest,
  ): MaybePromise<schema.ListProvidersResponse>;
  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Replaces the configuration for a provider.
   *
   * This method is only available if the agent advertises the `providers` capability.
   *
   * @experimental
   */
  unstable_setProvider?(
    params: schema.SetProviderRequest,
  ): MaybePromise<schema.SetProviderResponse | void>;
  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Disables a provider.
   *
   * This method is only available if the agent advertises the `providers` capability.
   *
   * @experimental
   */
  unstable_disableProvider?(
    params: schema.DisableProviderRequest,
  ): MaybePromise<schema.DisableProviderResponse | void>;
  /**
   * Logout of the current authentication method.
   */
  logout?(
    params: schema.LogoutRequest,
  ): MaybePromise<schema.LogoutResponse | void>;
  /**
   * Processes a user prompt within a session.
   *
   * This method handles the whole lifecycle of a prompt:
   * - Receives user messages with optional context (files, images, etc.)
   * - Processes the prompt using language models
   * - Reports language model content and tool calls to the Clients
   * - Requests permission to run tools
   * - Executes any requested tool calls
   * - Returns when the turn is complete with a stop reason
   *
   * See protocol docs: [Prompt Turn](https://agentclientprotocol.com/protocol/prompt-turn)
   */
  prompt(params: schema.PromptRequest): MaybePromise<schema.PromptResponse>;
  /**
   * Cancels ongoing operations for a session.
   *
   * This is a notification sent by the client to cancel an ongoing prompt turn.
   *
   * Upon receiving this notification, the Agent SHOULD:
   * - Stop all language model requests as soon as possible
   * - Abort all tool call invocations in progress
   * - Send any pending `session/update` notifications
   * - Respond to the original `session/prompt` request with `StopReason::Cancelled`
   *
   * See protocol docs: [Cancellation](https://agentclientprotocol.com/protocol/prompt-turn#cancellation)
   */
  cancel(params: schema.CancelNotification): MaybePromise<void>;

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Starts a NES (Next Edit Suggestions) session.
   *
   * @experimental
   */
  unstable_startNes?(
    params: schema.StartNesRequest,
  ): MaybePromise<schema.StartNesResponse>;
  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Sends a NES suggestion request.
   *
   * @experimental
   */
  unstable_suggestNes?(
    params: schema.SuggestNesRequest,
  ): MaybePromise<schema.SuggestNesResponse>;
  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Closes a NES session.
   *
   * @experimental
   */
  unstable_closeNes?(
    params: schema.CloseNesRequest,
  ): MaybePromise<schema.CloseNesResponse | void>;

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Called when a document is opened.
   *
   * @experimental
   */
  unstable_didOpenDocument?(
    params: schema.DidOpenDocumentNotification,
  ): MaybePromise<void>;
  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Called when a document is changed.
   *
   * @experimental
   */
  unstable_didChangeDocument?(
    params: schema.DidChangeDocumentNotification,
  ): MaybePromise<void>;
  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Called when a document is closed.
   *
   * @experimental
   */
  unstable_didCloseDocument?(
    params: schema.DidCloseDocumentNotification,
  ): MaybePromise<void>;
  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Called when a document is saved.
   *
   * @experimental
   */
  unstable_didSaveDocument?(
    params: schema.DidSaveDocumentNotification,
  ): MaybePromise<void>;
  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Called when a document receives focus.
   *
   * @experimental
   */
  unstable_didFocusDocument?(
    params: schema.DidFocusDocumentNotification,
  ): MaybePromise<void>;

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Called when a NES suggestion is accepted.
   *
   * @experimental
   */
  unstable_acceptNes?(params: schema.AcceptNesNotification): MaybePromise<void>;
  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Called when a NES suggestion is rejected.
   *
   * @experimental
   */
  unstable_rejectNes?(params: schema.RejectNesNotification): MaybePromise<void>;

  /**
   * Extension method
   *
   * Allows the Client to send an arbitrary request that is not part of the ACP spec.
   *
   * To help avoid conflicts, it's a good practice to prefix extension
   * methods with a unique identifier such as domain name.
   */
  extMethod?(
    method: string,
    params: Record<string, unknown>,
  ): MaybePromise<Record<string, unknown>>;

  /**
   * Extension notification
   *
   * Allows the Client to send an arbitrary notification that is not part of the ACP spec.
   */
  extNotification?(
    method: string,
    params: Record<string, unknown>,
  ): MaybePromise<void>;
}

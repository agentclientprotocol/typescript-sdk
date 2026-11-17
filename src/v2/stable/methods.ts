// Generated from src/v2/methods.ts. Do not edit directly.
import * as schema from "../schema/index.js";
/**
 * ACP method-name constants for the experimental draft v2 API.
 *
 * Use these with `onRequest(...)`, `onNotification(...)`, `request(...)`, and
 * `notify(...)` when you want literal-string type inference without spelling
 * protocol strings inline.
 *
 * @experimental
 */
export const methods = {
  agent: {
    initialize: schema.AGENT_METHODS.initialize,
    auth: {
      login: schema.AGENT_METHODS.auth_login,
      logout: schema.AGENT_METHODS.auth_logout,
    },
    session: {
      new: schema.AGENT_METHODS.session_new,
      list: schema.AGENT_METHODS.session_list,
      delete: schema.AGENT_METHODS.session_delete,
      resume: schema.AGENT_METHODS.session_resume,
      close: schema.AGENT_METHODS.session_close,
      setConfigOption: schema.AGENT_METHODS.session_set_config_option,
      prompt: schema.AGENT_METHODS.session_prompt,
      cancel: schema.AGENT_METHODS.session_cancel,
    },
    toolCall: {
      cancel: schema.AGENT_METHODS.tool_call_cancel,
    },
    terminal: {
      cancel: schema.AGENT_METHODS.terminal_cancel,
    },
  },
  client: {
    session: {
      requestPermission: schema.CLIENT_METHODS.session_request_permission,
      update: schema.CLIENT_METHODS.session_update,
    },
    elicitation: {
      create: schema.CLIENT_METHODS.elicitation_create,
      complete: schema.CLIENT_METHODS.elicitation_complete,
    },
  },
  protocol: {
    cancelRequest: schema.PROTOCOL_METHODS.cancel_request,
  },
} as const;

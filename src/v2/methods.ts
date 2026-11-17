import * as schema from "./unstable/schema/index.js";

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
      status: schema.AGENT_METHODS.auth_status,
    },
    providers: {
      list: schema.AGENT_METHODS.providers_list,
      set: schema.AGENT_METHODS.providers_set,
      disable: schema.AGENT_METHODS.providers_disable,
    },
    session: {
      new: schema.AGENT_METHODS.session_new,
      list: schema.AGENT_METHODS.session_list,
      delete: schema.AGENT_METHODS.session_delete,
      fork: schema.AGENT_METHODS.session_fork,
      archive: schema.AGENT_METHODS.session_archive,
      unarchive: schema.AGENT_METHODS.session_unarchive,
      status: schema.AGENT_METHODS.session_status,
      options: schema.AGENT_METHODS.session_options,
      setTitle: schema.AGENT_METHODS.session_set_title,
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
    mcp: {
      message: schema.AGENT_METHODS.mcp_message,
    },
  },
  client: {
    session: {
      requestPermission: schema.CLIENT_METHODS.session_request_permission,
      update: schema.CLIENT_METHODS.session_update,
    },
    mcp: {
      message: schema.CLIENT_METHODS.mcp_message,
    },
    elicitation: {
      create: schema.CLIENT_METHODS.elicitation_create,
      complete: schema.CLIENT_METHODS.elicitation_complete,
    },
    auth: {
      statusUpdate: schema.CLIENT_METHODS.auth_status_update,
    },
  },
  protocol: {
    cancelRequest: schema.PROTOCOL_METHODS.cancel_request,
  },
} as const;

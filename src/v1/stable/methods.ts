// Generated from src/v1/methods.ts. Do not edit directly.
import * as schema from "../schema/index.js";
/**
 * ACP method-name constants.
 *
 * Use these with `onRequest(...)`, `onNotification(...)`, `request(...)`, and
 * `notify(...)` when you want literal-string type inference without spelling
 * protocol strings inline.
 */
export const methods = {
  agent: {
    initialize: schema.AGENT_METHODS.initialize,
    authenticate: schema.AGENT_METHODS.authenticate,
    logout: schema.AGENT_METHODS.logout,
    session: {
      new: schema.AGENT_METHODS.session_new,
      load: schema.AGENT_METHODS.session_load,
      list: schema.AGENT_METHODS.session_list,
      delete: schema.AGENT_METHODS.session_delete,
      resume: schema.AGENT_METHODS.session_resume,
      close: schema.AGENT_METHODS.session_close,
      setMode: schema.AGENT_METHODS.session_set_mode,
      setConfigOption: schema.AGENT_METHODS.session_set_config_option,
      prompt: schema.AGENT_METHODS.session_prompt,
      cancel: schema.AGENT_METHODS.session_cancel,
    },
  },
  client: {
    session: {
      requestPermission: schema.CLIENT_METHODS.session_request_permission,
      update: schema.CLIENT_METHODS.session_update,
    },
    fs: {
      writeTextFile: schema.CLIENT_METHODS.fs_write_text_file,
      readTextFile: schema.CLIENT_METHODS.fs_read_text_file,
    },
    terminal: {
      create: schema.CLIENT_METHODS.terminal_create,
      output: schema.CLIENT_METHODS.terminal_output,
      release: schema.CLIENT_METHODS.terminal_release,
      waitForExit: schema.CLIENT_METHODS.terminal_wait_for_exit,
      kill: schema.CLIENT_METHODS.terminal_kill,
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

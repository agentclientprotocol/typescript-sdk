#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import * as acp from "../acp.js";

// A minimal ACP proxy: it presents as an agent on its own stdio, spawns the
// real agent as a subprocess, and forwards every message between the two
// while logging traffic to stderr. Point an ACP client (like Zed) at this
// script exactly as it would run the agent directly — neither side needs to
// know the proxy is there.
//
// Usage: proxy.ts [command args...]
// Runs the example agent from this directory when no command is given.

function logAndForward(
  direction: string,
): acp.ProxyRequestHandler<unknown, unknown> {
  return ({ method, params, forward }) => {
    console.error(`[proxy] ${direction} request: ${method}`);
    return forward(params);
  };
}

function logAndForwardNotification(
  direction: string,
): acp.ProxyNotificationHandler<unknown> {
  return async ({ method, params, forward }) => {
    console.error(`[proxy] ${direction} notification: ${method}`);
    await forward(params);
  };
}

// Spawn the wrapped agent: the command from argv, or the example agent.
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
const exampleAgent = join(dirname(fileURLToPath(import.meta.url)), "agent.ts");
const [command, ...args] =
  process.argv.length > 2
    ? process.argv.slice(2)
    : [npxCmd, "tsx", exampleAgent];
const agentProcess = spawn(command, args, {
  stdio: ["pipe", "pipe", "inherit"],
});

// "*" catches anything without an exact registration; typed interception is
// also available, e.g.
// .onRequestFromClient("session/prompt", async ({ params, forward }) => ...).
const handle = acp
  .proxy()
  .onRequestFromClient("*", logAndForward("client → agent"))
  .onNotificationFromClient("*", logAndForwardNotification("client → agent"))
  .onRequestFromAgent("*", logAndForward("agent → client"))
  .onNotificationFromAgent("*", logAndForwardNotification("agent → client"))
  .connect({
    client: acp.ndJsonStream(
      Writable.toWeb(process.stdout),
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
    agent: acp.ndJsonStream(
      Writable.toWeb(agentProcess.stdin!),
      Readable.toWeb(agentProcess.stdout!) as ReadableStream<Uint8Array>,
    ),
  });

agentProcess.once("exit", () => handle.close());
await handle.closed;
agentProcess.kill();

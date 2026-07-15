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

/** Logs each request and notification crossing the proxy, then passes it on. */
function snoop(direction: string): acp.JsonRpcHandler {
  return {
    handleMessage(message) {
      console.error(`[proxy] ${direction} ${message.kind}: ${message.method}`);
      return acp.Handled.no(message);
    },
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

const p = acp.proxy();
// Raw handlers see every message; typed interception is also available, e.g.
// p.client.onRequest("session/prompt", async ({ params, forward }) => ...).
p.client.withHandler(snoop("client → agent"));
p.agent.withHandler(snoop("agent → client"));

const handle = p.connect({
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

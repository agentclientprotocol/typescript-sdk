# ACP TypeScript Examples

This directory contains examples using the [ACP](https://agentclientprotocol.com) library for TypeScript:

- [`agent.ts`](./agent.ts) - A minimal agent implementation that simulates LLM interaction
- [`client.ts`](./client.ts) - A minimal client implementation that spawns the [`agent.ts`](./agent.ts) as a subprocess
- [`http-server.ts`](./http-server.ts) - A minimal ACP Streamable HTTP server with WebSocket upgrade support
- [`http-client.ts`](./http-client.ts) - A minimal client using `createHttpStream`
- [`ws-client.ts`](./ws-client.ts) - A minimal client using `createWebSocketStream`

## Running the Agent

### In Zed

While minimal, [`agent.ts`](./agent.ts) implements a compliant [ACP](https://agentclientprotocol.com) Agent. This means we can connect to it from an ACP client like [Zed](https://zed.dev)!

1. Clone this repo

```sh
$ git clone https://github.com/agentclientprotocol/typescript-sdk.git
```

2. Add the following at the root of your [Zed](https://zed.dev) settings:

```json
  "agent_servers": {
    "Example Agent": {
      "command": "npx",
      "args": [
        "tsx",
        "/path/to/agent-client-protocol/src/examples/agent.ts"
      ]
  }
```

❕ Make sure to replace `/path/to/agent-client-protocol` with the path to your clone of this repository.

Note: This configuration assumes you have [npx](https://docs.npmjs.com/cli/v8/commands/npx) in your `PATH`.

3. Run the `acp: open acp logs` action from the command palette (<kbd>⌘⇧P</kbd> on macOS, <kbd>ctrl-shift-p</kbd> on Windows/Linux) to see the messages exchanged between the example agent and Zed.

4. Then open the Agent Panel, and click "New Example Agent Thread" from the `+` menu on the top-right.

![Agent menu](./img/menu.png)

5. Finally, send a message and see the Agent respond!

![Final state](./img/final.png)

### By itself

You can also run the Agent directly and send messages to it:

```bash
npx tsx src/examples/agent.ts
```

Paste this into your terminal and press <kbd>enter</kbd>:

```json
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1}}
```

You should see it respond with something like:

```json
{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":false}}}
```

From there, you can try making a [new session](https://agentclientprotocol.com/protocol/session-setup#creating-a-session) and [sending a prompt](https://agentclientprotocol.com/protocol/prompt-turn#1-user-message).

## Running the Client

Run the client example from the root directory:

```bash
npx tsx src/examples/client.ts
```

This client will spawn the example agent as a subprocess, send a message, and print the content it receives from it.

## Running the HTTP and WebSocket Examples

Start the Streamable HTTP server with WebSocket upgrade support:

```bash
npx tsx src/examples/http-server.ts
```

In another terminal, run the HTTP client:

```bash
npx tsx src/examples/http-client.ts
```

Or run the WebSocket client:

```bash
npx tsx src/examples/ws-client.ts
```

The HTTP example sends a bearer token through custom request headers. `createHttpStream` includes cookies by default for the lifetime of one stream: it sends credentials on fetch requests, captures exposed `Set-Cookie` headers, merges them with caller-provided `Cookie` headers, and reuses them for connection SSE, session SSE, POST, and DELETE requests. Pass `cookies: "omit"` to disable this behavior for stateless transports.

The WebSocket server example uses `createNodeWebSocketUpgradeHandler`, which creates the ACP connection before the upgrade completes and adds `Acp-Connection-Id` to the `101 Switching Protocols` response. Frameworks that only expose an already-upgraded WebSocket socket cannot add that response header, so prefer an upgrade hook when building compliant servers.

The WebSocket client example passes the Node `ws` constructor so custom headers can be sent during the WebSocket handshake. Browser WebSocket clients can use `createWebSocketStream` too, but browsers do not allow custom WebSocket headers. Use cookies or URL-level authentication for browser WebSocket authentication instead of relying on custom handshake headers.

The included Node HTTP server is an HTTP/1.1 compatibility adapter. HTTP/2 deployment guidance is still tracked separately in the transport hardening plan.

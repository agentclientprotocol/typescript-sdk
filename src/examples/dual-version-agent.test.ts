import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as v2 from "../v2/stable/acp.js";
import { until } from "../test-support/until.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const agentPath = fileURLToPath(
  new URL("./dual-version-agent.ts", import.meta.url),
);
const cwd = process.cwd();
const allow: v2.RequestPermissionResponse = {
  outcome: { outcome: "selected", optionId: "allow" },
};

type Harness = {
  agent: v2.ClientContext;
  sessionId: string;
  /** Every update received for the session, in order. */
  updates: v2.SessionUpdate[];
  /** The agent's permission requests, in order. Resolve one to answer it. */
  permissions: Array<PromiseWithResolvers<v2.RequestPermissionResponse>>;
  /** Sends `session/prompt` with an `idempotencyKey`. */
  send(
    idempotencyKey: string,
    options?: v2.SendRequestOptions,
  ): Promise<v2.PromptResponse>;
};

/** Runs the example agent as a subprocess and opens one v2 session on it. */
async function withExampleAgent(
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const child = spawn(process.execPath, ["--import", "tsx", agentPath], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const updates: v2.SessionUpdate[] = [];
  const permissions: Harness["permissions"] = [];
  const connection = v2
    .client()
    .onNotification(v2.methods.client.session.update, ({ params }) => {
      updates.push(params.update);
    })
    .onRequest(v2.methods.client.session.requestPermission, ({ signal }) => {
      const pending = Promise.withResolvers<v2.RequestPermissionResponse>();
      // The agent cancels the request when it stops waiting for the answer.
      signal.addEventListener(
        "abort",
        () => pending.resolve({ outcome: { outcome: "cancelled" } }),
        { once: true },
      );
      permissions.push(pending);
      return pending.promise;
    })
    .connect(
      v2.ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    );

  try {
    const agent = connection.agent;
    await agent.request(v2.methods.agent.initialize, {
      protocolVersion: v2.PROTOCOL_VERSION,
      info: { name: "example-test", version: "1.0.0" },
    });
    const { sessionId } = await agent.request(v2.methods.agent.session.new, {
      cwd,
    });
    await run({
      agent,
      sessionId,
      updates,
      permissions,
      send: (idempotencyKey, options) =>
        agent.request(
          v2.methods.agent.session.prompt,
          {
            sessionId,
            idempotencyKey,
            prompt: [{ type: "text", text: "Run the migration" }],
          },
          options,
        ),
    });
  } finally {
    connection.close();
    child.kill();
  }
}

function idleStopReasons(updates: v2.SessionUpdate[]): unknown[] {
  const stopReasons: unknown[] = [];
  for (const update of updates) {
    if (
      v2.SessionUpdate.isStateUpdate(update) &&
      v2.StateUpdate.isIdle(update)
    ) {
      stopReasons.push(update.stopReason);
    }
  }
  return stopReasons;
}

function userMessageIds(updates: v2.SessionUpdate[]): string[] {
  return updates
    .filter(v2.SessionUpdate.isUserMessage)
    .map((update) => update.messageId);
}

/**
 * Allows the permission request with this index, counted over the whole
 * connection, and waits for the turn that sent it to end.
 */
async function finishTurn(harness: Harness, permission: number): Promise<void> {
  const idles = idleStopReasons(harness.updates).length;
  await until(() => harness.permissions.length > permission, 10_000);
  harness.permissions[permission].resolve(allow);
  await until(() => idleStopReasons(harness.updates).length > idles, 10_000);
}

describe("dual-version example agent: v2 idempotency keys", () => {
  it("answers a retry with the original messageId and inserts one user message", async () => {
    await withExampleAgent(async (harness) => {
      const { agent, sessionId, updates, send } = harness;

      const first = await send("key-a");
      // A retry while the work is running inserts nothing.
      await expect(send("key-a")).resolves.toEqual(first);
      await finishTurn(harness, 0);
      // A retry after the work ended starts no second round of work.
      await expect(send("key-a")).resolves.toEqual(first);

      // The key lasts as long as the message, also across close and resume.
      await agent.request(v2.methods.agent.session.close, { sessionId });
      const replayStart = updates.length;
      await agent.request(v2.methods.agent.session.resume, {
        sessionId,
        cwd,
        replayFrom: { type: "start" },
      });
      expect(userMessageIds(updates.slice(replayStart))).toEqual([
        first.messageId,
      ]);
      await expect(send("key-a")).resolves.toEqual(first);

      // A new key is a new submission. It is inserted right away, because
      // no retry started work of its own, and only the two inserted prompts
      // asked for permission.
      const second = await send("key-b");
      expect(second.messageId).not.toBe(first.messageId);
      await finishTurn(harness, 1);
      expect(harness.permissions).toHaveLength(2);
      // The first message was sent live and once more in the replay.
      expect(userMessageIds(updates)).toEqual([
        first.messageId,
        first.messageId,
        second.messageId,
      ]);
    });
  }, 30_000);

  it("answers a retry of a held prompt with the first request's outcome", async () => {
    await withExampleAgent(async (harness) => {
      const { updates, send } = harness;

      const first = await send("key-a");
      // The turn is running, so the next prompt is held. Its retry is not
      // held a second time.
      const held = send("key-b");
      const retry = send("key-b");
      await finishTurn(harness, 0);

      const heldResponse = await held;
      await expect(retry).resolves.toEqual(heldResponse);
      expect(heldResponse.messageId).not.toBe(first.messageId);
      await finishTurn(harness, 1);
      expect(idleStopReasons(updates)).toEqual(["end_turn", "end_turn"]);
      expect(userMessageIds(updates)).toEqual([
        first.messageId,
        heldResponse.messageId,
      ]);
      // An inserted prompt keeps its key.
      await expect(send("key-b")).resolves.toEqual(heldResponse);
    });
  }, 30_000);

  it("leaves a key unused when its prompt is not inserted", async () => {
    await withExampleAgent(async (harness) => {
      const { agent, sessionId, updates, send } = harness;
      const cancelled = { code: -32800 };

      const first = await send("key-a");
      // The turn now waits for its permission request to be answered.
      await until(() => harness.permissions.length === 1, 10_000);

      // `$/cancel_request` for one request with the key withdraws the held
      // prompt, and every pending request for the key gets `-32800`.
      const withdraw = new AbortController();
      const held = send("key-b");
      const retry = send("key-b", { cancellationSignal: withdraw.signal });
      const settled = Promise.allSettled([held, retry]);
      withdraw.abort();
      await expect(held).rejects.toMatchObject(cancelled);
      await expect(retry).rejects.toMatchObject(cancelled);
      await settled;

      // `session/cancel` drops a prompt that is held again under the key. It
      // also makes the agent cancel the pending permission request.
      const heldAgain = send("key-b");
      const retryAgain = send("key-b");
      const settledAgain = Promise.allSettled([heldAgain, retryAgain]);
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      await expect(heldAgain).rejects.toMatchObject(cancelled);
      await expect(retryAgain).rejects.toMatchObject(cancelled);
      await settledAgain;
      await until(() => idleStopReasons(updates).length === 1, 10_000);
      expect(idleStopReasons(updates)).toEqual(["cancelled"]);

      // The key was never recorded, so the same prompt is inserted now.
      const inserted = await send("key-b");
      expect(inserted.messageId).not.toBe(first.messageId);
      await finishTurn(harness, 1);
      expect(idleStopReasons(updates)).toEqual(["cancelled", "end_turn"]);
      expect(userMessageIds(updates)).toEqual([
        first.messageId,
        inserted.messageId,
      ]);
    });
  }, 30_000);
});

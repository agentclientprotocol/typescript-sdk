// Handles a few messages and leaves the connection open. Run as a script by
// the test that checks that such a process still exits.
import { Connection } from "../core/jsonrpc.js";
import type { AnyMessage } from "../core/jsonrpc.js";
import { pushedMessageStream } from "./streams.js";
import { until } from "./until.js";

const peer = pushedMessageStream<AnyMessage>();
let handled = 0;
Connection.builder()
  .onReceiveNotification(
    "example/notify",
    (params) => params,
    () => {
      handled += 1;
    },
  )
  .connect(peer.stream);

const notification: AnyMessage = {
  jsonrpc: "2.0",
  method: "example/notify",
  params: {},
};
peer.push(notification, notification, notification);
await until(() => handled === 3);
console.log(`handled ${handled}`);

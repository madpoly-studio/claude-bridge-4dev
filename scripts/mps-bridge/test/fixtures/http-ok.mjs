// Test child: `http-ok.mjs <port> [delayMs]` prints "started", waits delayMs, then serves HTTP 200 on 127.0.0.1:<port>.
import http from "node:http";

const port = Number(process.argv[2]);
const delayMs = Number(process.argv[3] ?? 0);
console.log("started");
setTimeout(() => {
  http.createServer((_req, res) => res.end("ok")).listen(port, "127.0.0.1", () => console.log(`listening ${port}`));
}, delayMs);

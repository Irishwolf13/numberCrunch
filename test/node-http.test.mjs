import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { nodeListener } from "../server/node-http.mjs";

const ORIGIN = "https://crunch.example.test";

async function serve(t, app) {
  const server = createServer(nodeListener(app, ORIGIN));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
}

// Sends raw HTTP and resolves with the status line, so oversized or malformed requests stay exact.
function rawStatus(port, text) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(text));
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\r\n")) { resolve(data.split("\r\n")[0]); socket.destroy(); }
    });
    socket.on("error", reject);
  });
}

test("requests are rebuilt on the configured origin with headers and body", async (t) => {
  const seen = [];
  const port = await serve(t, async (request) => {
    seen.push({ url: request.url, method: request.method, test: request.headers.get("x-test"), body: await request.text() });
    return new Response("ok");
  });
  const res = await fetch(`http://127.0.0.1:${port}/api/rounds?x=1`, { method: "POST", headers: { "x-test": "yes" }, body: '{"target":12}' });
  assert.equal(await res.text(), "ok");
  assert.deepEqual(seen, [{ url: `${ORIGIN}/api/rounds?x=1`, method: "POST", test: "yes", body: '{"target":12}' }]);
});

test("responses keep every set-cookie header, other headers and binary bodies", async (t) => {
  const port = await serve(t, async () => {
    const headers = new Headers({ "x-auth": "1", "content-type": "application/octet-stream" });
    headers.append("set-cookie", "a=1; Path=/; HttpOnly");
    headers.append("set-cookie", "b=2; Path=/; HttpOnly");
    return new Response(new Uint8Array([0, 255, 128, 10]), { status: 303, headers });
  });
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/callback`, { redirect: "manual" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("x-auth"), "1");
  assert.deepEqual(res.headers.getSetCookie(), ["a=1; Path=/; HttpOnly", "b=2; Path=/; HttpOnly"]);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0, 255, 128, 10]);
});

test("paths that are not origin-relative are rejected with 400", { timeout: 5000 }, async (t) => {
  let calls = 0;
  const port = await serve(t, async () => { calls++; return new Response("ok"); });
  assert.equal(await rawStatus(port, "GET http://evil.example/ HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n"), "HTTP/1.1 400 Bad Request");
  assert.equal(await rawStatus(port, "GET //evil.example/x HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"), "HTTP/1.1 400 Bad Request");
  assert.equal(calls, 0);
});

test("POST bodies over 16384 bytes get 413 without reaching the app", { timeout: 5000 }, async (t) => {
  let calls = 0;
  const port = await serve(t, async () => { calls++; return new Response("ok"); });
  const head = "POST /api/rounds HTTP/1.1\r\nHost: x\r\n";
  assert.equal(await rawStatus(port, `${head}Content-Length: 16385\r\n\r\n`), "HTTP/1.1 413 Payload Too Large");
  const chunk = "a".repeat(16_385);
  assert.equal(await rawStatus(port, `${head}Transfer-Encoding: chunked\r\n\r\n${chunk.length.toString(16)}\r\n${chunk}\r\n`), "HTTP/1.1 413 Payload Too Large");
  assert.equal(calls, 0);
  const res = await fetch(`http://127.0.0.1:${port}/api/rounds`, { method: "POST", body: "a".repeat(16_384) });
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
});

test("an app failure is a bare 500 with a generic log line", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const port = await serve(t, async () => { throw new Error("secret token abc123"); });
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 500);
  assert.equal(await res.text(), "");
  assert.deepEqual(logged.mock.calls.map((c) => c.arguments), [["Number Crunch request failed"]]);
});

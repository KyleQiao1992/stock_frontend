import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createClient } from "redis";
import { createRedisClientProvider } from "./redisClient.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// This server implements only the RESP commands needed by these local tests.
// Holding its replies simulates TCP success followed by a stalled handshake.
async function fakeRedis(t) {
  const sockets = new Set();
  const heldReplies = [];
  const firstCommand = deferred();
  let replying = false;
  const reply = (socket, args) => socket.write(args[0] === "PING" ? "+PONG\r\n" : "+OK\r\n");
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let input = Buffer.alloc(0);
    socket.on("data", chunk => {
      input = Buffer.concat([input, chunk]);
      while (input.length) {
        const countEnd = input.indexOf("\r\n");
        if (countEnd < 0) return;
        assert.equal(String.fromCharCode(input[0]), "*");
        const count = Number(input.subarray(1, countEnd).toString());
        const args = [];
        let offset = countEnd + 2;
        for (let index = 0; index < count; index++) {
          const lengthEnd = input.indexOf("\r\n", offset);
          if (lengthEnd < 0) return;
          const length = Number(input.subarray(offset + 1, lengthEnd).toString());
          const start = lengthEnd + 2;
          if (input.length < start + length + 2) return;
          args.push(input.subarray(start, start + length).toString());
          offset = start + length + 2;
        }
        input = input.subarray(offset);
        firstCommand.resolve();
        if (replying) reply(socket, args);
        else heldReplies.push({ socket, args });
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    url: `redis://127.0.0.1:${server.address().port}`,
    firstCommand: firstCommand.promise,
    enableReplies() {
      replying = true;
      for (const { socket, args } of heldReplies.splice(0)) {
        if (!socket.destroyed) reply(socket, args);
      }
    },
  };
}

function providerFor(t, server, connectTimeoutMs) {
  const clients = [];
  const getClient = createRedisClientProvider({
    getUrl: () => server.url,
    connectTimeoutMs,
    logError() {},
    makeClient(options) {
      const client = createClient(options);
      clients.push(client);
      return client;
    },
  });
  t.after(() => {
    for (const client of clients) if (client.isOpen) client.destroy();
  });
  return { getClient, clients };
}

test("concurrent callers wait for the same Redis handshake and receive only a ready client", async t => {
  const server = await fakeRedis(t);
  const { getClient, clients } = providerFor(t, server, 2000);
  let settled = 0;
  const first = getClient();
  first.then(() => settled++, () => settled++);
  await server.firstCommand;
  assert.equal(clients[0].isOpen, true);
  assert.equal(clients[0].isReady, false);
  const second = getClient();
  second.then(() => settled++, () => settled++);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(settled, 0);
  assert.equal(clients.length, 1);

  server.enableReplies();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one, two);
  assert.equal(one.isReady, true);
  assert.equal(await getClient(), one);
  assert.equal(await one.ping(), "PONG");
});

test("a black-holed Redis handshake times out, destroys its connection and permits a fresh retry", async t => {
  const server = await fakeRedis(t);
  const { getClient, clients } = providerFor(t, server, 250);
  const first = assert.rejects(getClient(), { code: "REDIS_CONNECT_TIMEOUT" });
  await server.firstCommand;
  const second = assert.rejects(getClient(), { code: "REDIS_CONNECT_TIMEOUT" });
  await Promise.all([first, second]);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].isOpen, false);
  assert.equal(clients[0].isReady, false);

  server.enableReplies();
  const recovered = await getClient();
  assert.equal(clients.length, 2);
  assert.notEqual(recovered, clients[0]);
  assert.equal(recovered.isReady, true);
  assert.equal(await recovered.ping(), "PONG");
});

test("a late completion from a timed-out attempt cannot replace a newer ready connection", async () => {
  const gate = deferred();
  const clients = [];
  const getClient = createRedisClientProvider({
    getUrl: () => "redis://synthetic-test-only",
    connectTimeoutMs: 20,
    logError() {},
    makeClient() {
      const first = clients.length === 0;
      const client = {
        isOpen: false, isReady: false, destroyed: false,
        on() {},
        async connect() {
          this.isOpen = true;
          if (first) await gate.promise;
          this.isReady = true;
        },
        destroy() { this.isOpen = false; this.isReady = false; this.destroyed = true; },
      };
      clients.push(client);
      return client;
    },
  });
  await assert.rejects(getClient(), { code: "REDIS_CONNECT_TIMEOUT" });
  assert.equal(clients[0].destroyed, true);
  const recovered = await getClient();
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await getClient(), recovered);
  assert.notEqual(recovered, clients[0]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import jwt from "jsonwebtoken";
import { createAuthHandler, hashPassword, isPasswordHash, verifyStoredPassword } from "./authHandlers.js";

const TEST_SECRET = "auth-regression-test-only";

function createStore(user) {
  const values = new Map(user ? [[`user:${user.username}`, JSON.stringify(user)]] : []);
  const writes = [];
  return {
    values,
    writes,
    async get(key) { return values.get(key) || null; },
    async exists(key) { return values.has(key) ? 1 : 0; },
    async incr() { return 17; },
    async set(key, value, options = {}) { if (options.NX && values.has(key)) return null; values.set(key, value); writes.push(key); return "OK"; },
    async eval(script, { keys, arguments: args }) {
      assert.ok(script.includes('"KEEPTTL"'));
      if (values.get(keys[0]) !== args[0]) return null;
      await this.set(keys[0], args[1]);
      return "OK";
    },
  };
}

async function requestAuth(store, action, body, options = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  req.url = `/${action}`;
  req.method = "POST";
  const res = {
    statusCode: 200,
    setHeader() {},
    end(value) { this.body = JSON.parse(value); },
  };
  await createAuthHandler({getRedis: async () => store, getSecret: () => TEST_SECRET, ...options})(req, res);
  return res;
}

test("new passwords are stored as bcrypt hashes", async () => {
  const passwordHash = await hashPassword("Fixture_only_pw_2026");
  assert.equal(isPasswordHash(passwordHash), true);
  assert.equal(passwordHash.includes("Fixture_only_pw_2026"), false);
  assert.equal(await verifyStoredPassword({ passwordHash }, "Fixture_only_pw_2026"), true);
  assert.equal(await verifyStoredPassword({ passwordHash }, "654321"), false);
});

test("legacy plaintext accounts remain login-compatible during migration", async () => {
  assert.equal(await verifyStoredPassword({ password: "Fixture_only_pw_2026" }, "Fixture_only_pw_2026"), true);
  assert.equal(await verifyStoredPassword({ password: "Fixture_only_pw_2026" }, "wrong-password"), false);
});

test("ordinary login preserves legacy shared records for older deployed services", async () => {
  const user = { id: 7, username: "test_user", password: "Fixture_only_pw_2026", createdAt: 123, group: "existing" };
  const store = createStore(user);
  const response = await requestAuth(store, "login", {username: "test_user", password: "Fixture_only_pw_2026"});
  assert.equal(response.statusCode, 200);
  assert.equal(jwt.verify(response.body.token, TEST_SECRET).id, 7);
  assert.deepEqual(JSON.parse(store.values.get("user:test_user")), user);
  assert.deepEqual(store.writes, []);
});

test("hash-only accounts can log in and wrong passwords are rejected", async () => {
  const passwordHash = await hashPassword("Fixture_only_pw_2026");
  const store = createStore({id: 7, username: "test_user", passwordHash});
  const success = await requestAuth(store, "login", {username: "test_user", password: "Fixture_only_pw_2026"});
  assert.equal(success.statusCode, 200);
  assert.equal(success.body.username, "test_user");
  const failure = await requestAuth(store, "login", {username: "test_user", password: "654321"});
  assert.equal(failure.statusCode, 401);
  assert.equal(failure.body.token, undefined);
  assert.deepEqual(store.writes, []);
});

test("explicit migration keeps account identity and unrelated fields", async () => {
  const user = {id: 7, username: "test_user", password: "Fixture_only_pw_2026", createdAt: 123, group: "existing"};
  const store = createStore(user);
  const response = await requestAuth(store, "login", {username: "test_user", password: "Fixture_only_pw_2026"}, {migratePasswords: true});
  assert.equal(response.statusCode, 200);
  const migrated = JSON.parse(store.values.get("user:test_user"));
  assert.equal(Object.hasOwn(migrated, "password"), false);
  assert.equal(await verifyStoredPassword(migrated, "Fixture_only_pw_2026"), true);
  const {passwordHash, ...metadata} = migrated;
  assert.equal(isPasswordHash(passwordHash), true);
  const expected = {...user};
  delete expected.password;
  assert.deepEqual(metadata, expected);
});

test("explicit migration does not overwrite a concurrently changed account", async () => {
  const store = createStore({id: 7, username: "test_user", password: "Fixture_only_pw_2026"});
  const originalEval = store.eval.bind(store);
  const updated = {id: 7, username: "test_user", password: "new-password", group: "changed"};
  store.eval = async (...args) => {
    store.values.set("user:test_user", JSON.stringify(updated));
    return originalEval(...args);
  };
  const response = await requestAuth(store, "login", {username: "test_user", password: "Fixture_only_pw_2026"}, {migratePasswords: true});
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(store.values.get("user:test_user")), updated);
  assert.deepEqual(store.writes, []);
});

test("failed migration does not block a verified login", async () => {
  const store = createStore({id: 7, username: "test_user", password: "Fixture_only_pw_2026"});
  store.eval = async () => { throw new Error("storage unavailable"); };
  const response = await requestAuth(store, "login", {username: "test_user", password: "Fixture_only_pw_2026"}, {migratePasswords: true});
  assert.equal(response.statusCode, 200);
  assert.equal(jwt.verify(response.body.token, TEST_SECRET).id, 7);
  assert.equal(JSON.parse(store.values.get("user:test_user")).password, "Fixture_only_pw_2026");
});

test("registration writes a hash and never stores the submitted plaintext password", async () => {
  const store = createStore();
  const response = await requestAuth(store, "register", {username: "new-user", password: "Fixture_only_pw_2026"});
  assert.equal(response.statusCode, 400); // 用户名中不允许连字符。
  const valid = await requestAuth(store, "register", {username: "new_user", password: "Fixture_only_pw_2026"});
  assert.equal(valid.statusCode, 200);
  const user = JSON.parse(store.values.get("user:new_user"));
  assert.equal(Object.hasOwn(user, "password"), false);
  assert.equal(await verifyStoredPassword(user, "Fixture_only_pw_2026"), true);
});


test("new password hashing rejects UTF-8 truncation while legacy long plaintext can still verify", async () => {
  await assert.rejects(hashPassword('a'.repeat(73)), /72/);
  await assert.rejects(hashPassword('中'.repeat(25)), /72/);
  const passwordHash = await hashPassword('中'.repeat(24));
  assert.equal(await verifyStoredPassword({ passwordHash }, '中'.repeat(24)), true);
  assert.equal(await verifyStoredPassword({ password: 'a'.repeat(73) }, 'a'.repeat(73)), true);
});

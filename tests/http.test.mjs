import assert from "node:assert/strict";
import { once } from "node:events";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { createApp } from "../dist/src/app.js";

const events = [];
const app = createApp({
  feishu: { verificationToken: "local-test-verification-token" },
  workflow: { async handleMessage(event) { events.push(event); } }
});
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const post = (body) => fetch(`${base}/feishu/events`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});
try {
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
  assert.deepEqual(await (await post({ type: "url_verification", token: "local-test-verification-token", challenge: "challenge-demo" })).json(), { challenge: "challenge-demo" });
  const payload = {
    schema: "2.0",
    header: { event_id: "http-demo-event", event_type: "im.message.receive_v1", token: "local-test-verification-token", create_time: "0", app_id: "cli_test", tenant_key: "tenant_test" },
    event: {
      sender: { sender_id: { user_id: "demo_user" }, sender_type: "user" },
      message: { message_id: "om_http_demo", chat_id: "oc_demo", chat_type: "group", message_type: "text", content: JSON.stringify({ text: "@_user_1 帮助" }), mentions: [{ key: "@_user_1", name: "合同审查机器人", id: { user_id: "demo_bot" } }] }
    }
  };
  const response = await post(payload);
  assert.equal(response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].messageId, "om_http_demo");
  assert.match(events[0].text, /帮助/u);
  await post({ ...payload, header: { ...payload.header, token: "wrong-token", event_id: "forged-event" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1, "invalid verification token must not reach workflow");
  assert.equal((await post({ type: "url_verification", token: "wrong-token", challenge: "forged" })).status, 403);
  assert.equal((await post({ encrypt: "invalid-ciphertext" })).status, 403);
  console.log("HTTP integration tests passed (health, challenge, event dispatch, invalid token)");
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

// Encrypted events must continue to work with Feishu's SHA-256 signature.
const encryptKey = "local-test-encrypt-key";
const encryptedEvents = [];
const encryptedServer = createApp({ feishu: { encryptKey, verificationToken: "encrypted-token" }, workflow: { async handleMessage(event) { encryptedEvents.push(event); } } }).listen(0, "127.0.0.1");
await once(encryptedServer, "listening");
const encrypt = (payload) => {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", createHash("sha256").update(encryptKey).digest(), iv);
  return { encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]).toString("base64") };
};
const encryptedPost = (payload, signature = true) => {
  const body = JSON.stringify(encrypt(payload));
  const timestamp = String(Math.floor(Date.now()/1000));
  const nonce = "local-nonce";
  return fetch(`http://127.0.0.1:${encryptedServer.address().port}/feishu/events`, { method: "POST", headers: { "content-type": "application/json", "x-lark-request-timestamp": timestamp, "x-lark-request-nonce": nonce, "x-lark-signature": signature ? createHash("sha256").update(timestamp + nonce + encryptKey + body).digest("hex") : "forged" }, body });
};
try {
  const encryptedPayload = { schema: "2.0", header: { token: "encrypted-token", event_id: "encrypted-event", event_type: "im.message.receive_v1" }, event: { sender: { sender_id: { user_id: "demo_user" } }, message: { message_id: "om_encrypted", chat_id: "oc_demo", message_type: "text", content: JSON.stringify({text:"帮助"}) } } };
  assert.equal((await encryptedPost(encryptedPayload)).status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(encryptedEvents.length, 1);
  await encryptedPost(encryptedPayload, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(encryptedEvents.length, 1, "invalid signature must not reach workflow");
  assert.deepEqual(await (await encryptedPost({ type: "url_verification", token: "encrypted-token", challenge: "encrypted-challenge" })).json(), { challenge: "encrypted-challenge" });
  assert.equal((await encryptedPost({ type: "url_verification", token: "wrong", challenge: "forged" })).status, 403);
  console.log("Encrypted HTTP tests passed (valid event, forged signature, challenge, forged token)");
} finally {
  encryptedServer.closeAllConnections();
  await new Promise((resolve) => encryptedServer.close(resolve));
}

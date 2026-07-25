import assert from "node:assert/strict";
import test from "node:test";

import {
  createPhoneVerificationSession,
  hasPhoneNumberError,
  isAuthenticatorPrompt,
  isNumberRejection,
  isSmsCodePrompt,
} from "./phone-verification.js";
import { SmsProviderError, normalizeSmsSettings } from "./sms-provider.js";

function createFakeClient(overrides = {}) {
  const calls = [];
  let nextId = 1;
  return {
    calls,
    settings: normalizeSmsSettings({ maxAttempts: 3, codeTimeoutMs: 30_000, pollIntervalMs: 1_000 }),
    async buyNumber() {
      const activationId = String(nextId++);
      calls.push(["buy", activationId]);
      return { activationId, phoneNumber: `+5730011122${activationId}` };
    },
    async fetchStatus(id) {
      calls.push(["status", id]);
      return { state: "waiting" };
    },
    async markNumberUsed(id) { calls.push(["used", id]); },
    async cancelNumber(id) { calls.push(["cancel", id]); },
    async finishNumber(id) { calls.push(["finish", id]); },
    ...overrides,
  };
}

function createClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms) => { current += ms; },
    advance: (ms) => { current += ms; },
  };
}

test("detects OpenAI's number rejection wording", () => {
  assert.ok(isNumberRejection("This phone number is already in use."));
  assert.ok(isNumberRejection("Unable to verify this number, try another"));
  assert.equal(isNumberRejection("We sent a code to your phone"), false);
  assert.equal(isNumberRejection("  "), false);
});

test("rotates on any error text that leaves the submitted phone form visible", () => {
  assert.equal(
    hasPhoneNumberError({ hasPhoneField: true, errorText: "Provider-specific localized error" }),
    true,
  );
  assert.equal(hasPhoneNumberError({ hasPhoneField: true, errorText: "  " }), false);
  assert.equal(
    hasPhoneNumberError({ hasPhoneField: false, errorText: "Incorrect authenticator code" }),
    false,
  );
});

test("treats the code prompt after a rented number as SMS, not authenticator", () => {
  assert.equal(
    isAuthenticatorPrompt({ heading: "Enter code", bodyText: "we sent a text message to +57 300 111 2233" }),
    false,
  );
  assert.equal(isAuthenticatorPrompt({ heading: "Check your phone", bodyText: "enter the 6-digit code" }), false);
  assert.equal(
    isAuthenticatorPrompt({ heading: "Two-factor authentication", bodyText: "enter the code from your authenticator app" }),
    true,
  );
  assert.equal(isAuthenticatorPrompt({}), false);
});

test("recognizes the phone-code screen even without a live provider session", () => {
  const state = {
    hasCodeField: true,
    heading: "Check your phone",
    bodyText: "Enter the verification code we just sent to +57 300 3336520 Code Incorrect code Resend text message",
  };
  assert.equal(isSmsCodePrompt(state), true);
  assert.equal(isAuthenticatorPrompt(state), false);
});

test("rents a new number for every rejection and refunds the old one after two minutes", async () => {
  const client = createFakeClient();
  const clock = createClock();
  const session = createPhoneVerificationSession({ client, now: clock.now, sleep: clock.sleep });

  const first = await session.acquire();
  session.markSubmitted();
  session.reject("already in use");
  const second = await session.acquire();

  assert.notEqual(first.phoneNumber, second.phoneNumber);
  assert.equal(session.attempts, 2);
  await Promise.all(session.refundTasks);
  assert.deepEqual(
    client.calls.filter(([action]) => action === "cancel"),
    [["cancel", first.activationId]],
  );
  assert.ok(clock.now() >= client.settings.refundDelayMs);
});

test("stops after the configured number of rejected numbers", async () => {
  const client = createFakeClient();
  const session = createPhoneVerificationSession({ client, now: createClock().now, sleep: async () => {} });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await session.acquire();
    session.reject("already in use");
  }
  await assert.rejects(() => session.acquire(), /rejected all of them/);
});

test("returns the SMS code once the provider reports it", async () => {
  let polls = 0;
  const client = createFakeClient({
    async fetchStatus(id) {
      polls += 1;
      return polls < 3 ? { state: "waiting" } : { state: "code", code: "472913" };
    },
  });
  const clock = createClock();
  const session = createPhoneVerificationSession({ client, now: clock.now, sleep: clock.sleep });

  await session.acquire();
  session.markSubmitted();
  assert.equal(await session.waitForCode(), "472913");
  assert.ok(client.calls.some(([action]) => action === "used"));
});

test("rotates the number when no SMS arrives inside the wait budget", async () => {
  const client = createFakeClient({
    settings: {
      ...normalizeSmsSettings({ codeTimeoutMs: 10_000, pollIntervalMs: 3_000 }),
      refundDelayMs: 0,
    },
  });
  const clock = createClock();
  const session = createPhoneVerificationSession({ client, now: clock.now, sleep: clock.sleep });

  const activation = await session.acquire();
  session.markSubmitted();
  assert.equal(await session.waitForCode(), null);
  assert.equal(session.current, null);
  assert.equal(clock.now(), client.settings.codeTimeoutMs);
  await Promise.all(session.refundTasks);
  assert.ok(client.calls.some(([action, id]) => action === "cancel" && id === activation.activationId));
});

test("retries a refund that the provider refuses inside its two minute window", async () => {
  const attempts = [];
  const client = createFakeClient({
    async cancelNumber(id) {
      attempts.push(id);
      if (attempts.length === 1) throw new SmsProviderError("EARLY_CANCEL_DENIED");
    },
  });
  const clock = createClock();
  const session = createPhoneVerificationSession({ client, now: clock.now, sleep: clock.sleep });

  await session.acquire();
  session.reject("already in use");
  await Promise.all(session.refundTasks);
  assert.equal(attempts.length, 2);
});

test("releases the number still in play when the login window closes", async () => {
  const client = createFakeClient();
  const clock = createClock();
  const session = createPhoneVerificationSession({ client, now: clock.now, sleep: clock.sleep });

  const activation = await session.acquire();
  session.dispose("login window closed");
  await Promise.all(session.refundTasks);

  assert.ok(client.calls.some(([action, id]) => action === "cancel" && id === activation.activationId));
  await assert.rejects(() => session.acquire(), /closed/);
});

test("finishes instead of refunding a number after its code was received", async () => {
  const calls = [];
  const client = {
    settings: normalizeSmsSettings({}),
    buyNumber: async () => ({ activationId: "used", phoneNumber: "+573001112233" }),
    markNumberUsed: async () => {},
    fetchStatus: async () => ({ state: "code", code: "123456" }),
    cancelNumber: async (id) => calls.push(["cancel", id]),
    finishNumber: async (id) => calls.push(["finish", id]),
  };
  const session = createPhoneVerificationSession({ client, sleep: async () => {} });
  await session.acquire();
  assert.equal(await session.waitForCode(), "123456");
  session.dispose("login failed");
  await Promise.all([...session.refundTasks]);
  assert.deepEqual(calls, [["finish", "used"]]);
});

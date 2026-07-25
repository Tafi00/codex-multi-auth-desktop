import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { buildOAuthAutomationScript, buildPageStateScript } from "./login-automation.js";

const automation = { email: "person@example.com", password: "pa'ss\"word\n", totpSecret: "BASE32SECRET" };

test("both injected scripts are valid JavaScript", () => {
  // A syntax error here would be swallowed by the injector's catch, so it is
  // only ever visible as a login that silently never fills anything.
  assert.doesNotThrow(() => new vm.Script(buildPageStateScript()));
  assert.doesNotThrow(() => new vm.Script(buildOAuthAutomationScript(automation, {
    totpCode: "123456",
    smsCode: "654321",
    phoneNumber: "+573001112233",
    rotatePhone: false,
  }, "https://auth.openai.com/|sign in|email")));
});

test("embeds credentials as escaped literals", () => {
  const script = buildOAuthAutomationScript(automation, { phoneNumber: "+573001112233" }, null);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /"pa'ss\\"word\\n"/);
  assert.match(script, /"\+573001112233"/);
});

test("only asks for the rotate action when the caller requests it", () => {
  assert.match(buildOAuthAutomationScript(automation, { rotatePhone: true }, null), /needsPhoneReset/);
  const script = buildOAuthAutomationScript(automation, {}, null);
  assert.match(script, /if \(false\) \{/);
});

test("keys code and phone actions by value so a retry is possible", () => {
  const script = buildOAuthAutomationScript(automation, { smsCode: "111111" }, null);
  assert.match(script, /pageBase \+ "\|phone\|" \+ phoneNumber/);
  assert.match(script, /step\.keyed \? "\|" \+ step\.value : ""/);
});

test("recognizes the SMS delivery option when the page renders it as a tab", () => {
  const script = buildOAuthAutomationScript(automation, {}, null);
  assert.match(script, /\[role='tab'\]/);
  assert.match(script, /label === "sms"/);
  assert.match(script, /getAttribute\("aria-selected"\) === "true"/);
});

test("waits for SMS selection before submitting a phone number", () => {
  const script = buildOAuthAutomationScript(automation, { phoneNumber: "+573001112233" }, []);
  assert.match(script, /waitingForSmsMethod/);
  assert.match(script, /phone-fill/);
  assert.match(script, /sms-method-after-phone/);
  assert.match(script, /getAttribute\("value"\).*=== "sms"/);
  assert.match(script, /previousKeys\.has\(key\)/);
  assert.match(script, /Never infer the channel from tab order/);
  assert.match(script, /waitingForPhoneForm/);
});

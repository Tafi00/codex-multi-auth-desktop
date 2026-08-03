import assert from "node:assert/strict";
import test from "node:test";

import {
  SmsProviderError,
  SMS_SETTINGS_VERSION,
  createSmsClient,
  migrateSmsSettings,
  normalizeSmsSettings,
  parseCountriesResponse,
  parseNumberResponse,
  parsePricesResponse,
  parseStatusResponse,
} from "./sms-provider.js";

test("defaults to a Colombian OpenAI activation", () => {
  const settings = normalizeSmsSettings({});
  assert.equal(settings.country, "33");
  assert.equal(settings.service, "dr");
  assert.equal(settings.maxAttempts, 3);
  assert.ok(settings.refundDelayMs >= 120_000);
});

test("migrates the incorrectly labelled v1 Colombian country id", () => {
  assert.equal(migrateSmsSettings({ country: "39" }, 1).country, "33");
  assert.equal(migrateSmsSettings({ country: "39" }, SMS_SETTINGS_VERSION).country, "39");
  assert.equal(migrateSmsSettings({ country: "12" }, 1).country, "12");
});

test("rejects a non-HTTPS provider host", () => {
  assert.throws(() => normalizeSmsSettings({ baseUrl: "http://hero-sms.com/x" }), /HTTPS/);
});

test("reads rented numbers from both response shapes", () => {
  assert.deepEqual(
    parseNumberResponse("ACCESS_NUMBER:1234567:573001112233"),
    { activationId: "1234567", phoneNumber: "+573001112233" },
  );
  assert.deepEqual(
    parseNumberResponse('{"activationId":"99","phoneNumber":"573001112233"}'),
    { activationId: "99", phoneNumber: "+573001112233" },
  );
});

test("surfaces provider errors as typed failures", () => {
  assert.throws(() => parseNumberResponse("NO_BALANCE"), (error) => error.code === "NO_BALANCE");
  assert.throws(() => parseNumberResponse("BAD_KEY"), SmsProviderError);
});

test("classifies activation status responses", () => {
  assert.deepEqual(parseStatusResponse("STATUS_OK:472913"), { state: "code", code: "472913" });
  assert.deepEqual(parseStatusResponse("STATUS_WAIT_CODE"), { state: "waiting", lastCode: null });
  assert.deepEqual(parseStatusResponse("STATUS_WAIT_RETRY:111111"), { state: "waiting", lastCode: "111111" });
  assert.deepEqual(parseStatusResponse("STATUS_CANCEL"), { state: "cancelled" });
});

test("parses country names and live prices", () => {
  assert.deepEqual(
    parseCountriesResponse('{"33":{"id":33,"eng":"Colombia"},"39":{"id":39,"eng":"Argentina"}}'),
    [{ id: "33", name: "Colombia" }, { id: "39", name: "Argentina" }],
  );
  assert.deepEqual(
    parsePricesResponse('{"33":{"dr":{"cost":0.42,"count":7}},"39":{"dr":{"cost":"0.5","count":"2"}}}', "dr"),
    [
      { country: "33", price: 0.42, count: 7 },
      { country: "39", price: 0.5, count: 2 },
    ],
  );
});

test("sends the documented handler parameters", async () => {
  const requests = [];
  const client = createSmsClient({
    settings: { country: "33", service: "dr" },
    apiKey: "test-key",
    fetchImpl: async (url) => {
      requests.push(new URL(url));
      return { ok: true, text: async () => "ACCESS_NUMBER:5:573001112233" };
    },
  });

  assert.deepEqual(await client.buyNumber(), { activationId: "5", phoneNumber: "+573001112233" });
  const query = requests[0].searchParams;
  assert.equal(query.get("action"), "getNumber");
  assert.equal(query.get("api_key"), "test-key");
  assert.equal(query.get("country"), "33");
  assert.equal(query.get("service"), "dr");
});

test("loads and sorts live country offers for the configured service", async () => {
  const client = createSmsClient({
    settings: { service: "dr" },
    apiKey: "test-key",
    fetchImpl: async (url) => {
      const action = new URL(url).searchParams.get("action");
      return {
        ok: true,
        text: async () => action === "getCountries"
          ? '{"39":{"id":39,"eng":"Argentina"},"33":{"id":33,"eng":"Colombia"}}'
          : '{"39":{"dr":{"cost":0.5,"count":2}},"33":{"dr":{"cost":0.42,"count":7}}}',
      };
    },
  });
  assert.deepEqual(await client.getCountryOffers(), [
    { id: "39", name: "Argentina", price: 0.5, count: 2 },
    { id: "33", name: "Colombia", price: 0.42, count: 7 },
  ]);
});

test("refuses to run without an API key", () => {
  assert.throws(() => createSmsClient({ settings: {}, apiKey: "" }), /API key is missing/);
});

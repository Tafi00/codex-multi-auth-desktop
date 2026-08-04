// HeroSMS client. HeroSMS keeps the SMS-Activate handler contract, so the same
// client also works against any compatible host by changing `baseUrl`.

export const DEFAULT_SMS_SETTINGS = {
  enabled: false,
  baseUrl: "https://hero-sms.com/stubs/handler_api.php",
  service: "dr",
  // HeroSMS uses the SMS-Activate country catalog: 33 is Colombia. Country
  // 39 is Argentina (it was incorrectly labelled as Colombia in v1).
  country: "33",
  maxAttempts: 3,
  codeTimeoutMs: 20_000,
  pollIntervalMs: 3_000,
  // The provider only refunds a number that is cancelled after two minutes,
  // so a rejected number is parked until that window closes.
  refundDelayMs: 130_000,
  requestTimeoutMs: 20_000,
};

export const SMS_SETTINGS_VERSION = 2;

export function migrateSmsSettings(value, version) {
  const settings = value && typeof value === "object" ? { ...value } : {};
  // Version 1 shipped 39 as the Colombian default and labelled it as such in
  // the form, so existing users who kept that value intended Colombia.
  if (Number(version) < SMS_SETTINGS_VERSION && String(settings.country ?? "").trim() === "39") {
    settings.country = "33";
  }
  return settings;
}

const ERROR_MESSAGES = {
  BAD_KEY: "HeroSMS API key is invalid.",
  BAD_ACTION: "HeroSMS rejected the request action.",
  BAD_SERVICE: "HeroSMS does not know this service code.",
  WRONG_SERVICE: "HeroSMS does not know this service code.",
  BAD_STATUS: "HeroSMS rejected the activation status update.",
  NO_KEY: "HeroSMS API key is missing.",
  NO_NUMBERS: "HeroSMS has no number available for this service and country.",
  NO_BALANCE: "HeroSMS balance is empty.",
  NO_ACTIVATION: "HeroSMS does not know this activation any more.",
  WRONG_ACTIVATION_ID: "HeroSMS rejected the activation id.",
  EARLY_CANCEL_DENIED: "HeroSMS only refunds a number two minutes after purchase.",
  BANNED: "This HeroSMS account is blocked.",
  ERROR_SQL: "HeroSMS returned a server error.",
};

export class SmsProviderError extends Error {
  constructor(code, message) {
    super(message || ERROR_MESSAGES[code] || `HeroSMS returned ${code}.`);
    this.name = "SmsProviderError";
    this.code = code;
  }
}

const KNOWN_ERRORS = new Set(Object.keys(ERROR_MESSAGES));

function assertNotError(text) {
  const code = text.split(":")[0].trim().toUpperCase();
  if (KNOWN_ERRORS.has(code) || /^(BAD|NO|WRONG|ERROR)_/.test(code)) throw new SmsProviderError(code);
}

export function toE164(rawPhone) {
  const digits = String(rawPhone ?? "").replace(/\D/g, "");
  if (digits.length < 6) throw new Error("HeroSMS returned an unusable phone number.");
  return `+${digits}`;
}

export function parseNumberResponse(text) {
  const body = String(text ?? "").trim();
  if (body.startsWith("{")) {
    const data = JSON.parse(body);
    const activationId = String(data.activationId ?? data.id ?? "").trim();
    if (!activationId || !data.phoneNumber) throw new Error(`Unexpected HeroSMS number response: ${body.slice(0, 120)}`);
    return { activationId, phoneNumber: toE164(data.phoneNumber) };
  }
  assertNotError(body);
  const parts = body.split(":");
  if (parts[0] !== "ACCESS_NUMBER" || parts.length < 3) {
    throw new Error(`Unexpected HeroSMS number response: ${body.slice(0, 120)}`);
  }
  return { activationId: parts[1].trim(), phoneNumber: toE164(parts[2]) };
}

export function parseStatusResponse(text) {
  const body = String(text ?? "").trim();
  const [status, ...rest] = body.split(":");
  const payload = rest.join(":").trim();
  switch (status.toUpperCase()) {
    case "STATUS_OK":
      if (!payload) throw new Error("HeroSMS reported a code without a value.");
      return { state: "code", code: payload };
    case "STATUS_WAIT_CODE":
    case "STATUS_WAIT_RESEND":
    case "STATUS_WAIT_RETRY":
      return { state: "waiting", lastCode: payload || null };
    case "STATUS_CANCEL":
      return { state: "cancelled" };
    default:
      assertNotError(body);
      throw new Error(`Unexpected HeroSMS status response: ${body.slice(0, 120)}`);
  }
}

export function parseCountriesResponse(text) {
  const body = String(text ?? "").trim();
  assertNotError(body);
  const data = JSON.parse(body);
  if (!data || typeof data !== "object") throw new Error("HeroSMS returned an invalid country list.");
  return Object.entries(data).map(([key, entry]) => {
    const value = entry && typeof entry === "object" ? entry : {};
    const id = String(value.id ?? key).trim();
    const name = String(value.eng ?? value.name ?? value.rus ?? `Country ${id}`).trim();
    return { id, name };
  }).filter((country) => country.id);
}

export function parsePricesResponse(text, service) {
  const body = String(text ?? "").trim();
  assertNotError(body);
  const data = JSON.parse(body);
  if (!data || typeof data !== "object") throw new Error("HeroSMS returned invalid price data.");
  const serviceCode = String(service ?? "").trim();
  return Object.entries(data).flatMap(([country, services]) => {
    if (!services || typeof services !== "object") return [];
    const details = services[serviceCode];
    if (!details || typeof details !== "object") return [];
    const price = Number(details.cost ?? details.price);
    const count = Number(details.count ?? 0);
    if (!Number.isFinite(price)) return [];
    return [{ country: String(country), price, count: Number.isFinite(count) ? count : 0 }];
  });
}

export function normalizeSmsSettings(value) {
  const positiveInt = (input, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const parsed = Number(input);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  };
  const baseUrl = String(value?.baseUrl ?? "").trim() || DEFAULT_SMS_SETTINGS.baseUrl;
  if (!/^https:\/\//i.test(baseUrl)) throw new Error("HeroSMS base URL must use HTTPS.");
  return {
    enabled: Boolean(value?.enabled),
    baseUrl,
    service: String(value?.service ?? "").trim() || DEFAULT_SMS_SETTINGS.service,
    country: String(value?.country ?? "").trim() || DEFAULT_SMS_SETTINGS.country,
    maxAttempts: positiveInt(value?.maxAttempts, DEFAULT_SMS_SETTINGS.maxAttempts, { min: 1, max: 50 }),
    codeTimeoutMs: positiveInt(value?.codeTimeoutMs, DEFAULT_SMS_SETTINGS.codeTimeoutMs, { min: 20_000, max: 900_000 }),
    pollIntervalMs: positiveInt(value?.pollIntervalMs, DEFAULT_SMS_SETTINGS.pollIntervalMs, { min: 1_000, max: 30_000 }),
    refundDelayMs: positiveInt(value?.refundDelayMs, DEFAULT_SMS_SETTINGS.refundDelayMs, { min: 120_000, max: 600_000 }),
    requestTimeoutMs: positiveInt(value?.requestTimeoutMs, DEFAULT_SMS_SETTINGS.requestTimeoutMs, { min: 5_000, max: 60_000 }),
  };
}

export function createSmsClient({ settings, apiKey, fetchImpl = fetch }) {
  const config = normalizeSmsSettings(settings);
  const key = String(apiKey ?? "").trim();
  if (!key) throw new SmsProviderError("NO_KEY");

  const request = async (action, params = {}) => {
    const url = new URL(config.baseUrl);
    url.search = new URLSearchParams({ api_key: key, action, ...params }).toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetchImpl(url.toString(), { signal: controller.signal });
      if (!response.ok) throw new Error(`HeroSMS request returned ${response.status}.`);
      return (await response.text()).trim();
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    settings: config,
    async getBalance() {
      const text = await request("getBalance");
      assertNotError(text);
      const balance = Number(text.split(":")[1]);
      if (!Number.isFinite(balance)) throw new Error(`Unexpected HeroSMS balance response: ${text.slice(0, 120)}`);
      return balance;
    },
    async getCountryOffers(service = config.service) {
      const serviceCode = String(service ?? "").trim() || config.service;
      const [countriesText, pricesText] = await Promise.all([
        request("getCountries"),
        request("getPrices", { service: serviceCode }),
      ]);
      const countryNames = new Map(
        parseCountriesResponse(countriesText).map((country) => [country.id, country.name]),
      );
      return parsePricesResponse(pricesText, serviceCode)
        .map((offer) => ({
          id: offer.country,
          name: countryNames.get(offer.country) ?? `Country ${offer.country}`,
          price: offer.price,
          count: offer.count,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, "en"));
    },
    async buyNumber() {
      return parseNumberResponse(await request("getNumber", { service: config.service, country: config.country }));
    },
    async fetchStatus(activationId) {
      return parseStatusResponse(await request("getStatus", { id: String(activationId) }));
    },
    async markNumberUsed(activationId) {
      assertNotError(await request("setStatus", { id: String(activationId), status: "1" }));
    },
    async cancelNumber(activationId) {
      assertNotError(await request("setStatus", { id: String(activationId), status: "8" }));
    },
    async finishNumber(activationId) {
      assertNotError(await request("setStatus", { id: String(activationId), status: "6" }));
    },
  };
}

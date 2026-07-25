import { SmsProviderError } from "./sms-provider.js";

// OpenAI rejects most recycled numbers with an inline error instead of a
// navigation, so any visible alert on the phone step means "try another number".
const REJECTION_HINTS = [
  "already",
  "in use",
  "cannot be used",
  "can't be used",
  "not able",
  "unable",
  "invalid",
  "not valid",
  "try another",
  "different phone",
  "not supported",
  "too many",
  "went wrong",
];

export function isNumberRejection(text) {
  const normalized = String(text ?? "").toLowerCase();
  if (!normalized.trim()) return false;
  return REJECTION_HINTS.some((hint) => normalized.includes(hint));
}

/**
 * Once a number was submitted, any error that leaves the phone form visible
 * means that number was not accepted. The exact wording and language can vary,
 * so this deliberately does not depend on the English rejection hints above.
 */
export function hasPhoneNumberError(state) {
  return Boolean(state?.hasPhoneField && String(state?.errorText ?? "").trim());
}

// Both prompts use a one-time-code field, so only the page's own wording can
// separate an authenticator app challenge from the SMS sent to a rented number.
const AUTHENTICATOR_HINTS = [
  "authenticator",
  "authentication app",
  "authenticator app",
  "two-factor",
  "two factor",
  "2fa",
  "totp",
  "google authenticator",
];

/** Detects a phone-delivered code prompt even when the provider session ended. */
export function isSmsCodePrompt(state) {
  const text = `${state?.url ?? ""} ${state?.heading ?? ""} ${state?.bodyText ?? ""}`.toLowerCase();
  if (!text.trim()) return false;
  return /phone-verification|check your phone|verification code.{0,80}sent to|sent to \+?\d|resend text message|text message|sms|whatsapp|phone number ending/.test(text);
}

export function isAuthenticatorPrompt(state) {
  const text = `${state?.heading ?? ""} ${state?.bodyText ?? ""}`.toLowerCase();
  if (!text.trim()) return false;
  // A page that names the phone or a text message is the SMS step even when it
  // also mentions two-step verification in passing.
  if (isSmsCodePrompt(state)) return false;
  return AUTHENTICATOR_HINTS.some((hint) => text.includes(hint));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Owns the rented numbers for a single login attempt: buys a number, rotates to
 * a new one whenever OpenAI rejects it, and parks rejected numbers until the
 * provider's refund window opens.
 */
export function createPhoneVerificationSession({
  client,
  log = () => {},
  now = () => Date.now(),
  sleep = defaultSleep,
}) {
  const settings = client.settings;
  const refundTasks = new Set();
  let current = null;
  let attempts = 0;
  let disposed = false;

  const releaseForRefund = (activation, reason) => {
    const task = (async () => {
      if (activation.codeReceived) {
        await client.finishNumber(activation.activationId).then(
          () => log(`Closed ${activation.phoneNumber} after receiving its code (${reason}).`),
          (error) => log(`Could not close ${activation.phoneNumber}: ${error?.message || error}`),
        );
        return;
      }
      const waitMs = Math.max(0, settings.refundDelayMs - (now() - activation.purchasedAt));
      if (waitMs > 0) await sleep(waitMs);
      for (let retry = 0; retry < 4; retry += 1) {
        try {
          await client.cancelNumber(activation.activationId);
          log(`Released ${activation.phoneNumber} for refund (${reason}).`);
          return;
        } catch (error) {
          if (error instanceof SmsProviderError && error.code === "EARLY_CANCEL_DENIED") {
            await sleep(30_000);
            continue;
          }
          log(`Could not release ${activation.phoneNumber}: ${error?.message || error}`);
          return;
        }
      }
      log(`Gave up releasing ${activation.phoneNumber}; refund may need a manual cancel.`);
    })();
    refundTasks.add(task);
    void task.finally(() => refundTasks.delete(task));
    return task;
  };

  return {
    get current() {
      return current;
    },
    get attempts() {
      return attempts;
    },
    get refundTasks() {
      return refundTasks;
    },

    /** Returns the number in play, buying a fresh one when needed. */
    async acquire() {
      if (disposed) throw new Error("The phone verification session is closed.");
      if (current) return current;
      if (attempts >= settings.maxAttempts) {
        throw new Error(`HeroSMS gave ${attempts} numbers and OpenAI rejected all of them.`);
      }
      attempts += 1;
      const activation = await client.buyNumber();
      current = {
        ...activation,
        purchasedAt: now(),
        submitted: false,
        codeRequested: false,
        codeSubmitted: false,
      };
      log(`Number ${current.phoneNumber} rented (attempt ${attempts}/${settings.maxAttempts}).`);
      return current;
    },

    markSubmitted() {
      if (current) current.submitted = true;
    },

    markCodeSubmitted() {
      if (current) current.codeSubmitted = true;
    },

    /** Drops the number in play and starts its refund timer. */
    reject(reason = "rejected by OpenAI") {
      if (!current) return null;
      const activation = current;
      current = null;
      log(`OpenAI rejected ${activation.phoneNumber}: ${reason}. Renting another number.`);
      releaseForRefund(activation, reason);
      return activation;
    },

    /** Polls the provider until the SMS arrives or the wait budget runs out. */
    async waitForCode() {
      if (!current) throw new Error("No rented number is waiting for a code.");
      const activation = current;
      if (!activation.codeRequested) {
        activation.codeRequested = true;
        await client.markNumberUsed(activation.activationId).catch(() => undefined);
      }
      const deadline = now() + settings.codeTimeoutMs;
      while (now() < deadline) {
        if (disposed || current !== activation) return null;
        const status = await client.fetchStatus(activation.activationId).catch((error) => {
          log(`Code check failed: ${error?.message || error}`);
          return { state: "waiting" };
        });
        if (status.state === "code") {
          activation.codeReceived = true;
          log(`Received code for ${activation.phoneNumber}.`);
          return status.code;
        }
        if (status.state === "cancelled") {
          this.reject("provider cancelled the number");
          return null;
        }
        const remainingMs = deadline - now();
        if (remainingMs > 0) await sleep(Math.min(settings.pollIntervalMs, remainingMs));
      }
      this.reject("no SMS arrived in time");
      return null;
    },

    /** Marks the activation complete so the provider stops holding the number. */
    async finish() {
      if (!current) return;
      const activation = current;
      current = null;
      await client.finishNumber(activation.activationId).catch((error) => {
        log(`Could not close ${activation.phoneNumber}: ${error?.message || error}`);
      });
    },

    /** Releases anything still rented. Refunds continue in the background. */
    dispose(reason = "login finished") {
      if (disposed) return;
      disposed = true;
      if (current) {
        const activation = current;
        current = null;
        releaseForRefund(activation, reason);
      }
    },
  };
}

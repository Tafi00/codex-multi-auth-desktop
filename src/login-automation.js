// Scripts injected into the OpenAI sign-in window. They run in the page, so
// every value is embedded with JSON.stringify and no page data is trusted back
// beyond the small result object each script returns.

const PAGE_HELPERS = `
    const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim().toLowerCase();
    const visible = (element) => {
      if (!element || element.disabled || element.getAttribute("aria-disabled") === "true") return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const CODE_SELECTOR = "input[autocomplete='one-time-code'], input[name='code'], input[name='otp'], input[id='code']";
    const findVisible = (selector) => [...document.querySelectorAll(selector)].find(visible) ?? null;
`;

/** Read-only probe so the main process can decide what the page needs next. */
export function buildPageStateScript() {
  return `(() => {${PAGE_HELPERS}
    const alertText = [...document.querySelectorAll("[role='alert'], [aria-live='polite'], [aria-live='assertive'], [data-error], .text-error")]
      .filter(visible)
      .map((element) => normalize(element.innerText || element.textContent))
      .filter(Boolean);
    const phoneField = findVisible("input[type='tel']");
    const codeField = findVisible(CODE_SELECTOR);
    const card = codeField?.closest("form, main, section") ?? document.body;
    return {
      url: location.href,
      heading: normalize(document.querySelector("h1, h2, [role='heading']")?.textContent).slice(0, 160),
      // Used to tell an SMS code prompt apart from an authenticator prompt.
      bodyText: normalize(card?.innerText || document.body?.innerText).slice(0, 600),
      hasPhoneField: Boolean(phoneField),
      phoneValue: phoneField?.value ?? "",
      hasCodeField: Boolean(codeField),
      codeValue: codeField?.value ?? "",
      errorText: alertText.join(" | ").slice(0, 300),
    };
  })()`;
}

/**
 * Performs at most one action per call and reports the action key it used, so
 * the caller can tell a fresh page apart from a page that ignored the action.
 */
export function buildOAuthAutomationScript(automation, values = {}, completedActionKeys = []) {
  const previousKeys = Array.isArray(completedActionKeys)
    ? completedActionKeys
    : [completedActionKeys].filter(Boolean);
  return `(async () => {${PAGE_HELPERS}
    const clickables = [...document.querySelectorAll("button, a, [role='button'], [role='tab']")].filter(visible);
    const anotherAccountLabels = new Set([
      "log in to another account",
      "log in with another account",
      "login in to another account",
      "sign in to another account",
      "sign in with another account",
      "use another account",
    ]);
    const anotherAccount = clickables.find((element) =>
      anotherAccountLabels.has(normalize(element.innerText || element.textContent)),
    );
    const heading = normalize(document.querySelector("h1, h2, [role='heading']")?.textContent).slice(0, 120);
    const pageBase = location.href + "|" + heading;
    const previousKeys = new Set(${JSON.stringify(previousKeys)});
    const actOnce = (action, element) => {
      const key = pageBase + "|" + action;
      if (previousKeys.has(key)) return { acted: false, key };
      element.click();
      return { acted: true, key, action };
    };

    // Account chooser pages can also contain a Continue button for the
    // remembered account. Always choose a fresh login before any other action.
    if (anotherAccount) return actOnce("another-account", anotherAccount);

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) return { acted: false, key: null };
    const setNative = (field, value, inputType, data = null) => {
      setter.call(field, value);
      field.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType, data }));
    };
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const submitNear = (field) => {
      const form = field.closest("form");
      const candidates = [
        ...(form?.querySelectorAll("button, input[type='submit'], [role='button']") ?? []),
        ...clickables,
      ];
      const submit = candidates.find((element) =>
        visible(element) && (
          normalize(element.innerText || element.value || element.textContent) === "continue"
          || element.type === "submit"
        ),
      );
      if (!submit) return false;
      submit.click();
      return true;
    };

    // Swapping a burned number needs the page's own "use another number" exit.
    if (${JSON.stringify(Boolean(values.rotatePhone))}) {
      const rotate = clickables.find((element) => {
        const label = normalize(element.innerText || element.textContent);
        return /(another|different|change|new)/.test(label) && label.includes("phone");
      });
      if (!rotate) return { acted: false, key: null, needsPhoneReset: true };
      return actOnce("rotate-phone", rotate);
    }

    const methodLabel = (element) => normalize(
      element.labels?.[0]?.textContent
      || element.getAttribute("aria-label")
      || element.innerText
      || element.textContent
      || element.value,
    );
    const methodControls = [
      ...document.querySelectorAll("input[type='radio']"),
      ...clickables,
    ];
    // The two controls can swap positions after the country changes. Prefer
    // the channel's real form value and only fall back to its visible label.
    const smsMethod = methodControls.find((element) =>
      normalize(element.getAttribute("value") || element.value) === "sms"
    ) || methodControls.find((element) => {
      const label = methodLabel(element);
      return label === "sms" || label === "text message" || label.includes("via sms");
    });
    const smsMethodSelected = smsMethod && (
      smsMethod.checked
      || smsMethod.getAttribute("aria-selected") === "true"
      || smsMethod.getAttribute("aria-pressed") === "true"
      || smsMethod.getAttribute("data-state") === "active"
      || /(^|\\s)(active|selected)(\\s|$)/i.test(smsMethod.className || "")
    );
    const phoneField = findVisible("input[type='tel']");
    const phoneNumber = ${JSON.stringify(values.phoneNumber ?? "")};
    const phoneMethodPage = Boolean(
      phoneField
      && phoneNumber
      && (
        /\\/add-phone\\/?$/.test(location.pathname)
        || methodControls.some((element) => methodLabel(element).includes("whatsapp"))
      )
    );
    // React can render the phone field before the delivery-method controls.
    // Never submit during that gap because WhatsApp is the page default.
    if (phoneMethodPage && (!smsMethod || smsMethod.disabled || smsMethod.getAttribute("aria-disabled") === "true")) {
      return { acted: false, key: null, waitingForSmsMethod: true };
    }

    const targetPhoneDigits = phoneNumber.replace(/\\D/g, "");
    const fieldPhoneDigits = String(phoneField?.value || "").replace(/\\D/g, "");
    const phoneValueSettled = fieldPhoneDigits.length >= 6 && (
      targetPhoneDigits.endsWith(fieldPhoneDigits)
      || fieldPhoneDigits.endsWith(targetPhoneDigits)
    );
    if (phoneMethodPage && !phoneValueSettled) {
      // Filling an international number changes the country and re-renders the
      // delivery tabs. Stop here and select SMS only after that render settles.
      const key = pageBase + "|phone-fill|" + phoneNumber;
      phoneField.focus();
      setNative(phoneField, "", "deleteContentBackward");
      setNative(phoneField, "+", "insertText", "+");
      await nextFrame();
      setNative(phoneField, phoneNumber, "insertText", phoneNumber.slice(1));
      phoneField.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      await nextFrame();
      return { acted: true, key, action: "phone-fill", filled: phoneField.value, url: location.href };
    }

    const smsMethodKey = pageBase + "|sms-method-after-phone|" + phoneNumber;
    if (smsMethod && phoneMethodPage && !previousKeys.has(smsMethodKey)) {
      // Click the visible label when available so React receives the same
      // interaction as a user click. Never infer the channel from tab order.
      const smsClickTarget = [...(smsMethod.labels || [])].find(visible) || smsMethod;
      smsClickTarget.click();
      await nextFrame();
      return {
        acted: true,
        key: smsMethodKey,
        action: "sms-method",
        smsSelected: Boolean(smsMethod.checked),
        url: location.href,
      };
    }
    if (smsMethod && !smsMethodSelected) {
      const key = smsMethodKey;
      if (!previousKeys.has(key)) {
        smsMethod.click();
        return { acted: true, key, action: "sms-method" };
      }
      // Do not proceed to the number until the page confirms that SMS became
      // selected. This avoids racing the React state update.
      if (phoneMethodPage) return { acted: false, key, waitingForSmsMethod: true };
    }

    if (phoneField && phoneNumber) {
      // The key carries the number so a rejected one can be replaced in place.
      const key = pageBase + "|phone|" + phoneNumber;
      if (previousKeys.has(key)) return { acted: false, key };
      if (!phoneMethodPage) {
        phoneField.focus();
        setNative(phoneField, "", "deleteContentBackward");
        setNative(phoneField, "+", "insertText", "+");
        await nextFrame();
        setNative(phoneField, phoneNumber, "insertText", phoneNumber.slice(1));
        phoneField.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        await nextFrame();
      }
      if (phoneMethodPage && !smsMethodSelected) {
        return { acted: false, key: null, waitingForSmsMethod: true };
      }
      if (!submitNear(phoneField)) return { acted: false, key: null };
      return {
        acted: true,
        key,
        action: "phone",
        filled: phoneField.value,
        smsSelected: Boolean(smsMethodSelected),
        url: location.href,
      };
    }

    const fieldSteps = [
      {
        action: "email",
        selector: "input[type='email'], input[autocomplete='username'], input[name='email']",
        value: ${JSON.stringify(automation.email)},
        keyed: false,
      },
      {
        action: "password",
        selector: "input[type='password'][autocomplete='current-password'], input[type='password'], input[name='password']",
        value: ${JSON.stringify(automation.password)},
        keyed: false,
      },
      {
        action: "sms-code",
        selector: CODE_SELECTOR,
        value: ${JSON.stringify(values.smsCode ?? "")},
        keyed: true,
      },
      {
        action: "totp",
        selector: CODE_SELECTOR,
        value: ${JSON.stringify(values.totpCode ?? "")},
        keyed: true,
      },
    ];
    for (const step of fieldSteps) {
      const field = findVisible(step.selector);
      if (!field || !step.value) continue;
      if (step.action === "totp") {
        // Re-check the live DOM immediately before typing. The page can move
        // from account 2FA to phone verification after the main-process probe.
        const prompt = normalize(
          field.closest("form, main, section")?.innerText
          || document.body?.innerText,
        );
        if (/phone-verification|check your phone|verification code.{0,80}sent to|sent to \\+?\\d|resend text message|text message|sms|whatsapp|phone number ending/.test(
          location.href.toLowerCase() + " " + prompt,
        )) {
          return { acted: false, key: null, blockedTotpOnPhonePrompt: true };
        }
      }
      // Codes are keyed by value so a fresh code can retry after a rejection.
      const key = pageBase + "|" + step.action + (step.keyed ? "|" + step.value : "");
      if (previousKeys.has(key)) return { acted: false, key };
      field.focus();
      setNative(field, step.value, "insertText", step.value);
      field.dispatchEvent(new Event("change", { bubbles: true }));
      await nextFrame();
      if (!submitNear(field)) return { acted: false, key: null };
      return { acted: true, key, action: step.action };
    }

    // Consent/final pages have no credential field. Click the exact Continue
    // action immediately; "another account" has already been prioritized.
    const continueButton = clickables.find((element) =>
      normalize(element.innerText || element.value || element.textContent) === "continue",
    );
    if (/\\/add-phone\\/?$/.test(location.pathname)) {
      return { acted: false, key: null, waitingForPhoneForm: true };
    }
    if (continueButton) return actOnce("continue", continueButton);
    return { acted: false, key: null };
  })()`;
}

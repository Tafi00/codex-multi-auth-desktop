import assert from "node:assert/strict";
import test from "node:test";

import { guestChromeLaunchOptions } from "./controlled-chrome.js";

test("launches an English Chrome Guest through Playwright", () => {
  assert.deepEqual(guestChromeLaunchOptions("/Applications/Google Chrome"), {
    executablePath: "/Applications/Google Chrome",
    headless: false,
    locale: "en-US",
    args: ["--guest", "--lang=en-US", "--no-first-run", "--no-default-browser-check"],
  });
});

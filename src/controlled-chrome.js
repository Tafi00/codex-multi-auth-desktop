import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_CHROME_EXECUTABLE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

chromium.use(StealthPlugin());

export function guestChromeLaunchOptions(chromeExecutable = DEFAULT_CHROME_EXECUTABLE) {
  return {
    executablePath: chromeExecutable,
    headless: false,
    locale: "en-US",
    args: [
      "--guest",
      "--lang=en-US",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  };
}

async function removeTemporaryProfile(profileDirectory) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(profileDirectory, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

export async function createControlledGuestChrome(url, {
  chromeExecutable = DEFAULT_CHROME_EXECUTABLE,
} = {}) {
  const profileDirectory = await fs.mkdtemp(join(tmpdir(), "codex-login-chrome-"));
  let context = null;
  let page = null;
  let closeTask = null;
  let closed = false;
  let closeEmitted = false;
  const navigationListeners = new Set();
  const closeListeners = new Set();

  const emitClose = () => {
    if (closeEmitted) return;
    closeEmitted = true;
    for (const listener of closeListeners) listener();
  };
  const close = () => {
    if (closeTask) return closeTask;
    closeTask = (async () => {
      closed = true;
      emitClose();
      await context?.close().catch(() => undefined);
      await removeTemporaryProfile(profileDirectory);
    })();
    return closeTask;
  };

  try {
    context = await chromium.launchPersistentContext(
      profileDirectory,
      guestChromeLaunchOptions(chromeExecutable),
    );
    page = context.pages()[0] ?? await context.newPage();
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        for (const listener of navigationListeners) listener();
      }
    });
    page.on("close", () => {
      closed = true;
      emitClose();
      void close();
    });
    context.on("close", () => {
      closed = true;
      emitClose();
      void removeTemporaryProfile(profileDirectory);
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });

    return {
      close,
      isDestroyed: () => closed || page.isClosed(),
      isLoading: () => false,
      getURL: () => page.url(),
      executeJavaScript: (expression) => page.evaluate(expression),
      canGoBack: () => page.evaluate(() => history.length > 1),
      goBack: () => page.goBack({ waitUntil: "domcontentloaded" }),
      onNavigation: (listener) => navigationListeners.add(listener),
      onClosed: (listener) => closeListeners.add(listener),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

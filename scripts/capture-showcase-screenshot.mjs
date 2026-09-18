import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "http://127.0.0.1:5173";
const MOBILE_BREAKPOINT = 820;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const values = new Map();
  const switches = new Set();
  const valueOptions = new Set([
    "--route",
    "--width",
    "--height",
    "--output",
    "--base-url",
    "--wait-ms",
    "--scroll-selector",
    "--click-text",
    "--type-selector",
    "--type-text",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force" || argument === "--reduced-motion") {
      switches.add(argument);
      continue;
    }

    if (!valueOptions.has(argument)) {
      fail(`Unknown argument: ${argument}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for ${argument}.`);
    }

    values.set(argument, value);
    index += 1;
  }

  for (const required of ["--route", "--width", "--height", "--output"]) {
    if (!values.has(required)) {
      fail(`Missing required argument: ${required}`);
    }
  }

  return { values, switches };
}

function parseDimension(value, name) {
  const dimension = Number(value);
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > 10000) {
    fail(`${name} must be an integer from 1 through 10000.`);
  }
  return dimension;
}

function parseWaitMilliseconds(value) {
  const milliseconds = Number(value);
  if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 10000) {
    fail("Wait milliseconds must be an integer from 0 through 10000.");
  }
  return milliseconds;
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function resolveLoopbackTargetUrl(route, baseUrl) {
  const hasAbsoluteScheme = /^[A-Za-z][A-Za-z\d+.-]*:/u.test(route);
  if (!route.startsWith("/") || route.startsWith("//") || hasAbsoluteScheme) {
    fail(
      "Route must stay on the validated loopback origin; external, absolute, and protocol-relative URLs are not allowed.",
    );
  }

  const targetUrl = new URL(route, baseUrl);
  if (targetUrl.origin !== baseUrl.origin) {
    fail(
      "Route must stay on the validated loopback origin; external, absolute, and protocol-relative URLs are not allowed.",
    );
  }

  return targetUrl;
}

function findBrowser() {
  const candidates = [
    {
      name: "Google Chrome",
      path: process.env.ProgramFiles
        ? join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe")
        : null,
    },
    {
      name: "Google Chrome",
      path: process.env["ProgramFiles(x86)"]
        ? join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe")
        : null,
    },
    {
      name: "Google Chrome",
      path: process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
        : null,
    },
    {
      name: "Microsoft Edge",
      path: process.env.ProgramFiles
        ? join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe")
        : null,
    },
    {
      name: "Microsoft Edge",
      path: process.env["ProgramFiles(x86)"]
        ? join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe")
        : null,
    },
  ];

  const browser = candidates.find((candidate) => candidate.path && existsSync(candidate.path));
  if (!browser) {
    fail("No installed Google Chrome or Microsoft Edge executable was found.");
  }
  return browser;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForDevToolsPort(profileDirectory, browserProcess) {
  const portFile = join(profileDirectory, "DevToolsActivePort");
  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    if (browserProcess.exitCode !== null) {
      fail(`Browser exited before DevTools was ready (code ${browserProcess.exitCode}).`);
    }

    try {
      const [portLine] = (await readFile(portFile, "utf8")).trim().split(/\r?\n/u);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0) {
        return port;
      }
    } catch {
      // The browser creates this file after its debugging endpoint is ready.
    }

    await delay(100);
  }

  fail("Timed out waiting for the browser DevTools endpoint.");
}

async function waitForPageTarget(port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        const targets = await response.json();
        const pageTarget = targets.find(
          (target) => target.type === "page" && target.webSocketDebuggerUrl,
        );
        if (pageTarget) {
          return pageTarget.webSocketDebuggerUrl;
        }
      }
    } catch {
      // Retry while Chrome finishes exposing the initial page target.
    }

    await delay(100);
  }

  fail("Timed out waiting for a browser page target.");
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolveConnection, rejectConnection) => {
    const timeout = setTimeout(
      () => rejectConnection(new Error("Timed out connecting to browser DevTools.")),
      10000,
    );

    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolveConnection();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        rejectConnection(new Error("Browser DevTools WebSocket failed to connect."));
      },
      { once: true },
    );
  });

  let nextId = 1;
  const pending = new Map();
  const eventWaiters = new Map();
  const eventObservers = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) {
        request.reject(new Error(`${request.method}: ${message.error.message}`));
      } else {
        request.resolve(message.result);
      }
      return;
    }

    if (message.method && eventWaiters.has(message.method)) {
      const waiters = eventWaiters.get(message.method);
      eventWaiters.delete(message.method);
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.resolve(message.params ?? {});
      }
    }

    if (message.method && eventObservers.has(message.method)) {
      for (const observer of eventObservers.get(message.method)) {
        observer(message.params ?? {});
      }
    }
  });

  function send(method, params = {}, timeoutMilliseconds = 10000) {
    const id = nextId;
    nextId += 1;
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`${method}: timed out.`));
      }, timeoutMilliseconds);

      pending.set(id, {
        method,
        resolve: resolveRequest,
        reject: rejectRequest,
        timeout,
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  function once(method, timeoutMilliseconds = 10000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const timeout = setTimeout(() => {
        const waiters = eventWaiters.get(method) ?? [];
        eventWaiters.set(
          method,
          waiters.filter((waiter) => waiter.resolve !== resolveEvent),
        );
        rejectEvent(new Error(`${method}: event timed out.`));
      }, timeoutMilliseconds);

      const waiters = eventWaiters.get(method) ?? [];
      waiters.push({ resolve: resolveEvent, timeout });
      eventWaiters.set(method, waiters);
    });
  }

  function observe(method, observer) {
    const observers = eventObservers.get(method) ?? [];
    observers.push(observer);
    eventObservers.set(method, observers);
  }

  return { send, once, observe };
}

async function evaluateValue(cdp, expression, options = {}) {
  const result = await cdp.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: options.awaitPromise ?? false,
      returnByValue: true,
    },
    options.timeoutMilliseconds ?? 10000,
  );

  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? "Unknown browser evaluation error.";
    fail(description);
  }

  return result.result.value;
}

function validatePng(png, expectedWidth, expectedHeight) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (png.length < 24 || !png.subarray(0, 8).equals(signature)) {
    fail("Browser response does not contain a valid PNG signature.");
  }

  const actualWidth = png.readUInt32BE(16);
  const actualHeight = png.readUInt32BE(20);
  if (actualWidth !== expectedWidth || actualHeight !== expectedHeight) {
    fail(
      `Screenshot dimensions are ${actualWidth}x${actualHeight}; expected ${expectedWidth}x${expectedHeight}.`,
    );
  }

  return { actualWidth, actualHeight };
}

async function main() {
  const { values, switches } = parseArguments(process.argv.slice(2));
  const route = values.get("--route");
  const reducedMotion = switches.has("--reduced-motion");

  const width = parseDimension(values.get("--width"), "Width");
  const height = parseDimension(values.get("--height"), "Height");
  const waitMilliseconds = parseWaitMilliseconds(values.get("--wait-ms") ?? "500");
  const scrollSelector = values.get("--scroll-selector") ?? null;
  const clickText = values.get("--click-text") ?? null;
  const typeSelector = values.get("--type-selector") ?? null;
  const rawTypeText = values.get("--type-text") ?? null;
  if ((typeSelector === null) !== (rawTypeText === null)) {
    fail("--type-selector and --type-text must be provided together.");
  }
  const typeText = rawTypeText?.replaceAll("\\n", "\n") ?? null;
  const baseUrl = new URL(values.get("--base-url") ?? DEFAULT_BASE_URL);
  if (!["http:", "https:"].includes(baseUrl.protocol) || !isLoopbackHostname(baseUrl.hostname)) {
    fail("Base URL must use HTTP or HTTPS on a loopback host.");
  }

  const targetUrl = resolveLoopbackTargetUrl(route, baseUrl);
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const requestedOutput = values.get("--output");
  const outputPath = isAbsolute(requestedOutput)
    ? resolve(requestedOutput)
    : resolve(repositoryRoot, requestedOutput);
  const outputRelativePath = relative(repositoryRoot, outputPath);

  if (
    outputRelativePath === ".." ||
    outputRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(outputRelativePath)
  ) {
    fail(`Output path must resolve inside the repository: ${repositoryRoot}`);
  }
  if (extname(outputPath).toLowerCase() !== ".png") {
    fail("Output path must end in .png.");
  }
  if ((await pathExists(outputPath)) && !switches.has("--force")) {
    fail(`Output file already exists. Pass --force to replace it: ${outputPath}`);
  }

  let routeResponse;
  try {
    routeResponse = await fetch(targetUrl, { signal: AbortSignal.timeout(10000) });
  } catch (error) {
    fail(`The local route is not reachable at ${targetUrl.href}: ${error.message}`);
  }
  if (!routeResponse.ok) {
    fail(`The local route returned HTTP ${routeResponse.status}: ${targetUrl.href}`);
  }
  await routeResponse.body?.cancel();

  const browser = findBrowser();
  const profilePrefix = join(tmpdir(), "hermes-screenshot-");
  const profileDirectory = await mkdtemp(profilePrefix);
  const browserProcess = spawn(
    browser.path,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--disable-extensions",
      "--disable-background-networking",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDirectory}`,
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );

  let cdp = null;
  const consoleErrors = [];
  const networkFailures = [];
  try {
    const port = await waitForDevToolsPort(profileDirectory, browserProcess);
    cdp = await connectCdp(await waitForPageTarget(port));
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    cdp.observe("Runtime.consoleAPICalled", (event) => {
      if (event.type === "error" || event.type === "assert") {
        consoleErrors.push(event.type);
      }
    });
    cdp.observe("Runtime.exceptionThrown", () => {
      consoleErrors.push("uncaught-exception");
    });
    cdp.observe("Network.loadingFailed", (event) => {
      if (!event.canceled) networkFailures.push(event.errorText ?? "unknown");
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width <= MOBILE_BREAKPOINT,
      screenWidth: width,
      screenHeight: height,
    });
    await cdp.send("Emulation.setScrollbarsHidden", { hidden: true });
    if (reducedMotion) {
      await cdp.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
    }

    const loaded = cdp.once("Page.loadEventFired", 15000);
    const navigation = await cdp.send("Page.navigate", { url: targetUrl.href });
    if (navigation.errorText) {
      fail(`Browser navigation failed: ${navigation.errorText}`);
    }
    await loaded;

    const settleExpression = `
          (async () => {
            await document.fonts.ready;
            const visibleImages = [...document.images].filter((image) => {
              const rect = image.getBoundingClientRect();
              return rect.bottom >= 0 && rect.top <= innerHeight + 100;
            });
            await Promise.all(visibleImages.map((image) => {
              if (image.complete) return Promise.resolve();
              return new Promise((resolveImage) => {
                const finish = () => resolveImage();
                image.addEventListener("load", finish, { once: true });
                image.addEventListener("error", finish, { once: true });
                setTimeout(finish, 5000);
              });
            }));
            await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
            return true;
          })()
        `;
    await evaluateValue(cdp, settleExpression, {
      awaitPromise: true,
      timeoutMilliseconds: 10000,
    });

    if (waitMilliseconds > 0) await delay(waitMilliseconds);

    if (typeSelector !== null && typeText !== null) {
      const typeResult = await evaluateValue(
        cdp,
        `
          (() => {
            const selector = ${JSON.stringify(typeSelector)};
            const text = ${JSON.stringify(typeText)};
            const element = document.querySelector(selector);
            if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
              return { ok: false, reason: "selector did not resolve to an input or textarea" };
            }
            if (element.disabled) return { ok: false, reason: "target field is disabled" };
            const prototype = element instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
            if (!setter) return { ok: false, reason: "native value setter unavailable" };
            setter.call(element, text);
            element.dispatchEvent(new InputEvent("input", {
              bubbles: true,
              inputType: "insertText",
              data: text,
            }));
            element.focus();
            return { ok: true, length: element.value.length };
          })()
        `,
      );
      if (!typeResult?.ok) {
        fail(`Could not type into ${typeSelector}: ${typeResult?.reason ?? "unknown error"}.`);
      }
      await delay(100);
    }

    if (clickText !== null) {
      const clickResult = await evaluateValue(
        cdp,
        `
          (() => {
            const text = ${JSON.stringify(clickText)};
            const candidates = [...document.querySelectorAll("button, a")].filter((element) =>
              element.textContent.trim() === text && !element.disabled
            );
            if (candidates.length !== 1) {
              return { ok: false, count: candidates.length };
            }
            candidates[0].click();
            return { ok: true };
          })()
        `,
      );
      if (!clickResult?.ok) {
        fail(`Click text must match exactly one enabled button or link: ${clickText} (matched ${clickResult?.count ?? 0}).`);
      }
    }

    if (scrollSelector !== null) {
      const scrollResult = await evaluateValue(
        cdp,
        `
          (() => {
            const selector = ${JSON.stringify(scrollSelector)};
            const element = document.querySelector(selector);
            if (!element) return { ok: false };
            element.scrollIntoView({ block: "center", inline: "nearest" });
            return { ok: true };
          })()
        `,
      );
      if (!scrollResult?.ok) fail(`Scroll selector did not match an element: ${scrollSelector}`);
    }

    if (waitMilliseconds > 0) await delay(waitMilliseconds);
    await evaluateValue(cdp, settleExpression, {
      awaitPromise: true,
      timeoutMilliseconds: 10000,
    });

    const metrics = await evaluateValue(
      cdp,
      `
        (() => {
          const menu = document.querySelector(".menu-button");
          const desktopNavigation = document.querySelector(".desktop-nav");
          const captureTarget = ${JSON.stringify(scrollSelector)}
            ? document.querySelector(${JSON.stringify(scrollSelector)})
            : null;
          const targetRect = captureTarget?.getBoundingClientRect() ?? null;
          const fontRequests = performance.getEntriesByType("resource").filter((entry) =>
            entry.initiatorType === "font" || /\\.(woff2?|ttf|otf)(\\?|$)/iu.test(entry.name)
          );
          const brokenImages = [...document.images].filter((image) =>
            image.complete && image.naturalWidth === 0
          );
          return {
            href: location.href,
            pathname: location.pathname,
            innerWidth,
            innerHeight,
            devicePixelRatio,
            prefersReducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
            documentScrollWidth: document.documentElement.scrollWidth,
            bodyScrollWidth: document.body.scrollWidth,
            menuDisplay: menu ? getComputedStyle(menu).display : null,
            desktopNavigationDisplay: desktopNavigation
              ? getComputedStyle(desktopNavigation).display
              : null,
            brokenImageCount: brokenImages.length,
            brokenImageSources: brokenImages.map((image) => image.currentSrc || image.src),
            fontRequestCount: fontRequests.length,
            statusLabels: [...document.querySelectorAll(".status-badge")]
              .map((element) => element.textContent.trim()),
            navigationLabels: [...document.querySelectorAll(".bottom-nav button")]
              .map((element) => element.textContent.trim()),
            activeNavigation: document.querySelector(".bottom-nav button.active")?.textContent.trim() ?? null,
            targetVisible: targetRect === null || (
              targetRect.width > 0 &&
              targetRect.height > 0 &&
              targetRect.bottom > 0 &&
              targetRect.top < innerHeight &&
              targetRect.right > 0 &&
              targetRect.left < innerWidth
            ),
          };
        })()
      `,
    );

    if (reducedMotion && !metrics.prefersReducedMotion) {
      fail("Reduced-motion emulation was requested but the rendered page does not match prefers-reduced-motion: reduce.");
    }
    if (metrics.pathname !== targetUrl.pathname) {
      fail(`Rendered route is ${metrics.pathname}; expected ${targetUrl.pathname}.`);
    }
    if (metrics.innerWidth !== width || metrics.innerHeight !== height) {
      fail(
        `CSS viewport is ${metrics.innerWidth}x${metrics.innerHeight}; expected ${width}x${height}.`,
      );
    }
    if (metrics.documentScrollWidth > width || metrics.bodyScrollWidth > width) {
      fail(
        `Rendered page overflows horizontally: document=${metrics.documentScrollWidth}, body=${metrics.bodyScrollWidth}, viewport=${width}.`,
      );
    }
    if (metrics.brokenImageCount > 0) {
      fail(`Rendered page contains ${metrics.brokenImageCount} broken image(s).`);
    }
    if (metrics.fontRequestCount > 0) {
      fail(`Rendered page made ${metrics.fontRequestCount} font request(s); expected system fonts only.`);
    }
    if (!metrics.targetVisible) {
      fail(`Scroll target is not visible in the capture viewport: ${scrollSelector}`);
    }
    if (consoleErrors.length > 0) {
      fail(`Browser console reported ${consoleErrors.length} error event(s).`);
    }
    if (
      width <= MOBILE_BREAKPOINT &&
      (metrics.menuDisplay === "none" || metrics.desktopNavigationDisplay !== "none")
    ) {
      fail(
        `Mobile layout was not active: menu=${metrics.menuDisplay}, desktop-nav=${metrics.desktopNavigationDisplay}.`,
      );
    }

    const screenshot = await cdp.send(
      "Page.captureScreenshot",
      {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      },
      15000,
    );
    const png = Buffer.from(screenshot.data, "base64");
    const dimensions = validatePng(png, width, height);

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, png, {
      flag: switches.has("--force") ? "w" : "wx",
    });

    console.log(`BROWSER=${browser.name}`);
    console.log(`BROWSER_PATH=${browser.path}`);
    console.log(`URL=${metrics.href}`);
    console.log(`VIEWPORT=${dimensions.actualWidth}x${dimensions.actualHeight}`);
    console.log(`CSS_VIEWPORT=${metrics.innerWidth}x${metrics.innerHeight}`);
    console.log(`REDUCED_MOTION=${reducedMotion ? "EMULATED" : "DEFAULT"}`);
    console.log(`PREFERS_REDUCED_MOTION=${metrics.prefersReducedMotion ? "reduce" : "no-preference"}`);
    console.log(`SCROLL_WIDTH=${metrics.documentScrollWidth}`);
    console.log(
      `LAYOUT=${width <= MOBILE_BREAKPOINT ? "MOBILE" : "DESKTOP"}`,
    );
    console.log(`MENU_DISPLAY=${metrics.menuDisplay}`);
    console.log(`DESKTOP_NAV_DISPLAY=${metrics.desktopNavigationDisplay}`);
    console.log(`BROKEN_IMAGES=${metrics.brokenImageCount}`);
    console.log(`FONT_REQUESTS=${metrics.fontRequestCount}`);
    console.log(`CONSOLE_ERRORS=${consoleErrors.length}`);
    console.log(`NETWORK_FAILURES=${networkFailures.length}`);
    console.log(`STATUS_LABELS=${metrics.statusLabels.join(" | ")}`);
    console.log(`NAVIGATION_LABELS=${metrics.navigationLabels.join(" | ")}`);
    console.log(`ACTIVE_NAVIGATION=${metrics.activeNavigation ?? "NONE"}`);
    console.log(`WAIT_MS=${waitMilliseconds}`);
    console.log(`SCROLL_SELECTOR=${scrollSelector ?? "NONE"}`);
    console.log(`CLICK_TEXT=${clickText ?? "NONE"}`);
    console.log(`TYPE_SELECTOR=${typeSelector ?? "NONE"}`);
    console.log(`BYTES=${png.length}`);
    console.log(`OUTPUT=${outputPath}`);
  } finally {
    if (cdp) {
      try {
        await cdp.send("Browser.close", {}, 2000);
      } catch {
        // Browser.close commonly closes the socket before acknowledging.
      }
    }

    await delay(300);
    if (browserProcess.exitCode === null) {
      browserProcess.kill();
    }

    const resolvedTemporaryRoot = resolve(tmpdir()) + sep;
    const resolvedProfileDirectory = resolve(profileDirectory);
    if (
      resolvedProfileDirectory.startsWith(resolvedTemporaryRoot) &&
      resolvedProfileDirectory.slice(resolvedTemporaryRoot.length).startsWith(
        "hermes-screenshot-",
      )
    ) {
      await rm(resolvedProfileDirectory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    }
  }
}

main().catch((error) => {
  console.error(`CAPTURE_FAILED: ${error.message}`);
  process.exitCode = 1;
});

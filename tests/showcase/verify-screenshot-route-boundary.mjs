import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const captureScript = join(repositoryRoot, "scripts", "capture-showcase-screenshot.mjs");
const outputPath = join(
  repositoryRoot,
  "tests",
  "showcase",
  `.route-boundary-${process.pid}.png`,
);
const outputArgument = relative(repositoryRoot, outputPath);
const unavailableBrowserRoot = join(repositoryRoot, "tests", "showcase", ".no-browser");
const expectedRouteError =
  /Route must stay on the validated loopback origin; external, absolute, and protocol-relative URLs are not allowed\./u;

function runCapture(route, extraArguments = []) {
  return spawnSync(
    process.execPath,
    [
      captureScript,
      "--route",
      route,
      "--width",
      "1",
      "--height",
      "1",
      "--wait-ms",
      "0",
      "--output",
      outputArgument,
      ...extraArguments,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ProgramFiles: unavailableBrowserRoot,
        "ProgramFiles(x86)": unavailableBrowserRoot,
        LOCALAPPDATA: unavailableBrowserRoot,
      },
      timeout: 5000,
      windowsHide: true,
    },
  );
}

const rejectedRoutes = [
  "//example.invalid/path",
  "https://example.invalid/",
  "http://example.invalid/",
  "file:///C:/Windows/win.ini",
  "data:text/html,hello",
  "javascript:alert(1)",
];

try {
  for (const route of rejectedRoutes) {
    const result = runCapture(route);
    assert.notEqual(result.status, 0, `${route} must fail non-zero.`);
    assert.match(result.stderr, expectedRouteError, `${route} must report the route-origin boundary.`);
    assert.equal(existsSync(outputPath), false, `${route} must not create a screenshot.`);
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      /^BROWSER=/mu,
      `${route} must fail before browser capture output.`,
    );
    console.log(`ok - rejected before capture: ${route}`);
  }

  const externalBaseResult = runCapture("/", [
    "--base-url",
    "https://example.invalid/",
  ]);
  assert.notEqual(externalBaseResult.status, 0, "An external base URL must fail non-zero.");
  assert.match(
    externalBaseResult.stderr,
    /Base URL must use HTTP or HTTPS on a loopback host\./u,
    "An external base URL must report the loopback-host boundary.",
  );
  assert.equal(existsSync(outputPath), false, "An external base URL must not create a screenshot.");
  assert.doesNotMatch(
    `${externalBaseResult.stdout}\n${externalBaseResult.stderr}`,
    /^BROWSER=/mu,
    "An external base URL must fail before browser capture output.",
  );
  console.log("ok - rejected before capture: external base URL");
  console.log(`${rejectedRoutes.length + 1} route-boundary checks passed.`);
} finally {
  rmSync(outputPath, { force: true });
}

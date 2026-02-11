import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const chromeCandidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
].filter(Boolean);

function resolveChromePath() {
  for (const candidate of chromeCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("Chrome executable not found. Set CHROME_PATH.");
}

async function firstSelector(page, selectors, timeoutMs = 15000) {
  const timeoutAt = Date.now() + timeoutMs;

  while (Date.now() < timeoutAt) {
    for (const selector of selectors) {
      const handle = await page.$(selector);
      if (handle) {
        return { handle, selector };
      }
    }
    await page.waitForTimeout(100);
  }

  throw new Error(`None of the selectors were found: ${selectors.join(", ")}`);
}

const traceFile = process.env.PROFILE_OUT ?? "expo-footguns-trace.json";
const outputPath = path.resolve(process.cwd(), "profiles", traceFile);
const url = process.env.PROFILE_URL ?? "http://localhost:8081";

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const browser = await puppeteer.launch({
  executablePath: resolveChromePath(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  await page.tracing.start({
    path: outputPath,
    screenshots: false,
    categories: [
      "devtools.timeline",
      "blink.user_timing",
      "v8",
      "disabled-by-default-v8.cpu_profiler",
    ],
  });

  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  await firstSelector(page, ["#lab-ready", "[data-testid='lab-ready']", "[aria-label='lab-ready']"], 20000);

  const { handle: searchInput } = await firstSelector(page, [
    "#search-box",
    "[data-testid='search-box']",
    "input[aria-label='search-box']",
  ]);

  // Idle period to capture interval/context churn cadence.
  await page.waitForTimeout(6500);

  await searchInput.click();
  await searchInput.type("mm", { delay: 40 });

  const { handle: addButton } = await firstSelector(page, [
    "#add-item-button",
    "[data-testid='add-item-button']",
    "[aria-label='add-item-button']",
  ]);

  for (let i = 0; i < 3; i += 1) {
    await addButton.click();
    await page.waitForTimeout(400);
  }

  await page.waitForTimeout(1500);

  await page.tracing.stop();
  console.log(`Saved trace: ${outputPath}`);
} finally {
  await browser.close();
}

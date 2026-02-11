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

const outputPath = path.resolve(process.cwd(), "profiles/next-footguns-trace.json");
const url = process.env.PROFILE_URL ?? "http://localhost:3001";

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
  await page.waitForSelector("#search-box", { timeout: 15000 });

  // Idle period to capture interval/context churn cadence.
  await page.waitForTimeout(6500);

  await page.click("#search-box");
  await page.type("#search-box", "mm", { delay: 40 });

  for (let i = 0; i < 3; i += 1) {
    await page.getByText("Add Item").click();
    await page.waitForTimeout(400);
  }

  await page.waitForTimeout(1500);

  await page.tracing.stop();
  console.log(`Saved trace: ${outputPath}`);
} finally {
  await browser.close();
}

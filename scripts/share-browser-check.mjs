import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
const root = ".local/share-demo";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(60000);
const errors = [];
page.on("requestfailed", (request) => console.log("Request failed", new URL(request.url()).origin, request.failure()?.errorText));
page.on("pageerror", (error) => errors.push(error.message));
const accountText = readFileSync(process.env.ADEENA_TEST_ACCOUNTS_FILE || "C:/dev/adeena-test-accounts.env", "utf8");
function setting(name) { const line = accountText.split(/\r?\n/).find((line) => line.startsWith(`${name}=`)); if (!line) throw new Error(`Missing ${name}`); return line.slice(name.length + 1).trim(); }
try {
  await page.goto("http://localhost:3012/login?next=/creator");
  await page.getByLabel("Email", { exact: true }).fill(setting("ADEENA_TEST_USER_A_EMAIL"));
  await page.getByLabel("Password", { exact: true }).fill(setting("ADEENA_TEST_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/creator", { timeout: 90000 });
  console.log("Verified real creator sign-in through browser.");
  await page.getByRole("button", { name: "Create new experience" }).click();
  await page.waitForURL("**/creator/w/**");
  await page.getByLabel("Source file").setInputFiles({ name: `water-share-${Date.now()}.md`, mimeType: "text/markdown", buffer: Buffer.from("# Water\n\n## Rivers\n\n" + "Water moves through rivers and returns to the sea. Learners compare the source note and explain what happens using only this passage. ".repeat(4)) });
  await page.locator("#source-rights").selectOption("permission-asserted");
  await page.getByRole("button", { name: "Upload source", exact: true }).click();
  await page.getByRole("radio", { name: /water-share/ }).last().check();
  await page.getByRole("button", { name: "Save source", exact: true }).click();
  await page.locator("#workflow-audience").selectOption({ label: "Primary learners" });
  await page.locator("#workflow-age").selectOption("8-10");
  await page.getByRole("button", { name: "Save audience", exact: true }).click();
  await page.getByRole("button", { name: "Recommend a starting topic" }).click();
  await expect(page.getByText("Selected topic:", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Create playable experience", exact: true }).click();
  await page.getByRole("link", { name: "Open private preview" }).click();
  await page.waitForURL("**/creator/preview/**");
  await expect(page.getByRole("heading", { name: "Share", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Record rights clearance" })).toBeVisible();
  writeFileSync(`${root}/preview.json`, JSON.stringify({ previewUrl: page.url() }));
  await context.storageState({ path: `${root}/creator-session.json` });
  console.log("Created playable experience through the ordinary creator workflow.");
  console.log((await page.locator("body").innerText()).slice(-6500));
  await page.screenshot({ path: `${root}/creator-blocked-desktop.png`, fullPage: true });
  if (errors.length) throw new Error(errors.join("\n"));
} catch (error) {
  await page.screenshot({ path: `${root}/browser-failure.png`, fullPage: true });
  console.log((await page.locator("body").innerText()).slice(-5000));
  throw error;
} finally { await browser.close(); }

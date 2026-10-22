import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
const root = ".local/share-demo";
const { previewUrl } = JSON.parse(readFileSync(`${root}/preview.json`, "utf8"));
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const creator = await browser.newContext({ storageState: `${root}/creator-session.json`, viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await creator.newPage();
page.setDefaultTimeout(60000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const guest = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36" });
const learner = await guest.newPage();
learner.on("pageerror", (error) => errors.push(error.message));
learner.setDefaultTimeout(60000);
const external = [];
learner.on("request", (request) => { if (!request.url().startsWith("http://localhost:3012") && !request.url().startsWith("data:")) external.push(new URL(request.url()).origin); });
async function noOverflow(target) { expect(await target.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); }
async function play(target) {
  console.log("Player controls:", await target.getByRole("button").allTextContents());
  const start = target.getByRole("button", { name: /Start|Begin|Play/, exact: false });
  if (await start.count()) await start.first().click();
  await target.getByRole("button", { name: "Read the source note", exact: true }).click();
  await target.getByRole("button", { name: "Keep the source wording", exact: true }).click();
  await expect(target.getByRole("heading", { name: "Note kept", exact: true })).toBeVisible();
}
try {
  await page.goto(previewUrl);
  await expect(page.getByRole("button", { name: "Record rights clearance" }).or(page.getByRole("button", { name: "Approve this version", exact: true }))).toBeVisible();
  await page.getByRole("heading", { name: "Share", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${root}/creator-blocked-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  await noOverflow(page);
  await page.screenshot({ path: `${root}/creator-blocked-mobile.png`, fullPage: true });
  if (await page.getByRole("button", { name: "Record rights clearance" }).count()) {
  await page.getByLabel("Ownership or licence evidence").fill("I authored this synthetic water passage for this demonstration and permit public adaptation and sharing. No third-party content is included.");
  await page.getByLabel("I confirm I may adapt", { exact: false }).check();
  await page.getByRole("button", { name: "Record rights clearance", exact: true }).click();
  }
  await expect(page.getByRole("button", { name: "Approve this version", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  await play(page);
  for (const path of [["Set the source note aside"], ["Read the source note", "Replace it with a new claim"]]) {
    await page.getByRole("button", { name: "Play again", exact: true }).click();
    if (await page.getByRole("button", { name: "Begin", exact: true }).count()) await page.getByRole("button", { name: "Begin", exact: true }).click();
    for (const choice of path) await page.getByRole("button", { name: choice, exact: true }).click();
    await expect(page.getByRole("heading", { name: "Note set aside", exact: true })).toBeVisible();
  }
  await page.getByLabel("I reviewed this exact playable version", { exact: false }).check();
  await page.getByLabel("Review note", { exact: true }).fill("Reviewed both source-note choices and all outcomes. The water passage is supported, suitable for ages 8-10, and contains no identifiable learner information or unresolved high-risk material.");
  await page.getByRole("button", { name: "Approve this version", exact: true }).click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const canonical = page.getByLabel("Canonical URL", { exact: true });
  await expect(canonical).toHaveValue(/http:\/\/localhost:3012\/play\/r\//);
  const url = await canonical.inputValue();
  const releaseId = url.split("/").at(-1);
  await page.getByRole("button", { name: "Copy link", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  await expect(page.getByRole("img", { name: "QR code for the learner link" })).toBeVisible();
  const qrData = await page.getByRole("img", { name: "QR code for the learner link" }).getAttribute("src");
  writeFileSync(`${root}/learner-qr.png`, Buffer.from(qrData.split(",")[1], "base64"));
  await noOverflow(page);
  await page.getByRole("heading", { name: "Share with a learner" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${root}/creator-published-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${root}/creator-published-desktop.png`, fullPage: true });
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Open as learner", exact: true }).click();
  const popup = await popupPromise;
  await popup.waitForURL(url);
  await popup.close();
  expect(await guest.cookies()).toEqual([]);
  const response = await guest.request.get(`http://localhost:3012/api/releases/${releaseId}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const original = await response.json();
  const text = JSON.stringify(original);
  for (const forbidden of ["private://", "storage_locator", "approval_evidence", "recorded_by", "postgresql://", "supabase", previewUrl.split("/").at(-1)]) expect(text).not.toContain(forbidden);
  await learner.goto(url);
  await play(learner);
  await noOverflow(learner);
  await learner.screenshot({ path: `${root}/guest-completed-mobile.png`, fullPage: true });
  await learner.setViewportSize({ width: 1280, height: 900 });
  await learner.screenshot({ path: `${root}/guest-completed-desktop.png`, fullPage: true });
  expect(await guest.cookies()).toEqual([]);
  expect(external).toEqual([]);
  writeFileSync(`${root}/demonstration.json`, JSON.stringify({ previewUrl, url, releaseId, authenticatedCreator: true, anonymousCookies: 0, mobileWidth: 360, clipboardMatches: true, externalGuestRequests: external, browserErrors: errors }, null, 2));
  if (process.argv.includes("--revoke")) {
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(page.getByText("This version was revoked permanently.", { exact: false })).toBeVisible();
    await expect(learner.getByRole("button", { name: /Read the source note/ })).toHaveCount(0, { timeout: 25000 });
    await expect.poll(async () => (await guest.request.get(`http://localhost:3012/api/releases/${releaseId}`)).status()).toBe(404);
    await learner.reload();
    await expect(learner.getByText(/unavailable|no longer available/i)).toBeVisible();
    await learner.screenshot({ path: `${root}/guest-revoked.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ previewUrl, url, checks: "rights, approval, publish, clipboard, QR, open learner, desktop, 360px Android, anonymous completion, guest privacy", revoked: process.argv.includes("--revoke"), errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${root}/publication-failure.png`, fullPage: true });
  console.log((await page.locator("body").innerText()).slice(-6500));
  throw error;
} finally { await browser.close(); }

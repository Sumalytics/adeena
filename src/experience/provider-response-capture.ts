import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_BYTES = 128_000;
const MAX_FILES = 8;
const MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/** Local MVP debugging only. Never stores request headers, keys, or prompt text. */
export function captureProviderResponse(env: Record<string, string | undefined>, stage: string, raw: string | null) {
  if (env.ADEENA_CAPTURE_PROVIDER_RESPONSES !== "local-mvp"
    || env.ADEENA_RUNTIME !== "local-development"
    || env.NODE_ENV === "production" || process.env.NODE_ENV === "production"
    || !raw || Buffer.byteLength(raw, "utf8") > MAX_BYTES) return null;

  const directory = path.join(process.cwd(), ".local", "provider-response-captures");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const identity = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
    const sid = /^"[^"]+","(S-\d+(?:-\d+)+)"/.exec(identity.trim())?.[1];
    if (!sid) throw new Error("Private provider capture identity was unavailable.");
    execFileSync("icacls", [directory, "/inheritance:r"], { stdio: "ignore" });
    execFileSync("icacls", [directory, "/grant:r", `*${sid}:(OI)(CI)F`], { stdio: "ignore" });
  } else {
    chmodSync(directory, 0o700);
  }

  const now = Date.now();
  const existing = readdirSync(directory).filter((file) => /^[0-9a-f-]{36}\.json$/.test(file));
  for (const file of existing) {
    const target = path.join(directory, file);
    if (now - statSync(target).mtimeMs > MAX_AGE_MS) unlinkSync(target);
  }
  const remaining = readdirSync(directory).filter((file) => /^[0-9a-f-]{36}\.json$/.test(file));
  remaining.sort((a, b) => statSync(path.join(directory, a)).mtimeMs - statSync(path.join(directory, b)).mtimeMs);
  for (const file of remaining.slice(0, Math.max(0, remaining.length - MAX_FILES + 1))) unlinkSync(path.join(directory, file));

  const filename = `${randomUUID()}.json`;
  writeFileSync(path.join(directory, filename), JSON.stringify({ stage, receivedAt: new Date(now).toISOString(), body: raw }), { flag: "wx", mode: 0o600 });
  return filename;
}

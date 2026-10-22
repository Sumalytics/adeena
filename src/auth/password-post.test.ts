import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { handleLoginPost, handleRegisterPost, resetPasswordPostLimits, type AuthCookie } from "./password-post";

const password = "long-enough";

function post(path: string, fields: Record<string, string>, init?: { origin?: string; site?: string; url?: string; type?: string }) {
  const body = new URLSearchParams(fields);
  return new Request(init?.url ?? `http://adeena.test${path}`, {
    method: "POST",
    headers: {
      origin: init?.origin ?? "http://adeena.test",
      "content-type": init?.type ?? "application/x-www-form-urlencoded",
      "sec-fetch-site": init?.site ?? "same-origin",
    },
    body,
  });
}

describe("password POST fallback", () => {
  beforeEach(() => {
    resetPasswordPostLimits();
  });

  it("posts both password forms and does not leave a GET method", () => {
    const login = readFileSync("src/app/login/login-form.tsx", "utf8");
    const register = readFileSync("src/app/register/register-form.tsx", "utf8");
    expect(login).toContain('method="post"');
    expect(login).toContain('action="/auth/login"');
    expect(register).toContain('method="post"');
    expect(register).toContain('action="/auth/register"');
    expect(login).not.toMatch(/method=["']get["']/i);
    expect(register).not.toMatch(/method=["']get["']/i);
  });

  it("rejects a cross-origin login before authentication", async () => {
    let called = false;
    const response = await handleLoginPost(post("/auth/login", { email: "creator@example.com", password }, { origin: "https://evil.test" }), async () => {
      called = true;
      return { ok: true, cookies: [] };
    });
    expect(called).toBe(false);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://adeena.test/login?error=rejected");
    expect(await response.text()).not.toContain(password);
  });

  it("keeps a failed login and an open redirect out of the URL", async () => {
    const response = await handleLoginPost(
      post("/auth/login", { email: "creator@example.com", password, next: "https://evil.test" }, { url: "http://adeena.test/auth/login?password=query-secret" }),
      async () => ({ ok: false, code: "credentials", cookies: [] }),
    );
    const location = response.headers.get("location") ?? "";
    expect(response.status).toBe(303);
    expect(location).toBe("http://adeena.test/login?error=credentials&next=%2Fcreator");
    expect(location).not.toContain(password);
    expect(location).not.toContain("query-secret");
    const text = await response.text();
    expect(text).not.toContain(password);
    expect(text).not.toContain("query-secret");
  });

  it("signs in with a validated return path and httpOnly session cookies", async () => {
    const cookies: AuthCookie[] = [{ name: "sb-session", value: "opaque", options: { httpOnly: true, path: "/", sameSite: "lax" } }];
    const response = await handleLoginPost(
      post("/auth/login", { email: "creator@example.com", password, next: "/creator/preview/22222222-2222-4222-8222-222222222222" }),
      async () => ({ ok: true, cookies }),
    );
    const location = response.headers.get("location") ?? "";
    expect(response.status).toBe(303);
    expect(location).toBe("http://adeena.test/creator/preview/22222222-2222-4222-8222-222222222222");
    expect(location).not.toContain(password);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("limits repeated attempts for one email before calling authentication", async () => {
    let calls = 0;
    const signIn = async () => {
      calls += 1;
      return { ok: false as const, code: "credentials", cookies: [] };
    };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await handleLoginPost(post("/auth/login", { email: "creator@example.com", password }), signIn);
    }
    const limited = await handleLoginPost(post("/auth/login", { email: "creator@example.com", password }), signIn);
    expect(calls).toBe(8);
    expect(limited.headers.get("location")).toContain("error=limited");
  });

  it("confirms registration without creating a session or echoing the email", async () => {
    const response = await handleRegisterPost(
      post("/auth/register", { email: "creator@example.com", password }),
      async () => ({ ok: true, cookies: [], session: false }),
    );
    const location = response.headers.get("location") ?? "";
    expect(location).toBe("http://adeena.test/register?status=confirm");
    expect(location).not.toContain("creator@example.com");
    expect(location).not.toContain(password);
  });

  it("rejects an oversized password form before authentication", async () => {
    let called = false;
    const response = await handleLoginPost(
      post("/auth/login", { email: "creator@example.com", password: "x".repeat(2100) }),
      async () => {
        called = true;
        return { ok: true, cookies: [] };
      },
    );
    expect(called).toBe(false);
    expect(response.headers.get("location")).toContain("error=rejected");
  });
});

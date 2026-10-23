import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), claims: vi.fn(), config: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.create }));
vi.mock("./public-config", () => ({ supabaseBrowserConfig: mocks.config }));

import { proxy } from "@/proxy";

describe("Supabase session proxy", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.config.mockReturnValue({ url: "https://project.supabase.co", key: "publishable-key" });
    mocks.create.mockImplementation((_url, _key, options) => ({ auth: { getClaims: async () => {
      options.cookies.setAll(
        [{ name: "sb-project-auth-token", value: "refreshed", options: { path: "/", sameSite: "lax" } }],
        { "cache-control": "private, no-cache, no-store", expires: "0", pragma: "no-cache" },
      );
      return mocks.claims();
    } } }));
  });

  it("accepts verified claims and returns refreshed cookies with cache headers", async () => {
    mocks.claims.mockReturnValue({ data: { claims: { sub: "58ac8d72-2067-42a8-808b-207b3251508f" } }, error: null });
    const response = await proxy(new NextRequest("https://adeena.test/creator"));
    expect(response.status).toBe(200);
    expect(response.cookies.get("sb-project-auth-token")?.value).toBe("refreshed");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("expires")).toBe("0");
  });

  it("copies refreshed auth state onto API denials and login redirects", async () => {
    mocks.claims.mockReturnValue({ data: null, error: { code: "session_not_found" } });
    const api = await proxy(new NextRequest("https://adeena.test/api/creator/workflows"));
    expect(api.status).toBe(401);
    expect(api.cookies.get("sb-project-auth-token")?.value).toBe("refreshed");
    expect(api.headers.get("cache-control")).toContain("no-store");
    const page = await proxy(new NextRequest("https://adeena.test/creator/w/11111111-1111-4111-8111-111111111111"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toContain("/login?next=%2Fcreator%2Fw%2F11111111-1111-4111-8111-111111111111");
    expect(page.cookies.get("sb-project-auth-token")?.value).toBe("refreshed");
  });
});

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sharedShelf } from "@adeena/experience-schema";

const mocks = vi.hoisted(() => ({ read: vi.fn(), database: vi.fn(), session: vi.fn(), publish: vi.fn(), revoke: vi.fn(), authConfig: vi.fn() }));
vi.mock("@/auth/database", () => ({ creatorDatabase: mocks.database }));
vi.mock("@/auth/session", () => ({ readVerifiedSession: mocks.session }));
vi.mock("@/auth/public-config", () => ({ supabaseBrowserConfig: mocks.authConfig }));
vi.mock("@/db/release-repository", () => ({ readPublicRelease: mocks.read }));
vi.mock("@/auth/releases", () => ({ creatorPublishResponse: mocks.publish, creatorRevokeResponse: mocks.revoke }));
vi.mock("next/server", async (original) => ({ ...await original<typeof import("next/server")>(), connection: vi.fn() }));

import { GET } from "@/app/api/releases/[releaseId]/route";
import { POST } from "@/app/api/creator/releases/route";
import { DELETE } from "@/app/api/creator/releases/[releaseId]/route";
import { proxy } from "@/proxy";

describe("release HTTP boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authConfig.mockImplementation(() => { throw new Error("Guest must not need Supabase"); });
  });

  it("serves guests without authentication and checks every read, including after revocation", async () => {
    const releaseId = randomUUID();
    const request = new Request(`https://adeena.test/api/releases/${releaseId}`);
    const context = { params: Promise.resolve({ releaseId }) };
    mocks.read.mockResolvedValueOnce(sharedShelf).mockResolvedValueOnce(null);
    const first = await GET(request, context);
    expect(first.status).toBe(200);
    expect((await first.json()).manifest).toEqual(sharedShelf);
    const revoked = await GET(request, context);
    expect(revoked.status).toBe(404);
    expect(await revoked.json()).toEqual({ error: "release-unavailable" });
    for (const response of [first, revoked]) {
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    }
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.session).not.toHaveBeenCalled();
    for (const route of [`/play/r/${releaseId}`, `/api/releases/${releaseId}`]) {
      const response = await proxy(new NextRequest(`https://adeena.test${route}`));
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("location")).toBeNull();
    }
    expect(mocks.authConfig).not.toHaveBeenCalled();
  });

  it("fails closed without leaking database errors", async () => {
    mocks.read.mockRejectedValue(new Error("private://secret connection"));
    const response = await GET(new Request("https://adeena.test/api/releases/missing"), { params: Promise.resolve({ releaseId: randomUUID() }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "release-unavailable" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects cross-origin and anonymous mutations before database use", async () => {
    const context = { params: Promise.resolve({ releaseId: randomUUID() }) };
    for (const method of ["POST", "DELETE"]) {
      const request = new Request("https://adeena.test/api/creator/releases", { method, headers: { origin: "https://untrusted.test" } });
      const result = method === "POST" ? await POST(request) : await DELETE(request, context);
      expect(result.status).toBe(403);
    }
    expect(mocks.session).not.toHaveBeenCalled();
    mocks.session.mockResolvedValue(null);
    expect((await POST(new Request("https://adeena.test/api/creator/releases", { method: "POST", headers: { origin: "https://adeena.test" } }))).status).toBe(401);
    expect((await DELETE(new Request("https://adeena.test/api/creator/releases", { method: "DELETE", headers: { origin: "https://adeena.test" } }), context)).status).toBe(401);
    expect(mocks.database).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), claims: vi.fn() }));
vi.mock("./server", () => ({ createSupabaseServer: mocks.create }));

import { readVerifiedSession } from "./session";

describe("verified creator session", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.create.mockResolvedValue({ auth: { getClaims: mocks.claims } });
  });

  it("mints the application identity only from verified claims", async () => {
    mocks.claims.mockResolvedValue({ data: { claims: { sub: "58ac8d72-2067-42a8-808b-207b3251508f" } }, error: null });
    expect(await readVerifiedSession()).toMatchObject({ userId: "58ac8d72-2067-42a8-808b-207b3251508f" });
    expect(mocks.claims).toHaveBeenCalledOnce();
  });

  it("rejects absent, invalid and errored claims", async () => {
    for (const result of [
      { data: null, error: { code: "session_not_found" } },
      { data: { claims: {} }, error: null },
      { data: { claims: { sub: "not-a-uuid" } }, error: null },
    ]) {
      mocks.claims.mockResolvedValueOnce(result);
      expect(await readVerifiedSession()).toBeNull();
    }
  });
});

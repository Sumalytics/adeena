import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { SYNTHETIC_WORKSPACE_ID } from "@/contracts/common";
import { validateCredentials } from "./credentials";
import { safeNextPath } from "./paths";
import { sessionFromAuthUser } from "./subject";

describe("verified auth subject", () => {
  it("rejects a missing, synthetic, or malformed subject", () => {
    expect(sessionFromAuthUser(null)).toBeNull();
    expect(sessionFromAuthUser({ id: null })).toBeNull();
    expect(sessionFromAuthUser({ id: "not-a-uuid" })).toBeNull();
    expect(sessionFromAuthUser({ id: SYNTHETIC_WORKSPACE_ID })).toBeNull();
  });

  it("keeps the next path inside the creator area", () => {
    const development = { NODE_ENV: "development", ADEENA_RUNTIME: "local-development" };
    const production = { NODE_ENV: "production", ADEENA_RUNTIME: "local-development" };
    expect(safeNextPath(null)).toBe("/creator");
    expect(safeNextPath("https://example.test")).toBe("/creator");
    expect(safeNextPath("//example.test")).toBe("/creator");
    expect(safeNextPath("/creator/../studio")).toBe("/creator");
    expect(safeNextPath("/studio")).toBe("/creator");
    expect(safeNextPath("/studio", production)).toBe("/creator");
    expect(safeNextPath("/studio", development)).toBe("/studio");
    expect(safeNextPath("/creator/sources")).toBe("/creator/sources");
    expect(safeNextPath("/creator/preview/22222222-2222-4222-8222-222222222222")).toBe(
      "/creator/preview/22222222-2222-4222-8222-222222222222",
    );
  });

  it("checks email and password shape before calling Supabase", () => {
    expect(validateCredentials("creator@example.com", "long-enough")).toBeNull();
    expect(validateCredentials("not-an-email", "long-enough")).toBe("Enter a valid email.");
    expect(validateCredentials("creator@example.com", "short")).toBe("Use a password between 8 and 72 characters.");
  });

  it("keeps production identity minting in the auth subject", () => {
    const files = sourceFiles(path.join(process.cwd(), "src")).filter((file) => {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) return false;
      return readFileSync(file, "utf8").includes("identityFromVerifiedSubject");
    });
    expect(files.map((file) => path.basename(file)).sort()).toEqual(["identity.ts", "subject.ts"]);
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

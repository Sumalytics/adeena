import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("source ingestion stays off the client and Studio routes", () => {
  it("does not import extraction or the test membership issuer from application routes", () => {
    const roots = ["src/app", "src/studio", "src/player", "packages"].map((directory) => path.join(process.cwd(), directory));
    const offenders = roots.flatMap(sourceFiles).filter((file) => {
      const source = readFileSync(file, "utf8");
      return (
        source.includes("pdfjs-dist") ||
        source.includes("issueMembershipForIsolatedTests") ||
        source.includes("issueIdentityForIsolatedTests") ||
        source.includes("@/source") ||
        source.includes("@/db") ||
        source.includes("@/storage") ||
        source.includes("drizzle-orm") ||
        source.includes('from "postgres"') ||
        source.includes("identityFromVerifiedSubject") ||
        source.includes("DATABASE_URL") ||
        source.includes("SERVICE_ROLE") ||
        source.includes("SUPABASE_SERVICE_ROLE")
      );
    });
    expect(offenders).toEqual([]);
  });

  it("keeps database access out of client components", () => {
    const files = sourceFiles(path.join(process.cwd(), "src/app")).filter((file) =>
      readFileSync(file, "utf8").includes('"use client"'),
    );
    const offenders = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      return (
        source.includes("@/db") ||
        source.includes("@/auth/session") ||
        source.includes("@/auth/database") ||
        source.includes("@/auth/creator") ||
        source.includes("postgres") ||
        source.includes("drizzle-orm")
      );
    });
    expect(offenders).toEqual([]);
  });

  it("does not expose a private upload route", () => {
    const api = path.join(process.cwd(), "src/app/api");
    const routes = sourceFiles(api).map((file) => file.replaceAll("\\", "/"));
    expect(routes.some((file) => file.includes("/upload"))).toBe(false);
  });

  it("keeps the Studio file control on the device", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/studio/studio-app.tsx"), "utf8");
    expect(source).toContain("The file stays on this device and was not uploaded.");
    expect(source).toContain("Generate preview");
  });
});

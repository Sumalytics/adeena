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
      return source.includes("pdfjs-dist") || source.includes("issueMembershipForIsolatedTests") || source.includes("@/source");
    });
    expect(offenders).toEqual([]);
  });

  it("keeps the Studio file control on the device", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/studio/studio-app.tsx"), "utf8");
    expect(source).toContain("The file stays on this device and was not uploaded.");
    expect(source).toContain("Generate preview");
  });
});

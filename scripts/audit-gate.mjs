import { execSync } from "node:child_process";

const ESCALATED_ADVISORIES = new Set(["GHSA-vfj7-8cjw-p6xm"]);
const ESCALATED_PACKAGES = new Set([
  "braces",
  "micromatch",
  "fast-glob",
  "@next/eslint-plugin-next",
  "eslint-config-next",
]);

let raw = "";
try {
  raw = execSync("npm audit --json", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout ?? "") : "";
  raw = stdout;
  if (!raw) throw error;
}

const report = JSON.parse(raw);
const vulnerabilities = Object.values(report.vulnerabilities ?? {});
const unexpected = [];

for (const vulnerability of vulnerabilities) {
  if (vulnerability.severity !== "high" && vulnerability.severity !== "critical") continue;
  const via = Array.isArray(vulnerability.via) ? vulnerability.via : [];
  const advisoryIds = via
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const match = String(item.url ?? "").match(/GHSA-[a-z0-9-]+/i);
      return match ? match[0] : String(item.url ?? item.title ?? "unknown-advisory");
    });
  const viaPackages = via.filter((item) => typeof item === "string");
  const unknownAdvisory = advisoryIds.some((id) => !ESCALATED_ADVISORIES.has(id));
  const outsideChain =
    !ESCALATED_PACKAGES.has(vulnerability.name) ||
    viaPackages.some((name) => !ESCALATED_PACKAGES.has(name));
  if (unknownAdvisory || outsideChain) unexpected.push({ name: vulnerability.name, advisoryIds, viaPackages });
  else console.log(`escalated ${vulnerability.name} ${advisoryIds.join(",") || viaPackages.join(",")}`);
}

if (unexpected.length > 0) {
  console.error(JSON.stringify(unexpected, null, 2));
  process.exit(1);
}

console.log("audit gate passed with the escalated braces advisory chain only");

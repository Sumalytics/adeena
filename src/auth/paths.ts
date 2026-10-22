import { studioFixturesAllowed } from "@/studio/availability";

type RuntimeEnv = {
  NODE_ENV?: string;
  ADEENA_RUNTIME?: string;
};

export function safeNextPath(value: string | null, env: RuntimeEnv = process.env) {
  if (!value || value.length > 200) return "/creator";
  if (value.startsWith("//") || value.includes("\\") || value.includes("://")) return "/creator";
  if (value.includes("..") || value.includes("%") || /[?#\s]/.test(value)) return "/creator";
  if (value === "/creator") return "/creator";
  if (value.startsWith("/creator/") && /^\/creator\/[A-Za-z0-9/_-]+$/.test(value)) return value;
  if (value === "/studio" && studioFixturesAllowed(env)) return "/studio";
  return "/creator";
}

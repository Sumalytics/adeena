const ENABLED_RUNTIMES = new Set(["local-development", "nonproduction-test"]);

type RuntimeEnv = {
  NODE_ENV?: string;
  ADEENA_RUNTIME?: string;
};

/** Synthetic Studio is closed unless the server runtime explicitly allows development fixtures. */
export function studioFixturesAllowed(env: RuntimeEnv = process.env) {
  const nodeEnv = env.NODE_ENV?.trim() ?? "";
  const runtime = env.ADEENA_RUNTIME?.trim() ?? "";
  if (nodeEnv === "production" || runtime === "production") return false;
  return ENABLED_RUNTIMES.has(runtime);
}

export function isStudioApiPath(pathname: string) {
  return pathname === "/api/studio" || pathname.startsWith("/api/studio/");
}

export function isStudioPagePath(pathname: string) {
  return pathname === "/studio" || pathname.startsWith("/studio/");
}

export function studioDeniedResponse() {
  return Response.json(
    { error: "not-found" },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}

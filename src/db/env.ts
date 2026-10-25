import { readFileSync } from "node:fs";

/** Administration connection from DATABASE_URL. Migrations use this. The application must not. */
export function databaseUrl(): string {
  return postgresUrl("DATABASE_URL");
}

/** Least-privileged application connection. It must not be a superuser. */
export function applicationDatabaseUrl(): string {
  return postgresUrl("ADEENA_APP_DATABASE_URL");
}

/** Dedicated visual-worker connection. It must authenticate as the worker role. */
export function visualWorkerDatabaseUrl(): string {
  const value = postgresUrl("ADEENA_VISUAL_WORKER_DATABASE_URL");
  let username = "";
  try {
    username = decodeURIComponent(new URL(value).username);
  } catch {
    throw new Error("ADEENA_VISUAL_WORKER_DATABASE_URL must be a PostgreSQL connection URL.");
  }
  if (username !== "adeena_visual_worker") {
    throw new Error("ADEENA_VISUAL_WORKER_DATABASE_URL must authenticate as adeena_visual_worker.");
  }
  return value;
}

function postgresUrl(name: string) {
  const configured = process.env[name]?.trim();
  const value = configured || readLocalSetting(name);
  if (!value.startsWith("postgresql://") && !value.startsWith("postgres://")) {
    throw new Error(`${name} must be a PostgreSQL connection URL.`);
  }
  return value;
}

function readLocalSetting(name: string) {
  let text = "";
  try {
    text = readFileSync(".env.local", "utf8");
  } catch {
    throw new Error(`${name} is not configured.`);
  }
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export function redactDatabaseMessage(value: string) {
  return value.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgresql://redacted").slice(0, 240);
}

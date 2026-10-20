import { readFileSync } from "node:fs";

/** Administration connection from DATABASE_URL. Migrations use this. The application must not. */
export function databaseUrl(): string {
  return postgresUrl("DATABASE_URL");
}

/** Least-privileged application connection. It must not be a superuser. */
export function applicationDatabaseUrl(): string {
  return postgresUrl("ADEENA_APP_DATABASE_URL");
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

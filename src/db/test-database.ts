import { redactDatabaseMessage } from "./env";
import { openDatabase, type DatabaseClient } from "./client";

export const TEST_DATABASE = "adeena_test";

export function databaseName(url: string) {
  const match = /^postgres(?:ql)?:\/\/[^/]+\/([^/?]+)/i.exec(url);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

export function urlForDatabase(url: string, database: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(database)) throw new Error("database name was rejected");
  if (!/^postgres(?:ql)?:\/\/[^/]+\/[^/?]+/i.test(url)) throw new Error("database url could not be isolated");
  return url.replace(/^((?:postgres(?:ql)?:\/\/[^/]+)\/)[^/?]+/i, `$1${database}`);
}

function roleName(url: string) {
  const match = /^postgres(?:ql)?:\/\/([^:/?#]+)(?::[^@]*)?@/i.exec(url);
  const role = match?.[1] ? decodeURIComponent(match[1]) : "";
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error("database role name was rejected");
  return role;
}

export async function workspaceIds(url: string) {
  const sql = openDatabase(url);
  try {
    const rows = await sql<{ id: string }[]>`select id::text as id from workspaces order by 1`;
    return rows.map((row) => row.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/does not exist|relation/i.test(message)) return null;
    throw new Error(redactDatabaseMessage(message || "workspace snapshot failed"));
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/** Opens adeena_test for integration tests. The developer database is not migrated. */
export async function openDisposableDatabases(adminUrl: string, applicationUrl: string) {
  if (databaseName(adminUrl) === TEST_DATABASE || databaseName(applicationUrl) === TEST_DATABASE) {
    throw new Error("The disposable test database must be separate from the developer database.");
  }
  const maintenance = openDatabase(urlForDatabase(adminUrl, "postgres"));
  try {
    await maintenance.unsafe(`CREATE DATABASE ${TEST_DATABASE}`);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code !== "42P04") throw new Error(redactDatabaseMessage(error instanceof Error ? error.message : "database setup failed"));
  }
  await maintenance.unsafe(`GRANT CONNECT, TEMP ON DATABASE ${TEST_DATABASE} TO ${roleName(applicationUrl)}`);
  await maintenance.end({ timeout: 1 });
  const admin = openDatabase(urlForDatabase(adminUrl, TEST_DATABASE));
  const app = openDatabase(urlForDatabase(applicationUrl, TEST_DATABASE));
  return { admin, app };
}

export async function closeDatabases(...clients: DatabaseClient[]) {
  for (const client of clients) await client.end({ timeout: 1 });
}

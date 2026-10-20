import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema";
import { redactDatabaseMessage } from "./env";

export type Database = PostgresJsDatabase<typeof schema>;
export type DatabaseClient = Sql;

export function openDatabase(url: string) {
  return postgres(url, {
    max: 4,
    prepare: false,
    connect_timeout: 5,
    idle_timeout: 5,
    connection: { application_name: "adeena" },
    onnotice() {},
  });
}

export function databaseForTransaction(parent: Sql, transaction: Sql) {
  const client = transaction as Sql & { options?: Sql["options"] };
  if (!client.options) client.options = parent.options;
  return drizzle(client, { schema });
}

export function databaseFailure(error: unknown) {
  const message = error instanceof Error ? redactDatabaseMessage(error.message) : "The database is unavailable.";
  const failure = new Error(message || "The database is unavailable.");
  failure.name = "DatabaseFailure";
  return failure;
}

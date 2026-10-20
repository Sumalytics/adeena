import { openDatabase, type DatabaseClient } from "@/db/client";
import { applicationDatabaseUrl } from "@/db/env";

let application: DatabaseClient | undefined;

/** Least-privileged application connection. This is not the migration superuser. */
export function creatorDatabase() {
  application ??= openDatabase(applicationDatabaseUrl());
  return application;
}

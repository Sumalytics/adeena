import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { databaseFailure } from "./client";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrations = ["0001_ingestion", "0002_creator_workspace", "0003_membership_force", "0004_topic_recommendation", "0005_experience_generation", "0006_experience_editing", "0007_edit_spend", "0008_free_development", "0009_creator_workflows"] as const;

function script(name: string) {
  return readFileSync(path.join(directory, "migrations", name), "utf8");
}

export async function migrateUp(sql: Sql) {
  try {
    await sql`CREATE TABLE IF NOT EXISTS adeena_schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`REVOKE ALL ON TABLE adeena_schema_migrations FROM PUBLIC`;
    const applied: string[] = [];
    for (const id of migrations) {
      const existing = await sql`SELECT id FROM adeena_schema_migrations WHERE id = ${id}`;
      if (existing.length > 0) continue;
      await sql.begin(async (tx) => {
        await tx.unsafe(script(`${id}.up.sql`));
        await tx`INSERT INTO adeena_schema_migrations (id) VALUES (${id})`;
      });
      applied.push(id);
    }
    return { ids: applied, applied: applied.length > 0 };
  } catch (error) {
    throw databaseFailure(error);
  }
}

export async function migrateDown(sql: Sql) {
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(script("0009_creator_workflows.down.sql"));
      await tx.unsafe(script("0008_free_development.down.sql"));
      await tx.unsafe(script("0007_edit_spend.down.sql"));
      await tx.unsafe(script("0006_experience_editing.down.sql"));
      await tx.unsafe(script("0005_experience_generation.down.sql"));
      await tx.unsafe(script("0004_topic_recommendation.down.sql"));
      await tx.unsafe(script("0003_membership_force.down.sql"));
      await tx.unsafe(script("0002_creator_workspace.down.sql"));
      await tx.unsafe(script("0001_ingestion.down.sql"));
      await tx`DROP TABLE IF EXISTS adeena_schema_migrations`;
    });
  } catch (error) {
    throw databaseFailure(error);
  }
}

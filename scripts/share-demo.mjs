import { readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import postgres from "postgres";
import nextEnv from "@next/env";
nextEnv.loadEnvConfig(process.cwd());
const directory = ".local/share-demo";
mkdirSync(directory, { recursive: true });
function isolated(url, name) { const parsed = new URL(url); parsed.pathname = `/${name}`; return parsed.href; }
const mode = process.argv[2];
if (mode === "setup") {
  const name = `adeena_share_demo_${Date.now()}`;
  const maintenance = postgres(isolated(process.env.DATABASE_URL, "postgres"), { onnotice() {} });
  const developer = postgres(process.env.DATABASE_URL, { onnotice() {} });
  const before = await developer`select id from adeena_schema_migrations order by id`;
  await maintenance.unsafe(`CREATE DATABASE ${name}`);
  const admin = postgres(isolated(process.env.DATABASE_URL, name), { onnotice() {} });
  await admin`CREATE TABLE adeena_schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const files = readdirSync("src/db/migrations").filter((file) => file.endsWith(".up.sql")).sort();
  for (const file of files) await admin.begin(async (tx) => {
    await tx.unsafe(readFileSync(`src/db/migrations/${file}`, "utf8"));
    await tx`INSERT INTO adeena_schema_migrations(id) VALUES (${file.replace(".up.sql", "")})`;
  });
  const after = await developer`select id from adeena_schema_migrations order by id`;
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Developer migration ledger changed");
  writeFileSync(`${directory}/database.json`, JSON.stringify({ name, migrations: files, developerMigrations: before.map((row) => row.id) }, null, 2));
  await Promise.all([admin.end(), maintenance.end(), developer.end()]);
  console.log(`Migrated isolated database ${name}; developer ledger unchanged.`);
} else if (mode === "refresh-eligibility") {
  // Development-only: refresh the uncommitted migration function in this isolated demo.
  const { name } = JSON.parse(readFileSync(`${directory}/database.json`, "utf8"));
  if (!/^adeena_share_demo_[0-9]+$/.test(name)) throw new Error("Not an isolated demo database");
  const admin = postgres(isolated(process.env.DATABASE_URL, name), { onnotice() {} });
  const migration = readFileSync("src/db/migrations/0012_creator_share.up.sql", "utf8");
  const start = migration.indexOf("CREATE FUNCTION adeena.publication_blocks");
  const end = migration.indexOf("REVOKE ALL ON FUNCTION adeena.publication_blocks", start);
  await admin.unsafe(migration.slice(start, end).replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"));
  await admin.end();
  console.log("Refreshed isolated demo eligibility function.");
} else if (mode === "serve") {
  const { name } = JSON.parse(readFileSync(`${directory}/database.json`, "utf8"));
  if (!/^adeena_share_demo_[0-9]+$/.test(name)) throw new Error("Not an isolated demo database");
  const env = { ...process.env, ADEENA_DIST_DIR: ".local/share-demo/next", DATABASE_URL: isolated(process.env.DATABASE_URL, name), ADEENA_APP_DATABASE_URL: isolated(process.env.ADEENA_APP_DATABASE_URL, name), ADEENA_EXPERIENCE_PROVIDER: "deterministic-fixture" };
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--port", "3012"], { env, stdio: "inherit", windowsHide: true });
  child.on("exit", (code) => process.exit(code ?? 1));
} else throw new Error("Use setup or serve");



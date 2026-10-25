import postgres from "postgres";

const sql = postgres(process.env.ADEENA_VISUAL_WORKER_DATABASE_URL, { max: 1, idle_timeout: 5, connect_timeout: 5 });
try {
  const [claim] = await sql`select * from adeena.claim_visual_generation_job('restart-probe'::text,5::integer,null::uuid)`;
  process.stdout.write(`${JSON.stringify(claim ?? null)}\n`);
} finally {
  await sql.end({ timeout: 1 });
}

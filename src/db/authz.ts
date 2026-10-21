import { SYNTHETIC_WORKSPACE_ID } from "@/contracts/common";
import { SourceError } from "@/source/errors";
import type { Sql } from "postgres";
import { databaseForTransaction, type Database } from "./client";
import { assertVerifiedIdentity, type VerifiedIdentity } from "./identity";

const authorizationBrand = Symbol("adeena.authorized-workspace");

/** Binds the verified user for this transaction and clears any session-scoped value. */
export async function bindVerifiedActor(tx: Sql, userId: string) {
  await tx`select set_config('adeena.user_id', '', false)`;
  await tx`select set_config('adeena.user_id', ${userId}, true)`;
}

export type AuthorizedWorkspace = {
  readonly [authorizationBrand]: true;
  readonly userId: string;
  readonly workspaceId: string;
  readonly db: Database;
  readonly tx: Sql;
};

export async function withWorkspace<T>(
  sql: Sql,
  identity: VerifiedIdentity,
  workspaceId: string,
  run: (workspace: AuthorizedWorkspace) => Promise<T>,
) {
  const actor = assertVerifiedIdentity(identity);
  if (workspaceId === SYNTHETIC_WORKSPACE_ID) throw new SourceError("unauthenticated");
  return sql.begin(async (tx) => {
    await bindVerifiedActor(tx as unknown as Sql, actor.userId);
    const allowed = await tx`select adeena.is_active_member(${workspaceId}::uuid) as ok`;
    if (allowed[0]?.ok !== true) throw new SourceError("unauthenticated");
    return run({
      [authorizationBrand]: true,
      userId: actor.userId,
      workspaceId,
      db: databaseForTransaction(sql, tx as unknown as Sql),
      tx: tx as unknown as Sql,
    });
  });
}

export async function createWorkspace(
  sql: Sql,
  identity: VerifiedIdentity,
  input: { id: string; name: string; workspaceType: "personal" | "organization" },
) {
  const actor = assertVerifiedIdentity(identity);
  if (input.id === SYNTHETIC_WORKSPACE_ID) throw new SourceError("unauthenticated");
  await sql.begin(async (tx) => {
    await bindVerifiedActor(tx as unknown as Sql, actor.userId);
    await tx`select adeena.create_workspace(${input.id}::uuid, ${input.name}, ${input.workspaceType}, ${actor.userId}::uuid)`;
  });
}

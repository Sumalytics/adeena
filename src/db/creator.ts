import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { SYNTHETIC_WORKSPACE_ID } from "@/contracts/common";
import { SourceError } from "@/source/errors";
import { bindVerifiedActor, withWorkspace } from "./authz";
import { assertVerifiedIdentity, type VerifiedIdentity } from "./identity";

export async function ensureIndividualWorkspace(sql: Sql, identity: VerifiedIdentity) {
  const actor = assertVerifiedIdentity(identity);
  return sql.begin(async (tx) => {
    await bindVerifiedActor(tx as unknown as Sql, actor.userId);
    await tx`select pg_advisory_xact_lock(hashtextextended(${actor.userId}, 0))`;
    const existing = await tx<{ workspace_id: string; status: string }[]>`
      select workspace_id, status from adeena.personal_workspace_for_session()
    `;
    const row = existing[0];
    if (row?.status === "inactive") throw new SourceError("unauthenticated");
    if (row?.workspace_id) return { workspaceId: String(row.workspace_id), created: false };
    const workspaceId = randomUUID();
    await tx`select adeena.create_workspace(${workspaceId}::uuid, 'Personal workspace', 'personal', ${actor.userId}::uuid)`;
    return { workspaceId, created: true };
  });
}

export async function openCreatorWorkspace(sql: Sql, identity: VerifiedIdentity, workspaceId: string) {
  const actor = assertVerifiedIdentity(identity);
  if (workspaceId === SYNTHETIC_WORKSPACE_ID) throw new SourceError("unauthenticated");
  try {
    return await withWorkspace(sql, actor, workspaceId, async ({ tx }) => {
      const rows = await tx<{ id: string }[]>`select id from workspaces where id = ${workspaceId}::uuid`;
      if (!rows[0]) throw new SourceError("cross-workspace");
      return { workspaceId: String(rows[0].id) };
    });
  } catch (error) {
    if (error instanceof SourceError && error.code === "unauthenticated") throw new SourceError("cross-workspace");
    throw error;
  }
}

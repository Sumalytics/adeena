import type { VerifiedIdentity } from "@/db/identity";
import { ensureIndividualWorkspace } from "@/db/creator";
import { creatorDatabase } from "./database";

export async function openIndividualWorkspace(identity: VerifiedIdentity) {
  return ensureIndividualWorkspace(creatorDatabase(), identity);
}

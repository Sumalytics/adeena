import type { PrivateObjectStore } from "./object-store";

/** Removes private objects that no committed database locator references. */
export async function reconcileOrphans(store: PrivateObjectStore, workspaceId: string, referenced: readonly string[]) {
  const live = new Set(referenced);
  const retired: string[] = [];
  for (const locator of await store.listLocators(workspaceId)) {
    if (live.has(locator)) continue;
    await store.retire(locator);
    retired.push(locator);
  }
  return retired.sort();
}

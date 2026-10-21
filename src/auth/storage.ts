import path from "node:path";
import { createFilesystemObjectStore } from "@/storage/filesystem";

/** Private filesystem root. Objects are addressed by private:// locators, not public URLs. */
export function creatorObjectStore() {
  const configured = process.env.ADEENA_PRIVATE_STORAGE?.trim();
  const root = configured || path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "private-sources");
  return createFilesystemObjectStore(root);
}

export type StoredObject = {
  locator: string;
  created: boolean;
};

/**
 * Private object storage. A later Supabase Storage adapter can implement the same methods.
 * Locators are opaque private keys, not public URLs.
 */
export type PrivateObjectStore = {
  putOriginal(workspaceId: string, contentHash: string, bytes: Uint8Array): Promise<StoredObject>;
  readOriginal(workspaceId: string, contentHash: string): Promise<Uint8Array>;
  putCanonical(workspaceId: string, contentHash: string, text: string): Promise<StoredObject>;
  readCanonical(workspaceId: string, contentHash: string): Promise<string>;
  verifyOriginal(workspaceId: string, contentHash: string): Promise<boolean>;
  retire(locator: string): Promise<void>;
  listLocators(workspaceId: string): Promise<string[]>;
};

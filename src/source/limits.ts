/** Ceilings, not a promise that every file under the ceiling is cheap to process. */
export const DEFAULT_SOURCE_LIMITS = {
  maxBytes: 20 * 1024 * 1024,
  maxPdfPages: 400,
  maxZipEntries: 256,
  maxUncompressedBytes: 32 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxTextChars: 5_000_000,
  maxActiveJobs: 2,
} as const;

export type SourceLimits = {
  maxBytes: number;
  maxPdfPages: number;
  maxZipEntries: number;
  maxUncompressedBytes: number;
  maxCompressionRatio: number;
  maxTextChars: number;
  maxActiveJobs: number;
};

export function sourceLimits(overrides?: Partial<SourceLimits>): SourceLimits {
  return { ...DEFAULT_SOURCE_LIMITS, ...overrides };
}

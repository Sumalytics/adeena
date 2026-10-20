import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Serves the local Phaser build. It is not part of the homepage or Studio bundles. */
export async function GET() {
  const file = await readFile(join(process.cwd(), "node_modules/phaser/dist/phaser.min.js"));
  return new Response(file, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}

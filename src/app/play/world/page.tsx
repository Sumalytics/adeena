import type { Metadata } from "next";
import { WorldPlayer } from "./world-player";

export const metadata: Metadata = {
  title: "Resource room",
  description: "Synthetic development experience. Not for publication.",
  robots: { index: false, follow: false },
};

export default function WorldPlayPage() {
  return <WorldPlayer />;
}

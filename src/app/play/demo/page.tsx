import type { Metadata } from "next";
import { DemoPlayer } from "./demo-player";

export const metadata: Metadata = {
  title: "Play",
  description: "Synthetic development experience. Not for publication.",
  robots: { index: false, follow: false },
};

export default function DemoPlayPage() {
  return <DemoPlayer />;
}

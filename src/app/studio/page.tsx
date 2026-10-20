import type { Metadata } from "next";
import { StudioApp } from "./studio-app";

export const metadata: Metadata = {
  title: "Creator Studio",
};

export default function StudioPage() {
  return <StudioApp />;
}

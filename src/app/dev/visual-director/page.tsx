import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { VisualDirectorDemo } from "@/experience/visual-director/visual-director-demo";

export const metadata: Metadata = { title: "Visual Director development preview" };

export default function VisualDirectorPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <VisualDirectorDemo />;
}


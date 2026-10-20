import { Suspense } from "react";
import type { Metadata } from "next";
import page from "../page.module.css";
import { CreatorSession } from "./creator-session";

export const metadata: Metadata = { title: "Creator" };

export default function CreatorPage() {
  return (
    <main id="content" className={page.main}>
      <p className={page.brand}>adeena</p>
      <h1 className={page.title}>Creator</h1>
      <Suspense fallback={<p>Checking your session…</p>}>
        <CreatorSession />
      </Suspense>
    </main>
  );
}

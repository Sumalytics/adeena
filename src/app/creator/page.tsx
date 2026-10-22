import { Suspense } from "react";
import type { Metadata } from "next";
import styles from "./creator.module.css";
import { CreatorSession } from "./creator-session";

export const metadata: Metadata = { title: "Creator" };

export default function CreatorPage() {
  return (
    <main id="content" className={styles.page}>
      <p className={styles.brand}>adeena</p>
      <h1 className={styles.headline}>What do you want people to learn?</h1>
      <Suspense fallback={<p className={styles.promise}>Checking your session…</p>}>
        <CreatorSession />
      </Suspense>
    </main>
  );
}

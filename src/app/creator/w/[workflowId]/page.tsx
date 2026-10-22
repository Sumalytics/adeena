import { Suspense } from "react";
import type { Metadata } from "next";
import styles from "../../creator.module.css";
import { WorkflowSession } from "./workflow-session";

export const metadata: Metadata = { title: "Experience" };

export default function WorkflowPage({ params }: { params: Promise<{ workflowId: string }> }) {
  return (
    <main id="content" className={styles.page}>
      <p className={styles.brand}>adeena</p>
      <h1 className={styles.headline}>What do you want people to learn?</h1>
      <Suspense fallback={<p className={styles.promise}>Checking your session…</p>}>
        <WorkflowSession params={params} />
      </Suspense>
    </main>
  );
}

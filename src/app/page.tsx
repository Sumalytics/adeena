import { Suspense } from "react";
import { connection } from "next/server";
import { readVerifiedSession } from "@/auth/session";
import { HomeNavigation } from "./home-navigation";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main id="content" className={styles.main}>
      <p className={styles.brand}>adeena</p>
      <h1 className={styles.title}>Living Knowledge</h1>
      <p className={styles.lead}>
        Start with a source and an audience. Generate a preview, then share
        only after rights and approval are clear.
      </p>
      <Suspense fallback={<p>Checking your session…</p>}>
        <HomeSession />
      </Suspense>
    </main>
  );
}

async function HomeSession() {
  await connection();
  let signedIn = false;
  try {
    signedIn = (await readVerifiedSession()) !== null;
  } catch {
    signedIn = false;
  }
  return <HomeNavigation signedIn={signedIn} />;
}

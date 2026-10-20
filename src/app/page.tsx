import Link from "next/link";
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
      <Link className={styles.enter} href="/studio">
        Open Creator Studio
      </Link>
    </main>
  );
}

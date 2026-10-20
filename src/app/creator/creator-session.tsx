import { redirect } from "next/navigation";
import Link from "next/link";
import { openIndividualWorkspace } from "@/auth/home";
import { readVerifiedSession } from "@/auth/session";
import styles from "../auth.module.css";
import page from "../page.module.css";

export async function CreatorSession() {
  const session = await readVerifiedSession();
  if (!session) redirect("/login?next=/creator");
  try {
    await openIndividualWorkspace(session.identity);
  } catch {
    return (
      <p className={styles.alert} role="alert">
        Your workspace could not be opened.
      </p>
    );
  }
  return (
    <>
      <ol className={styles.steps}>
        <li>Choose / Upload</li>
        <li>Generate</li>
        <li>Preview</li>
        <li>Share</li>
      </ol>
      <p className={page.lead}>Your personal workspace is ready. The studio preview still uses the sample path.</p>
      <p className={styles.note}>Files stay on this device. Private upload is not available yet.</p>
      <p className={page.links}>
        <Link className={page.enter} href="/studio">
          Continue in Creator Studio
        </Link>
      </p>
      <form action="/auth/logout" method="post">
        <button className={styles.secondary} type="submit">
          Log out
        </button>
      </form>
    </>
  );
}

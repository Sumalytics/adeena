import Link from "next/link";
import styles from "./page.module.css";

const creatorEntry = "/login?next=/creator";

export function HomeNavigation({ signedIn }: { signedIn: boolean }) {
  if (!signedIn) {
    return (
      <div className={styles.links}>
        <Link className={styles.enter} href={creatorEntry}>
          Create experience
        </Link>
        <Link className={styles.signIn} href={creatorEntry}>
          Sign in
        </Link>
        <Link className={styles.signIn} href="/register">
          Create account
        </Link>
      </div>
    );
  }
  return (
    <div className={styles.links}>
      <Link className={styles.enter} href="/creator">
        Creator workspace
      </Link>
      <Link className={styles.signIn} href="/creator">
        Create experience
      </Link>
      <form action="/auth/logout" method="post">
        <button className={styles.signIn} type="submit">
          Log out
        </button>
      </form>
    </div>
  );
}

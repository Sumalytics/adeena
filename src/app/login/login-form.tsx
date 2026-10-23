import Link from "next/link";
import styles from "../auth.module.css";

export function LoginForm({ nextPath, message }: { nextPath: string; message: string | null }) {
  return (
    <form className={styles.form} method="post" action="/auth/login" noValidate>
      <input type="hidden" name="next" value={nextPath} />
      <label>
        Email
        <input name="email" type="email" autoComplete="username" required maxLength={254} />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="current-password" required minLength={8} maxLength={72} />
      </label>
      {message ? (
        <p className={styles.alert} role="alert">
          {message}
        </p>
      ) : null}
      <button type="submit">Sign in</button>
      <Link className={styles.textLink} href="/register">
        Create an account
      </Link>
    </form>
  );
}

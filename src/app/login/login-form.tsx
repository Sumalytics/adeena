"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createSupabaseBrowser } from "@/auth/browser";
import { validateCredentials } from "@/auth/credentials";
import styles from "../auth.module.css";

export function LoginForm({ nextPath, confirmError }: { nextPath: string; confirmError: boolean }) {
  const [error, setError] = useState<string | null>(
    confirmError ? "The confirmation link is invalid or expired." : null,
  );
  const [pending, setPending] = useState(false);
  const router = useRouter();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const invalid = validateCredentials(email, password);
    if (invalid) {
      setError(invalid);
      return;
    }
    setPending(true);
    setError(null);
    const result = await createSupabaseBrowser().auth.signInWithPassword({ email: email.trim(), password });
    if (result.error) {
      setPending(false);
      setError(signInMessage(result.error.code));
      return;
    }
    router.push(nextPath);
    router.refresh();
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate aria-busy={pending}>
      <label>
        Email
        <input name="email" type="email" autoComplete="username" required maxLength={254} />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="current-password" required minLength={8} maxLength={72} />
      </label>
      {error ? (
        <p className={styles.alert} role="alert">
          {error}
        </p>
      ) : null}
      {pending ? (
        <p className={styles.pending} role="status">
          Signing in…
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      <Link className={styles.textLink} href="/register">
        Create an account
      </Link>
    </form>
  );
}

function signInMessage(code: string | undefined) {
  if (code === "invalid_credentials") return "Email or password is incorrect.";
  if (code === "email_not_confirmed") return "Confirm your email before signing in.";
  return "Sign-in did not complete.";
}

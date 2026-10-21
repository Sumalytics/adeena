"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createSupabaseBrowser } from "@/auth/browser";
import { validateCredentials } from "@/auth/credentials";
import styles from "../auth.module.css";

export function RegisterForm() {
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
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
      setMessage(null);
      return;
    }
    setPending(true);
    setError(null);
    setMessage(null);
    const result = await createSupabaseBrowser().auth.signUp({
      email: email.trim(),
      password,
      options: { emailRedirectTo: `${window.location.origin}/auth/confirm` },
    });
    if (result.error) {
      setPending(false);
      setError(result.error.code === "user_already_exists" ? "An account with that email already exists." : "Registration did not complete.");
      return;
    }
    if (result.data.session) {
      router.push("/creator");
      router.refresh();
      return;
    }
    setPending(false);
    setMessage("Check your email to confirm your account.");
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <label>
        Email
        <input name="email" type="email" autoComplete="email" required maxLength={254} />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={72} />
      </label>
      {error ? (
        <p className={styles.alert} role="alert">
          {error}
        </p>
      ) : null}
      {message ? <p className={styles.note}>{message}</p> : null}
      <button type="submit" disabled={pending}>
        {pending ? "Creating account…" : "Create account"}
      </button>
      <Link className={styles.textLink} href="/login">
        Sign in
      </Link>
    </form>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./creator.module.css";

export function NewExperience() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function createExperience() {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/creator/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      });
      const body = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !body.id) {
        setError("A new experience could not be started.");
        return;
      }
      router.push(`/creator/w/${body.id}`);
    } catch {
      setError("A new experience could not be started.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.primary}>
      <button className={styles.button} type="button" disabled={pending} onClick={() => void createExperience()}>
        {pending ? "Starting your experience…" : "Create new experience"}
      </button>
      {error ? <p className={styles.alert} role="alert">{error}</p> : null}
    </div>
  );
}

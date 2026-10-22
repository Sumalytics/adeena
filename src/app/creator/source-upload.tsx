"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { CreatorUploadView, ExtractedSourceSummary } from "@/topic/public";
import styles from "./creator.module.css";

function messageFor(code: string) {
  if (code === "oversized") return "The file is larger than the upload limit.";
  if (code === "unsupported-type") return "Use a text, Markdown, DOCX, or text-layer PDF file.";
  if (code === "invalid-structure") return "The file contents do not match its type.";
  if (code === "empty-file") return "The file is empty.";
  if (code === "unauthenticated") return "Sign in again before uploading.";
  if (code === "job-limit") return "This workspace already has extraction work in progress.";
  if (code === "rights-blocked") return "Source rights are blocked, so extraction was not queued.";
  if (code === "cross-workspace") return "That source belongs to another workspace.";
  return "That upload could not be accepted.";
}

function statusLabel(source: ExtractedSourceSummary) {
  if (source.rightsStatus === "blocked" && source.extractionStatus === "pending") return "Stored. Extraction was not queued.";
  if (source.extractionStatus === "complete" || source.extractionStatus === "partial") return "Extracted";
  if (source.extractionStatus === "failed") return "Processing failed";
  return "Processing";
}

function rightsLabel(status: ExtractedSourceSummary["rightsStatus"]) {
  if (status === "blocked") return "Rights are blocked";
  if (status === "cleared") return "Rights cleared";
  return "Rights not verified";
}

export function SourceUpload({ sources }: { sources: ExtractedSourceSummary[] }) {
  const router = useRouter();
  const key = useRef(crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CreatorUploadView | null>(null);
  const waiting = sources.some((source) => source.extractionStatus === "pending" && source.rightsStatus !== "blocked");
  const extracted = sources.some((source) => source.extractionStatus === "complete" || source.extractionStatus === "partial");
  const formOpen = sources.length === 0 || (!waiting && !extracted);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    data.set("idempotencyKey", key.current);
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/creator/sources", { method: "POST", body: data });
      const body = (await response.json()) as CreatorUploadView & { error?: string };
      if (!response.ok || body.aiGenerationAuthorized !== false || body.generatesExperience !== false) {
        setError(messageFor(body.error ?? "invalid-source"));
        return;
      }
      setResult(body);
      key.current = crypto.randomUUID();
      router.refresh();
    } catch {
      setError("The upload did not reach the workspace.");
    } finally {
      setPending(false);
    }
  }

  async function continueProcessing(documentVersionId: string) {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/creator/sources/continue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentVersionId }),
      });
      const body = (await response.json()) as CreatorUploadView & { error?: string };
      if (!response.ok || body.aiGenerationAuthorized !== false) {
        setError(messageFor(body.error ?? "invalid-source"));
        return;
      }
      setResult(body);
      router.refresh();
    } catch {
      setError("Processing did not continue.");
    } finally {
      setPending(false);
    }
  }

  const fields = (
    <>
      <label className={styles.field} htmlFor="source-file">
        Source file
        <input id="source-file" name="source" type="file" accept=".txt,.md,.docx,.pdf,text/plain,text/markdown,application/pdf" aria-describedby="upload-limits" required />
      </label>
      <label className={styles.field} htmlFor="source-rights">
        Source rights
        <select id="source-rights" name="rightsDeclaration" defaultValue="" required>
          <option value="" disabled>Choose a rights declaration</option>
          <option value="permission-asserted">I have permission to use this source</option>
          <option value="blocked">Rights are blocked</option>
        </select>
      </label>
      <button className={styles.button} type="submit" disabled={pending}>{pending ? "Working on your source…" : "Upload source"}</button>
      <p className={styles.help} id="upload-limits">
        Use a text, Markdown, DOCX, or text-layer PDF. The file is stored privately.
        Extraction does not clear source rights, and it does not generate a game.
      </p>
    </>
  );

  let form: ReactNode;
  if (formOpen) {
    form = <form className={`${styles.form} ${styles.primary}`} onSubmit={(event) => void upload(event)}>{fields}</form>;
  } else {
    form = (
      <details className={styles.disclosure}>
        <summary>Add another source</summary>
        <form className={styles.form} onSubmit={(event) => void upload(event)}>{fields}</form>
      </details>
    );
  }

  return (
    <section className={styles.stage} aria-labelledby="upload-heading">
      <div className={styles.stageHeader}>
        <h2 id="upload-heading">{sources.length === 0 ? "Upload a source" : "Your sources"}</h2>
        {sources.length === 0 ? <p className={styles.quiet}>This is the first step. Add a file you have permission to use.</p> : null}
        {waiting ? <p className={styles.quiet}>Next: finish processing a source.</p> : null}
        {sources.length > 0 && formOpen ? <p className={styles.quiet}>Next: add a source you can use.</p> : null}
      </div>
      {sources.length === 0 ? <p className={styles.empty}>No source yet.</p> : (
        <ul className={styles.cards}>
          {sources.map((source) => (
            <li className={styles.card} key={source.documentVersionId}>
              <p className={styles.status}>{statusLabel(source)}</p>
              <h3>{source.filename}</h3>
              <p className={styles.meta}>{rightsLabel(source.rightsStatus)} · {source.byteCount} bytes</p>
              {source.extractionStatus === "pending" && source.rightsStatus !== "blocked" ? (
                <div className={styles.actions}>
                  <button className={styles.secondary} type="button" disabled={pending} onClick={() => void continueProcessing(source.documentVersionId)}>
                    Continue processing
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {error ? <p className={styles.alert} role="alert">{error}</p> : null}
      {pending ? <p className={styles.note} role="status">Working on your source.</p> : null}
      {result ? (
        <p className={styles.note} role="status">
          {result.filename} is {result.extractionStatus}. Rights remain {result.rightsStatus}. No experience was generated.
          {result.cost ? ` Processing took ${result.cost.durationMs} ms and stored ${result.cost.storedBytes} bytes.` : ""}
        </p>
      ) : null}
      {form}
    </section>
  );
}

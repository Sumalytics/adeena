"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { CreatorUploadView, ExtractedSourceSummary } from "@/topic/public";
import styles from "../auth.module.css";

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

export function SourceUpload({ sources }: { sources: ExtractedSourceSummary[] }) {
  const router = useRouter();
  const key = useRef(crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CreatorUploadView | null>(null);

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

  return (
    <section aria-labelledby="upload-heading">
      <h2 id="upload-heading" className={styles.subhead}>Upload a source</h2>
      <p className={styles.note}>
        Upload a text, Markdown, DOCX, or text-layer PDF into this workspace. The file is stored privately.
        Extraction does not clear source rights, and it does not generate a game.
      </p>
      <form className={styles.form} onSubmit={(event) => void upload(event)}>
        <label htmlFor="source-file">
          Source file
          <input id="source-file" name="source" type="file" accept=".txt,.md,.docx,.pdf,text/plain,text/markdown,application/pdf" required />
        </label>
        <label htmlFor="source-rights">
          Source rights
          <select id="source-rights" name="rightsDeclaration" defaultValue="" required>
            <option value="" disabled>Choose a rights declaration</option>
            <option value="permission-asserted">I have permission to use this source</option>
            <option value="blocked">Rights are blocked</option>
          </select>
        </label>
        <button type="submit" disabled={pending}>Upload source</button>
      </form>
      {error ? <p className={styles.alert} role="alert">{error}</p> : null}
      {result ? (
        <p className={styles.note} role="status">
          {result.filename} is {result.extractionStatus}. Rights remain {result.rightsStatus}. No experience was generated.
          {result.cost ? ` Processing took ${result.cost.durationMs} ms and stored ${result.cost.storedBytes} bytes.` : ""}
        </p>
      ) : null}
      {sources.length > 0 ? (
        <ul className={styles.topicList}>
          {sources.map((source) => (
            <li key={source.documentVersionId}>
              <p className={styles.topicTitle}>{source.filename}</p>
              <p>{statusLabel(source)} {source.byteCount} bytes. Rights: {source.rightsStatus}.</p>
              {source.extractionStatus === "pending" && source.rightsStatus !== "blocked" ? (
                <button className={styles.quiet} type="button" disabled={pending} onClick={() => void continueProcessing(source.documentVersionId)}>
                  Continue processing
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

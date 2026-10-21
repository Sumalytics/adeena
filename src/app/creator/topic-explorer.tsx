"use client";

import { useState } from "react";
import { AUDIENCE_OPTIONS } from "@/app/studio/studio-form";
import type { ExtractedSourceSummary, TopicRecommendationView } from "@/topic/public";
import styles from "../auth.module.css";

const AGE_BANDS = [
  ["5-7", "Ages 5–7"],
  ["8-10", "Ages 8–10"],
  ["11-13", "Ages 11–13"],
  ["14-18", "Ages 14–18"],
  ["adult", "Adult"],
  ["unspecified", "Unspecified"],
] as const;

export function TopicExplorer({ sources }: { sources: ExtractedSourceSummary[] }) {
  const [documentVersionId, setDocumentVersionId] = useState(sources[0]?.documentVersionId ?? "");
  const [audienceLabel, setAudienceLabel] = useState("");
  const [ageBand, setAgeBand] = useState("");
  const [view, setView] = useState<TopicRecommendationView | null>(null);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  async function recommend() {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/creator/topics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          documentVersionId,
          audienceLabel,
          ageBand,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const body = (await response.json()) as TopicRecommendationView & { error?: string };
      if (!response.ok) {
        setView(null);
        setError("The topic recommendation could not be prepared.");
        return;
      }
      setView(body);
      setMessage(body.recommendation?.reason ?? "");
      setOpen(body.recommendation?.status !== "recommended");
    } catch {
      setError("The topic recommendation did not reach the workspace.");
    } finally {
      setPending(false);
    }
  }

  async function showMore() {
    if (!view) return;
    const offset = view.page.offset + view.page.limit;
    const params = new URLSearchParams({
      documentVersionId,
      audienceLabel,
      ageBand,
      offset: String(offset),
    });
    const response = await fetch(`/api/creator/topics?${params.toString()}`);
    if (!response.ok) {
      setError("More topics could not be loaded.");
      return;
    }
    const body = (await response.json()) as TopicRecommendationView;
    setView({
      ...body,
      candidates: [...view.candidates, ...body.candidates],
      page: body.page,
    });
  }

  async function correct(nodeId: string, form: FormData) {
    const correctedTitle = String(form.get("title") ?? "");
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/creator/topics/correct", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentVersionId, nodeId, correctedTitle }),
      });
      const body = (await response.json()) as { invalidated?: number; generatesExperience?: boolean };
      if (!response.ok || body.generatesExperience !== false) {
        setError("The heading correction could not be saved.");
        return;
      }
      setView(null);
      setOpen(false);
      setEditing(null);
      setMessage("The heading was saved. The previous recommendation was set aside. No experience was generated.");
    } catch {
      setError("The heading correction did not reach the workspace.");
    } finally {
      setPending(false);
    }
  }

  const ready = documentVersionId !== "" && audienceLabel !== "" && ageBand !== "";
  const recommendation = view?.recommendation;

  return (
    <section aria-labelledby="topic-heading">
      <h2 id="topic-heading" className={styles.subhead}>Starting topic</h2>
      <p className={styles.note}>
        A recommendation names one source topic. It does not generate a game, and it is not an educational approval.
      </p>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void recommend();
        }}
      >
        <label htmlFor="topic-source">
          Extracted source
          <select
            id="topic-source"
            value={documentVersionId}
            onChange={(event) => {
              setDocumentVersionId(event.target.value);
              setView(null);
            }}
          >
            {sources.map((source) => (
              <option key={source.documentVersionId} value={source.documentVersionId}>
                {source.filename}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="topic-audience">
          Audience
          <select id="topic-audience" value={audienceLabel} onChange={(event) => setAudienceLabel(event.target.value)}>
            <option value="">Select an audience</option>
            {AUDIENCE_OPTIONS.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        <label htmlFor="topic-age">
          Age band
          <select id="topic-age" value={ageBand} onChange={(event) => setAgeBand(event.target.value)}>
            <option value="">Select an age band</option>
            {AGE_BANDS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={!ready || pending}>Recommend a starting topic</button>
      </form>
      {error ? <p className={styles.alert} role="alert">{error}</p> : null}
      <p className={styles.pending} role="status" aria-live="polite">{message}</p>
      {recommendation ? (
        <p className={styles.note}>
          {recommendation.understood === "full" ? "The source text was read." : "The source was only partly understood."}
          {" "}
          {recommendation.candidateCount} topic{recommendation.candidateCount === 1 ? "" : "s"} detected.
          {" "}
          No experience version was created.
        </p>
      ) : null}
      {view && view.page.total > 0 ? (
        <div className={styles.topicActions}>
          <button className={styles.quiet} type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            Explore other topics
          </button>
        </div>
      ) : null}
      {open && view ? (
        <>
          <ul className={styles.topicList}>
            {view.candidates.map((candidate) => (
              <li key={candidate.id}>
                <h3 className={styles.topicTitle}>{candidate.title}</h3>
                <p>{candidate.eligibility === "eligible" ? "Usable as a starting topic." : "Needs a person to decide."}</p>
                {candidate.detectionMethod !== "bounded-text" ? (
                  editing === candidate.id ? (
                    <form
                      className={styles.form}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void correct(candidate.primaryNodeId, new FormData(event.currentTarget));
                      }}
                    >
                      <label htmlFor={`correct-${candidate.id}`}>
                        Corrected heading
                        <input id={`correct-${candidate.id}`} name="title" defaultValue={candidate.title} maxLength={200} required />
                      </label>
                      <button type="submit" disabled={pending}>Save heading</button>
                    </form>
                  ) : (
                    <button className={styles.quiet} type="button" onClick={() => setEditing(candidate.id)}>
                      Correct heading
                    </button>
                  )
                ) : null}
              </li>
            ))}
          </ul>
          {view.candidates.length < view.page.total ? (
            <button className={styles.quiet} type="button" onClick={() => void showMore()}>Show more topics</button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

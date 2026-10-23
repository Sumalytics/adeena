"use client";

import { useRef, useState } from "react";
import { AUDIENCE_OPTIONS } from "@/app/studio/studio-form";
import type { ExtractedSourceSummary, TopicRecommendationView } from "@/topic/public";
import styles from "./creator.module.css";

const AGE_BANDS = [
  ["5-7", "Ages 5–7"],
  ["8-10", "Ages 8–10"],
  ["11-13", "Ages 11–13"],
  ["14-18", "Ages 14–18"],
  ["adult", "Adult"],
  ["unspecified", "Unspecified"],
] as const;

const GENERATION_COPY: Record<string, string> = {
  "generation-unavailable": "AI generation is not configured. No experience was created.",
  "budget-unavailable": "Generation spending is not authorized. No experience was created.",
  "review-required": "This source needs review before an experience can be created.",
  "rights-blocked": "Source rights are blocked, so no experience was created.",
  "insufficient-source": "This topic does not have enough source support for a playable experience.",
  "invalid-experience": "The generated experience did not pass validation.",
  "invalid-generation": "That generation request could not be accepted.",
  "stale-extraction": "The source extraction changed. Recommend the topic again before creating an experience.",
  "cross-workspace": "That source belongs to another workspace.",
  "generation-denied": "This source cannot be used to generate an experience.",
};

function eligibilityCopy(eligibility: "eligible" | "needs-review" | "insufficient-support") {
  if (eligibility === "eligible") return "Usable as a starting topic.";
  if (eligibility === "insufficient-support") return "Not enough source support.";
  return "Needs a person to decide.";
}

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
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState("");
  const keys = useRef(new Map<string, string>());

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

  async function generate(topicCandidateId: string) {
    const stamp = `${topicCandidateId}:${audienceLabel}:${ageBand}`;
    const existing = keys.current.get(stamp);
    const idempotencyKey = existing ?? crypto.randomUUID();
    if (!existing) keys.current.set(stamp, idempotencyKey);
    setPending(true);
    setError("");
    setDraftPath(null);
    try {
      const response = await fetch("/api/creator/experiences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          documentVersionId,
          topicCandidateId,
          audienceLabel,
          ageBand,
          idempotencyKey,
          authorizeGeneration: true,
          compilerVersion: "1",
        }),
      });
      const body = (await response.json()) as {
        error?: string;
        previewPath?: string | null;
        publicationStatus?: string;
        liveModel?: boolean;
        aiGenerationAuthorized?: boolean;
      };
      const preview = body.previewPath ?? "";
      if (response.status === 202) {
        setMessage("Generation is still in progress.");
        return;
      }
      if (!response.ok || body.publicationStatus !== "unpublished" || !preview.startsWith("/creator/preview/")) {
        setError(GENERATION_COPY[body.error ?? ""] ?? "The experience could not be created.");
        return;
      }
      setDraftPath(preview);
      setDraftNote(body.liveModel ? "A configured model planned this private game from your source. Review every path before sharing." : "This private draft was compiled by the local fixture from your source. It is not a live model result.");
      setMessage("The private draft is ready.");
    } catch {
      setError("The experience did not reach the workspace.");
    } finally {
      setPending(false);
    }
  }

  const ready = documentVersionId !== "" && audienceLabel !== "" && ageBand !== "";
  const recommendation = view?.recommendation;
  const selected = view?.candidates.find((candidate) => candidate.id === pickedId)
    ?? view?.candidates.find((candidate) => candidate.id === recommendation?.topicCandidateId)
    ?? null;
  const selectedId = selected?.id ?? (recommendation?.status === "recommended" ? recommendation.topicCandidateId : null);
  const sourceRights = sources.find((source) => source.documentVersionId === documentVersionId)?.rightsStatus;
  const needsReview = selected?.eligibility === "needs-review"
    || selected?.reasons.includes("review-required")
    || selected?.reasons.includes("sensitive-domain")
    || false;
  const canGenerate = Boolean(selectedId) && sourceRights !== "blocked" && !needsReview && (selected ? selected.eligibility === "eligible" : recommendation?.status === "recommended");
  const statusText = message || (pending ? "Working…" : "");

  return (
    <section className={styles.stage} aria-labelledby="topic-heading">
      <div className={styles.stageHeader}>
        <h2 id="topic-heading">Choose a topic</h2>
        <p className={styles.quiet}>
          Next, name who this is for. A recommendation uses headings and short excerpts. That is not a safety review or an educational approval, and it does not generate a game.
        </p>
      </div>
      <form
        className={`${styles.form} ${styles.primary}`}
        onSubmit={(event) => {
          event.preventDefault();
          void recommend();
        }}
      >
        <label className={styles.field} htmlFor="topic-source">
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
        <label className={styles.field} htmlFor="topic-audience">
          Audience
          <select id="topic-audience" value={audienceLabel} onChange={(event) => setAudienceLabel(event.target.value)}>
            <option value="">Select an audience</option>
            {AUDIENCE_OPTIONS.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        <label className={styles.field} htmlFor="topic-age">
          Age band
          <select id="topic-age" value={ageBand} onChange={(event) => setAgeBand(event.target.value)}>
            <option value="">Select an age band</option>
            {AGE_BANDS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <button className={styles.button} type="submit" disabled={!ready || pending}>Recommend a starting topic</button>
      </form>
      {error ? <p className={styles.alert} role="alert">{error}</p> : null}
      {statusText ? <p className={styles.note} role="status" aria-live="polite">{statusText}</p> : null}
      {recommendation ? (
        <p className={styles.note}>
          {recommendation.understood === "full" ? "The source text was read." : "The source was only partly understood."}
          {" "}
          {recommendation.candidateCount} topic{recommendation.candidateCount === 1 ? "" : "s"} detected.
          {" "}
          Recommending a topic does not create an experience.
        </p>
      ) : null}
      {view && view.page.total > 0 ? (
        <div className={styles.actions}>
          <button className={styles.secondary} type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            Explore other topics
          </button>
        </div>
      ) : null}
      {open && view ? (
        <>
          <ul className={styles.cards}>
            {view.candidates.map((candidate) => (
              <li className={styles.card} key={candidate.id}>
                <h3>{candidate.title}</h3>
                <p className={styles.meta}>{eligibilityCopy(candidate.eligibility)}</p>
                {candidate.eligibility === "eligible" ? (
                  <div className={styles.actions}>
                    <button className={styles.secondary} type="button" onClick={() => setPickedId(candidate.id)}>Use this topic</button>
                  </div>
                ) : null}
                {pickedId === candidate.id ? <p className={styles.status}>Selected</p> : null}
                {candidate.detectionMethod !== "bounded-text" ? (
                  editing === candidate.id ? (
                    <form
                      className={styles.form}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void correct(candidate.primaryNodeId, new FormData(event.currentTarget));
                      }}
                    >
                      <label className={styles.field} htmlFor={`correct-${candidate.id}`}>
                        Corrected heading
                        <input id={`correct-${candidate.id}`} name="title" defaultValue={candidate.title} maxLength={200} required />
                      </label>
                      <button className={styles.button} type="submit" disabled={pending}>Save heading</button>
                    </form>
                  ) : (
                    <div className={styles.actions}>
                      <button className={styles.secondary} type="button" onClick={() => setEditing(candidate.id)}>
                        Correct heading
                      </button>
                    </div>
                  )
                ) : null}
              </li>
            ))}
          </ul>
          {view.candidates.length < view.page.total ? (
            <div className={styles.actions}>
              <button className={styles.secondary} type="button" onClick={() => void showMore()}>Show more topics</button>
            </div>
          ) : null}
        </>
      ) : null}
      <section className={styles.panel} aria-labelledby="experience-heading">
        <h3 id="experience-heading">Private draft</h3>
        <p className={styles.help}>
          A draft stays private and unpublished. AI generation is not part of topic recommendation, and public sharing is not available.
        </p>
        {!view ? <p className={styles.help}>Recommend a topic before creating an experience.</p> : null}
        {sourceRights === "blocked" ? <p className={styles.help}>Source rights are blocked, so no experience can be created.</p> : null}
        {needsReview ? <p className={styles.help}>This source needs review before an experience can be created.</p> : null}
        {view && !canGenerate && sourceRights !== "blocked" && !needsReview ? <p className={styles.help}>Choose an eligible topic before creating an experience.</p> : null}
        {canGenerate && selectedId ? (
          <div className={styles.actions}>
            <button className={styles.button} type="button" disabled={pending} onClick={() => void generate(selectedId)}>
              {pending ? "Creating the private draft…" : "Create playable experience"}
            </button>
          </div>
        ) : null}
        {draftPath ? (
          <div className={styles.actions}>
            <a className={styles.draftLink} href={draftPath}>Open private preview</a>
          </div>
        ) : null}
        {draftNote ? <p className={styles.help}>{draftNote}</p> : null}
      </section>
    </section>
  );
}

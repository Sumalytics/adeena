"use client";

import Link from "next/link";
import { useReducer, useRef, useState } from "react";
import {
  AUDIENCE_OPTIONS,
  canGeneratePreview,
  initialStudioDraft,
  previewPayload,
  studioReducer,
} from "./studio-form";
import styles from "./studio.module.css";

const STEPS = ["Choose / Upload", "Generate", "Preview", "Share"] as const;

const AGE_BANDS = [
  ["5-7", "Ages 5–7"],
  ["8-10", "Ages 8–10"],
  ["11-13", "Ages 11–13"],
  ["14-18", "Ages 14–18"],
  ["adult", "Adult"],
  ["unspecified", "Unspecified"],
] as const;

type Preview = {
  jobId: string;
  version: number;
  scene: {
    id: string;
    title: string;
    narration: string;
    options: { id: string; label: string }[];
  };
  publication: { reasons: string[] };
  cost: { minor: number; currency: string; status: string };
};

export function StudioApp() {
  const idempotencyKey = useRef<string | null>(null);
  const [draft, dispatch] = useReducer(studioReducer<Preview>, undefined, initialStudioDraft);
  const [pending, setPending] = useState<"preview" | "score" | "share" | null>(null);
  const { sourceLabel, audienceLabel, ageBand, fileName, error, preview, optionId, scoreText, shareReasons } = draft;

  const ready = canGeneratePreview(draft);
  const currentStep = shareReasons ? 3 : preview ? 2 : pending === "preview" ? 1 : 0;

  function rememberEdit() {
    if (preview) idempotencyKey.current = null;
  }

  async function generate() {
    if (!ready) return;
    const key = idempotencyKey.current ?? crypto.randomUUID();
    idempotencyKey.current = key;
    setPending("preview");
    dispatch({ type: "reset-feedback" });
    try {
      const response = await fetch("/api/studio/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          previewPayload({
            idempotencyKey: key,
            sourceLabel,
            audienceLabel,
            ageBand,
          }),
        ),
      });
      const body = (await response.json()) as Preview & { error?: string; issues?: string[] };
      if (!response.ok) {
        dispatch({
          type: "preview-error",
          message: body.issues?.join(" ") || "The preview could not be created.",
        });
        return;
      }
      dispatch({ type: "preview", preview: body });
    } catch {
      dispatch({ type: "preview-error", message: "The preview request did not reach the studio." });
    } finally {
      setPending(null);
    }
  }

  async function score() {
    if (!preview || !optionId) return;
    setPending("score");
    dispatch({ type: "reset-feedback" });
    try {
      const response = await fetch("/api/studio/score", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobId: preview.jobId,
          sceneId: preview.scene.id,
          optionId,
        }),
      });
      const body = (await response.json()) as { correct?: boolean; points?: number };
      if (!response.ok) {
        dispatch({ type: "score", text: "That choice could not be scored." });
        return;
      }
      dispatch({
        type: "score",
        text: body.correct
          ? `That stays inside the source. ${body.points} point.`
          : "That adds something the source does not say. 0 points.",
      });
    } catch {
      dispatch({ type: "score", text: "Scoring did not reach the studio." });
    } finally {
      setPending(null);
    }
  }

  async function share() {
    if (!preview) return;
    setPending("share");
    dispatch({ type: "reset-feedback" });
    try {
      const response = await fetch("/api/studio/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: preview.jobId }),
      });
      const body = (await response.json()) as { issues?: string[] };
      dispatch({
        type: "share",
        reasons: body.issues?.length ? body.issues : ["Sharing is blocked."],
      });
    } catch {
      dispatch({ type: "share", reasons: ["The share request did not reach the studio."] });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/">
          adeena
        </Link>
        <p className={styles.kicker}>
          <span className={styles.mark} aria-hidden="true" />
          Creator Studio
        </p>
      </header>
      <main id="content">
        <h1 className={styles.title}>Make a preview</h1>
        <p className={styles.lead}>
          Choose a source, an audience, and an age band. Generate a preview before you share.
        </p>
        <ol className={styles.steps} aria-label="Creator workflow">
          {STEPS.map((step, index) => (
            <li
              key={step}
              aria-current={index === currentStep ? "step" : undefined}
              data-complete={index < currentStep ? "true" : undefined}
            >
              {step}
            </li>
          ))}
        </ol>

        <form
          className={styles.panel}
          onSubmit={(event) => {
            event.preventDefault();
            void generate();
          }}
        >
          <div className={styles.field}>
            <label htmlFor="source">Source</label>
            <textarea
              id="source"
              name="source"
              value={sourceLabel}
              maxLength={500}
              required
              onChange={(event) => {
                rememberEdit();
                dispatch({ type: "source", value: event.target.value });
              }}
            />
            <p className={styles.hint}>
              Paste a short source note. Do not include a child&apos;s name or contact details.
            </p>
          </div>
          <div className={styles.field}>
            <label htmlFor="upload">Upload</label>
            <input
              id="upload"
              name="upload"
              type="file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                rememberEdit();
                dispatch({
                  type: "file",
                  name: file.name,
                  sourceLabel: sourceLabel.trim() ? undefined : file.name,
                });
              }}
            />
            <p className={styles.hint}>The file stays on this device. Nothing is uploaded.</p>
            {fileName ? <p className={styles.fileState}>{fileName} · Not uploaded</p> : null}
          </div>
          <div className={styles.pair}>
            <div className={styles.field}>
              <label htmlFor="audience">Audience</label>
              <select
                id="audience"
                name="audience"
                value={audienceLabel}
                required
                onChange={(event) => {
                  rememberEdit();
                  dispatch({ type: "audience", value: event.target.value });
                }}
              >
                <option value="">Select an audience</option>
                {AUDIENCE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="age-band">Age band</label>
              <select
                id="age-band"
                name="age-band"
                value={ageBand}
                required
                onChange={(event) => {
                  rememberEdit();
                  dispatch({ type: "age", value: event.target.value });
                }}
              >
                <option value="">Select an age band</option>
                {AGE_BANDS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {pending === "preview" ? (
            <p className={styles.notice} role="status">
              Preparing a synthetic preview from the source note. No model is being called.
            </p>
          ) : null}
          <div className={styles.actions}>
            <button type="submit" disabled={!ready || pending !== null}>
              {pending === "preview" ? "Generating…" : error ? "Try again" : "Generate preview"}
            </button>
          </div>
          {error ? (
            <p className={styles.block} role="alert">
              {error}
            </p>
          ) : null}
        </form>

        {preview ? (
          <section className={styles.panel} aria-label="Preview">
            <h2>{preview.scene.title}</h2>
            <p>{preview.scene.narration}</p>
            <fieldset>
              <legend>Choose one</legend>
              {preview.scene.options.map((option) => (
                <label key={option.id} className={styles.choice}>
                  <input
                    type="radio"
                    name="choice"
                    value={option.id}
                    checked={optionId === option.id}
                    onChange={() => dispatch({ type: "option", id: option.id })}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </fieldset>
            <div className={styles.actions}>
              <button type="button" onClick={() => void score()} disabled={!optionId || pending !== null}>
                Check answer
              </button>
              <button type="button" onClick={() => void share()} disabled={pending !== null}>
                Share
              </button>
            </div>
            {scoreText ? (
              <p className={styles.notice} role="status">
                {scoreText}
              </p>
            ) : null}
            <p className={styles.hint}>
              Version {preview.version}. Recorded cost {preview.cost.currency}{" "}
              {(preview.cost.minor / 100).toFixed(2)} ({preview.cost.status}). No model was called.
            </p>
            {shareReasons ? (
              <div className={styles.block} role="status">
                <strong>Sharing is blocked</strong>
                <ul>
                  {shareReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
                <p>The preview stays on this page. Share does not open another route.</p>
              </div>
            ) : null}
            <fieldset disabled>
              <legend>Later creative controls</legend>
              <div className={styles.field}>
                <label htmlFor="tone">Tone</label>
                <input id="tone" value="Plain" readOnly />
              </div>
              <div className={styles.field}>
                <label htmlFor="length">Length</label>
                <input id="length" value="One scene" readOnly />
              </div>
              <p className={styles.hint}>
                These appear after the first preview. They do not change this version.
              </p>
            </fieldset>
          </section>
        ) : null}
      </main>
    </div>
  );
}

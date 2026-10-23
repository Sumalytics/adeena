"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import styles from "../../auth.module.css";
import layout from "./experience-editor.module.css";
import share from "./experience-share.module.css";

export type PublicationStatus = {
  eligible: boolean; blocks: string[]; sourceName: string;
  permissionBasis: "verified" | "legacy-clearance" | "upload-declaration" | null;
  permissionRecordedAt: string | null;
  rightsBasis: string | null; rightsRecordedAt: string | null;
  release: { releaseId: string; playPath: string; revoked: boolean } | null;
};

const reasons: Record<string, string> = {
  "owner-required": "Only the workspace owner can share this version.",
  "rights-blocked": "This source is blocked. Use content you have permission to use.",
  "rights-clearance-required": "This legacy source has no reusable permission record. Return to creation, re-select it and confirm that you may use it.",
  "permission-declaration-required": "Permission for this source has not been declared. Return to creation, re-select it and confirm that you may use it.",
  "independent-review-required": "This selected topic is sensitive or high risk and requires independent review. Sharing is unavailable in the current workflow.",
  "version-review-required": "This version is not ready. Finish generating or accept the proposed improvement first.",
  "validation-required": "The playable version has not passed validation. Return to the experience and prepare a valid draft.",
  "public-content-review-required": "Learner-facing content contains unsupported assets, links or sensitive content. Revise it before sharing.",
  "release-revoked": "This version’s link was revoked permanently. Prepare a new version to share again.",
  "version-unavailable": "This version is unavailable. Return to your experience.",
};

export function ExperienceShare({ versionId }: { versionId: string }) {
  const [status, setStatus] = useState<PublicationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [url, setUrl] = useState("");
  const [qr, setQr] = useState("");

  async function refresh() {
    const response = await fetch(`/api/creator/releases?versionId=${versionId}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not check sharing eligibility. Sign in and try again.");
    setStatus(await response.json());
  }
  useEffect(() => {
    let active = true;
    fetch(`/api/creator/releases?versionId=${versionId}`, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("Could not check sharing eligibility. Sign in and try again.");
      const payload: PublicationStatus = await response.json();
      if (active) setStatus(payload);
    }).catch((error: Error) => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, [versionId]);
  const playPath = status?.release && !status.release.revoked ? status.release.playPath : null;
  useEffect(() => {
    if (!playPath) return;
    let active = true;
    const canonical = new URL(playPath, window.location.origin).href;
    QRCode.toDataURL(canonical, { width: 224, margin: 4, errorCorrectionLevel: "M" }).then((data) => {
      if (active) { setUrl(canonical); setQr(data); }
    }).catch(() => { if (active) { setUrl(canonical); setMessage("QR code unavailable. You can still copy the link."); } });
    return () => { active = false; };
  }, [playPath]);

  async function act(kind: "publish" | "revoke") {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(kind === "publish" ? "/api/creator/releases" : `/api/creator/releases/${status?.release?.releaseId}`, {
        method: kind === "revoke" ? "DELETE" : "POST",
        headers: { "content-type": "application/json" },
        ...(kind === "revoke" ? {} : { body: JSON.stringify({ experienceVersionId: versionId }) }),
      });
      if (!response.ok) throw new Error("This action could not be completed. Check eligibility and your session, then try again.");
      await refresh();
      setMessage(kind === "publish" ? "Share link created. It always plays this fixed version." : "Revoked. New learner requests can no longer open this release.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Please try again.");
      await refresh().catch(() => setStatus(null));
    } finally { setBusy(false); }
  }

  return <section className={`${layout.editor} ${share.section}`} aria-labelledby="share-heading" aria-busy={busy}>
    <h2 id="share-heading" className={styles.subhead}>Share</h2>
    <p>Create a learner link for this version. Later draft edits stay private.</p>
    <p className={share.version}>Version: {versionId}</p>
    {!status ? <><p>Sharing eligibility is not available yet.</p><button className={styles.quiet} onClick={() => refresh().catch((error: Error) => setMessage(error.message))}>Retry eligibility check</button></> : <>
      {status.blocks.length > 0 ? <div className={styles.note}><strong>Sharing unavailable</strong><ul>{status.blocks.map((reason) => <li key={reason}>{reasons[reason] ?? "Sharing requires another step."}</li>)}</ul></div> : <p className={styles.note}>{status.release ? "This version has a learner link." : "Ready to share."}</p>}
      <p>Source: {status.sourceName}</p>
      {status.permissionBasis ? <p>Source permission: {status.permissionBasis === "verified" ? "verified rights status" : status.permissionBasis === "legacy-clearance" ? "previous creator clearance" : "creator declaration recorded when this source was added"}. The declaration is auditable and is not independent rights verification.</p> : null}
      {status.eligible && !status.release ? <div className={styles.form}>
        <h3>Share this version</h3>
        <p>This creates a public learner link from the version shown above. Sensitive or high-risk topics still require independent review.</p>
        <button disabled={busy} onClick={() => void act("publish")}>{busy ? "Creating link…" : "Create share link"}</button>
      </div> : null}
      {playPath ? <div className={styles.form}>
        <h3>Share with a learner</h3>
        <label>Canonical URL<input readOnly value={url} onFocus={(event) => event.target.select()} /></label>
        <button disabled={!url || busy} onClick={async () => { try { await navigator.clipboard.writeText(url); setMessage("Link copied."); } catch { setMessage("Copy unavailable. Select and copy the URL above."); } }}>Copy link</button>
        {qr ? <div className={share.qr}>
          {/* Generated locally as a data URL; no remote image request. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr} width={224} height={224} alt="QR code for the learner link" />
        </div> : null}
        <a className={styles.textLink} href={playPath} target="_blank" rel="noopener noreferrer">Open as learner</a>
        <p>Revocation is permanent for this version. Content already delivered cannot be recalled; open players recheck periodically.</p>
        <button disabled={busy} onClick={() => { if (window.confirm("Permanently revoke this version’s learner link?")) void act("revoke"); }}>Revoke</button>
      </div> : null}
    </>}
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}

"use client";

import type { ReactNode } from "react";

function Mark({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 320 140" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export function ShelfArt() {
  return (
    <Mark>
      <rect width="320" height="140" fill="#fbf9f1" />
      <rect x="24" y="78" width="272" height="12" fill="#176345" />
      <rect x="36" y="90" width="12" height="28" fill="#103e2f" />
      <rect x="272" y="90" width="12" height="28" fill="#103e2f" />
      <rect x="70" y="40" width="36" height="38" fill="#277655" />
      <rect x="130" y="52" width="70" height="26" fill="#ed9343" />
      <rect x="220" y="46" width="48" height="32" fill="#173329" />
    </Mark>
  );
}

export function PurposeArt() {
  return (
    <Mark>
      <rect width="320" height="140" fill="#fbf9f1" />
      <rect x="48" y="78" width="220" height="14" fill="#103e2f" />
      <rect x="70" y="40" width="16" height="38" fill="#176345" />
      <rect x="230" y="40" width="16" height="38" fill="#176345" />
      <rect x="120" y="58" width="80" height="20" fill="#277655" />
    </Mark>
  );
}

export function RecordArt() {
  return (
    <Mark>
      <rect width="320" height="140" fill="#fbf9f1" />
      <rect x="40" y="28" width="110" height="84" fill="#ffffff" stroke="#173329" strokeWidth="4" />
      <rect x="58" y="48" width="74" height="8" fill="#176345" />
      <rect x="58" y="66" width="60" height="8" fill="#277655" />
      <rect x="190" y="36" width="90" height="70" fill="#103e2f" />
    </Mark>
  );
}

export function BoardArt() {
  return (
    <Mark>
      <rect width="320" height="140" fill="#fbf9f1" />
      <rect x="36" y="22" width="248" height="96" fill="#103e2f" />
      <rect x="54" y="40" width="90" height="22" fill="#fbf9f1" />
      <rect x="156" y="40" width="110" height="22" fill="#ed9343" />
      <rect x="54" y="74" width="212" height="22" fill="#277655" />
    </Mark>
  );
}

export function HandToolArt() {
  return (
    <Mark>
      <rect width="320" height="140" fill="#fbf9f1" />
      <rect x="70" y="78" width="180" height="12" fill="#176345" />
      <rect x="118" y="36" width="18" height="42" fill="#173329" />
      <rect x="100" y="28" width="54" height="14" fill="#ed9343" />
    </Mark>
  );
}

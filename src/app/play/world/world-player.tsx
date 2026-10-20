"use client";

import Link from "next/link";
import { sharedShelf } from "@adeena/experience-schema";
import { PlayerApp } from "@/player/player-app";
import styles from "@/player/player.module.css";
import { sharedShelfPresentation } from "../demo/presentation";
import { worldRenderer } from "./world-renderer";

export function WorldPlayer() {
  return (
    <div className={styles.frame}>
      <Link className={styles.home} href="/">
        adeena
      </Link>
      <p>
        <Link className={styles.roomLink} href="/play/demo" prefetch={false}>
          Use the text player
        </Link>
      </p>
      <PlayerApp manifest={sharedShelf} presentation={sharedShelfPresentation} renderer={worldRenderer} />
    </div>
  );
}

"use client";

import Link from "next/link";
import { sharedShelf } from "@adeena/experience-schema";
import { PlayerApp } from "@/player/player-app";
import styles from "@/player/player.module.css";
import { sharedShelfPresentation } from "./presentation";
import { sharedShelfRenderer } from "./renderer";

export function DemoPlayer() {
  return (
    <div className={styles.frame}>
      <Link className={styles.home} href="/">
        adeena
      </Link>
      <p>
        <Link className={styles.roomLink} href="/play/world" prefetch={false}>
          Open the resource room
        </Link>
      </p>
      <PlayerApp manifest={sharedShelf} presentation={sharedShelfPresentation} renderer={sharedShelfRenderer} />
    </div>
  );
}

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("creator entry", () => {
  it("opens with the learning question and an honest share step", () => {
    const page = readFileSync("src/app/creator/page.tsx", "utf8");
    expect(page).toContain("Create a learning game");
    expect(page).toContain("Checking your session");
    const session = readFileSync("src/app/creator/creator-session.tsx", "utf8");
    const create = readFileSync("src/app/creator/new-experience.tsx", "utf8");
    expect(session).toContain("Start with your content");
    expect(create).toContain("Create new experience");
    expect(session).toContain("Continue saved work");
    expect(session).toContain("Games stay private until you review and publish them.");
    expect(session).toContain("Private");
    expect(session).toContain('redirect("/login?next=/creator")');
    expect(session).not.toContain('href="/studio"');
  });
});

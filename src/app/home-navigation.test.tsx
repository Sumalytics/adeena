import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { config } from "@/proxy";
import { HomeNavigation } from "./home-navigation";

describe("homepage navigation", () => {
  it("sends a guest through authentication toward the creator workspace", () => {
    const html = renderToStaticMarkup(<HomeNavigation signedIn={false} />);
    expect(html).toContain('href="/login?next=/creator"');
    expect(html).toContain("Sign in");
    expect(html).toContain('href="/register"');
    expect(html).toContain("Create account");
    expect(html).toContain("Create experience");
    expect(html).not.toContain("/studio");
    expect(html).not.toContain("workspaceId");
  });

  it("sends a signed-in creator to the creator workspace", () => {
    const html = renderToStaticMarkup(<HomeNavigation signedIn={true} />);
    expect(html).toContain('href="/creator"');
    expect(html).toContain("Creator workspace");
    expect(html).toContain("Create experience");
    expect(html).toContain('action="/auth/logout"');
    expect(html).toContain("Log out");
    expect(html).not.toContain("/studio");
    expect(html).not.toContain("workspaceId");
  });

  it("keeps the homepage session check off the static shell and away from Studio", () => {
    const source = readFileSync("src/app/page.tsx", "utf8");
    expect(source).toContain("readVerifiedSession");
    expect(source).toContain("Checking your session");
    expect(source).not.toContain("/studio");
    expect(source).not.toContain("workspaceId");
  });

  it("keeps creator authentication and public play routes in place", () => {
    const creator = readFileSync("src/app/creator/creator-session.tsx", "utf8");
    expect(creator).toContain("readVerifiedSession");
    expect(creator).toContain('redirect("/login?next=/creator")');
    expect(creator).not.toContain('href="/studio"');
    const play = readFileSync("src/app/play/demo/page.tsx", "utf8") + readFileSync("src/app/play/world/page.tsx", "utf8");
    expect(play).not.toContain("readVerifiedSession");
    expect(config.matcher.join(" ")).not.toContain("/play");
  });
});

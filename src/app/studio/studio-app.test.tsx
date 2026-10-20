import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AUDIENCE_OPTIONS } from "./studio-form";
import { StudioApp } from "./studio-app";

describe("Creator Studio audience control", () => {
  it("renders a native audience select with a placeholder and eight options", () => {
    const html = renderToStaticMarkup(<StudioApp />);
    expect(html).toContain('<select id="audience"');
    expect(html).not.toContain('id="audience" type="text"');
    expect(html).toContain('<option value="" selected="">Select an audience</option>');
    for (const option of AUDIENCE_OPTIONS) {
      expect(html).toContain(`<option value="${option}">${option}</option>`);
    }
    expect(html).toContain('<select id="age-band"');
    expect(html).toContain(">Generate preview</button>");
    expect(html).toMatch(/<button type="submit"[^>]*disabled/);
    expect(html).not.toContain('id="audience" tabindex="-1"');
    expect(html).not.toContain('id="audience" disabled');
  });
});

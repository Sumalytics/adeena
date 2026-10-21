export function collapsed(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function groundFacts(
  facts: readonly { claim: string; spanId: string }[],
  spans: readonly { id: string; excerpt: string }[],
) {
  const diagnostics: { code: string; message: string }[] = [];
  for (const fact of facts) {
    const span = spans.find((item) => item.id === fact.spanId);
    if (!span) {
      diagnostics.push({
        code: "grounding.missing-span",
        message: "A source reference does not belong to this document.",
      });
      continue;
    }
    const excerpt = collapsed(span.excerpt).toLowerCase();
    const claim = collapsed(fact.claim).toLowerCase();
    if (!excerpt.includes(claim)) {
      diagnostics.push({
        code: "grounding.unsupported-claim",
        message: "A factual claim is not contained in its source span.",
      });
    }
  }
  return diagnostics;
}

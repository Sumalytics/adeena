export const AUDIENCE_OPTIONS = [
  "Early childhood",
  "Primary learners",
  "Junior secondary learners",
  "Senior secondary learners",
  "Higher education",
  "Workplace learners",
  "Community learners",
  "General audience",
] as const;

export type AudienceOption = (typeof AUDIENCE_OPTIONS)[number];

export type StudioDraft<Preview> = {
  sourceLabel: string;
  audienceLabel: string;
  ageBand: string;
  fileNote: string;
  preview: Preview | null;
  optionId: string;
  scoreText: string;
  shareReasons: string[] | null;
  error: string;
};

export type StudioAction<Preview> =
  | { type: "source"; value: string }
  | { type: "audience"; value: string }
  | { type: "age"; value: string }
  | { type: "file"; note: string; sourceLabel?: string }
  | { type: "preview"; preview: Preview }
  | { type: "preview-error"; message: string }
  | { type: "score"; text: string }
  | { type: "share"; reasons: string[] }
  | { type: "option"; id: string }
  | { type: "reset-feedback" };

export function initialStudioDraft<Preview>(): StudioDraft<Preview> {
  return {
    sourceLabel: "",
    audienceLabel: "",
    ageBand: "",
    fileNote: "",
    preview: null,
    optionId: "",
    scoreText: "",
    shareReasons: null,
    error: "",
  };
}

export function isAudienceOption(value: string): value is AudienceOption {
  return (AUDIENCE_OPTIONS as readonly string[]).includes(value);
}

export function canGeneratePreview(input: {
  sourceLabel: string;
  audienceLabel: string;
  ageBand: string;
}): boolean {
  return input.sourceLabel.trim().length > 0 && isAudienceOption(input.audienceLabel) && input.ageBand !== "";
}

export function previewPayload(input: {
  idempotencyKey: string;
  sourceLabel: string;
  audienceLabel: string;
  ageBand: string;
}) {
  return {
    idempotencyKey: input.idempotencyKey,
    source: { label: input.sourceLabel },
    audience: { label: input.audienceLabel, ageBand: input.ageBand },
  };
}

function withoutPreview<Preview>(state: StudioDraft<Preview>): StudioDraft<Preview> {
  return {
    ...state,
    preview: null,
    optionId: "",
    scoreText: "",
    shareReasons: null,
  };
}

export function studioReducer<Preview>(
  state: StudioDraft<Preview>,
  action: StudioAction<Preview>,
): StudioDraft<Preview> {
  switch (action.type) {
    case "source":
      return withoutPreview({ ...state, sourceLabel: action.value });
    case "audience":
      return withoutPreview({ ...state, audienceLabel: action.value });
    case "age":
      return withoutPreview({ ...state, ageBand: action.value });
    case "file":
      return withoutPreview({
        ...state,
        fileNote: action.note,
        sourceLabel: action.sourceLabel ?? state.sourceLabel,
      });
    case "preview":
      return {
        ...state,
        preview: action.preview,
        optionId: "",
        scoreText: "",
        shareReasons: null,
        error: "",
      };
    case "preview-error":
      return { ...state, preview: null, error: action.message };
    case "score":
      return { ...state, scoreText: action.text, error: "" };
    case "share":
      return { ...state, shareReasons: action.reasons, error: "" };
    case "option":
      return { ...state, optionId: action.id };
    case "reset-feedback":
      return { ...state, error: "", scoreText: "", shareReasons: null };
    default:
      return state;
  }
}

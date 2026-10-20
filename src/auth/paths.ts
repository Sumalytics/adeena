export function safeNextPath(value: string | null) {
  if (!value || (value !== "/creator" && !value.startsWith("/creator/"))) return "/creator";
  if (value.startsWith("//") || value.includes("\\") || value.includes("://")) return "/creator";
  return value;
}

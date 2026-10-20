export function validateCredentials(email: string, password: string) {
  const trimmed = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) || trimmed.length > 254) return "Enter a valid email.";
  if (password.length < 8 || password.length > 72) return "Use a password between 8 and 72 characters.";
  return null;
}

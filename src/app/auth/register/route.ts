import { handleRegisterPost } from "@/auth/password-post";

export function POST(request: Request) {
  return handleRegisterPost(request);
}

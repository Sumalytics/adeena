import { handleLoginPost } from "@/auth/password-post";

export function POST(request: Request) {
  return handleLoginPost(request);
}

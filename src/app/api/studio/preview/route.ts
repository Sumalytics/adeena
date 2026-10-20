import { previewJob } from "@/studio/http";
import { demoResponse } from "@/studio/request";

export function POST(request: Request) {
  return demoResponse(request, previewJob);
}

import { studioDeniedResponse, studioFixturesAllowed } from "@/studio/availability";
import { previewJob } from "@/studio/http";
import { demoResponse } from "@/studio/request";

export function POST(request: Request) {
  if (!studioFixturesAllowed()) return studioDeniedResponse();
  return demoResponse(request, previewJob);
}

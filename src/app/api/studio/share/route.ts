import { studioDeniedResponse, studioFixturesAllowed } from "@/studio/availability";
import { shareJob } from "@/studio/http";
import { demoResponse } from "@/studio/request";

export function POST(request: Request) {
  if (!studioFixturesAllowed()) return studioDeniedResponse();
  return demoResponse(request, shareJob);
}

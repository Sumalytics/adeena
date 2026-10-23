import { randomUUID } from "node:crypto";
import type { AuthorizedWorkspace } from "./authz";
const FREE_SESSION_ID = randomUUID();
export async function releaseUnusedFreeRequests(workspace: AuthorizedWorkspace, count: number, jobId: string) {
  if (count <= 0) return;
  await workspace.tx`update adeena_free_quota set
    session_requests = case when session_id=${FREE_SESSION_ID} then greatest(0,session_requests-${count}) else session_requests end,
    day_requests = case when usage_day=(select (created_at at time zone 'utc')::date from experience_generation_costs where job_id=${jobId}::uuid) then greatest(0,day_requests-${count}) else day_requests end,
    updated_at=now() where id='development'`;
}
export async function claimFreeRequest(
  workspace: AuthorizedWorkspace,
  sessionLimit: number,
  dayLimit: number,
  locked?: { session_id: string; session_requests: number; day_requests: number; usage_day: string },
) {
  const row = locked ?? (await workspace.tx<{ session_id: string; session_requests: number; day_requests: number; usage_day: string }[]>`
    select session_id, session_requests::int, day_requests::int, to_char(usage_day, 'YYYY-MM-DD') as usage_day
    from adeena_free_quota where id = 'development' for update
  `)[0];
  if (!row) return false;
  const todayRows = await workspace.tx<{ day: string }[]>`select to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD') as day`;
  const today = todayRows[0]?.day ?? "";
  let sessionRequests = row.session_id === FREE_SESSION_ID ? Number(row.session_requests) : 0;
  let dayRequests = row.usage_day === today ? Number(row.day_requests) : 0;
  if (sessionRequests + 1 > sessionLimit || dayRequests + 1 > dayLimit) return false;
  sessionRequests += 1;
  dayRequests += 1;
  await workspace.tx`
    update adeena_free_quota
    set session_id = ${FREE_SESSION_ID}, session_requests = ${sessionRequests}, day_requests = ${dayRequests},
      usage_day = ${today}::date, updated_at = now()
    where id = 'development'
  `;
  return true;
}

export async function reserveAnotherEstimate(workspace: AuthorizedWorkspace, estimatedMicros: number, spendCapMicros: number) {
  const locked = await workspace.tx<{ reserved_micros: number }[]>`
    select reserved_micros::int from adeena_edit_spend where id = 'development' for update
  `;
  const reserved = locked[0] ? Number(locked[0].reserved_micros) : null;
  if (reserved === null || reserved + estimatedMicros > spendCapMicros) return false;
  await workspace.tx`
    update adeena_edit_spend
    set reserved_micros = reserved_micros + ${estimatedMicros}, updated_at = now()
    where id = 'development'
  `;
  return true;
}

export async function reconcileReservation(workspace: AuthorizedWorkspace, reservedMicros: number, keptMicros: number) {
  const delta = keptMicros - reservedMicros;
  await workspace.tx`select reserved_micros from adeena_edit_spend where id = 'development' for update`;
  await workspace.tx`
    update adeena_edit_spend
    set reserved_micros = greatest(0, reserved_micros + ${delta}), updated_at = now()
    where id = 'development'
  `;
}

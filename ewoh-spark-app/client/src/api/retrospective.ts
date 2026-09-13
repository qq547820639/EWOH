import { axiosForBackend } from '../lib/http';
import type { RetrospectiveLesson, RetrospectiveRecord } from '@shared/retrospective';

/** 复盘/运行记忆 API（standalone_075，DR-3）。 */

export async function assembleRetrospectiveFromPlan(
  planId: string,
): Promise<{ record: RetrospectiveRecord; created: boolean }> {
  const res = await axiosForBackend({
    url: '/api/retrospective/from-plan',
    method: 'POST',
    data: { planId },
    timeout: 60_000,
  });
  return res.data;
}

export async function listRetrospectives(opts?: {
  scope?: string;
  status?: string;
  limit?: number;
}): Promise<RetrospectiveRecord[]> {
  const res = await axiosForBackend({
    url: '/api/retrospective',
    method: 'GET',
    params: opts,
  });
  return res.data;
}

export async function getRetrospective(retrospectiveId: string): Promise<RetrospectiveRecord> {
  const res = await axiosForBackend({
    url: `/api/retrospective/${encodeURIComponent(retrospectiveId)}`,
    method: 'GET',
  });
  return res.data;
}

export async function publishRetrospective(retrospectiveId: string): Promise<RetrospectiveRecord> {
  const res = await axiosForBackend({
    url: `/api/retrospective/${encodeURIComponent(retrospectiveId)}/publish`,
    method: 'POST',
  });
  return res.data;
}

export async function updateRetrospectiveLessons(
  retrospectiveId: string,
  lessons: RetrospectiveLesson[],
): Promise<RetrospectiveRecord> {
  const res = await axiosForBackend({
    url: `/api/retrospective/${encodeURIComponent(retrospectiveId)}/lessons`,
    method: 'POST',
    data: { lessons },
  });
  return res.data;
}

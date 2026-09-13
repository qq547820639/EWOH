import { axiosForBackend } from '../lib/http';
import type {
  DataQualityConfirmation,
  DataQualityVerdict,
} from '@shared/data-quality-confirmation';

/** 数据质量人工确认 API（standalone_076，DR-4 闭环第②步）。 */

export async function confirmDataQuality(input: {
  eventId: string;
  verdict: DataQualityVerdict;
  note?: string | null;
}): Promise<{ record: DataQualityConfirmation; created: boolean; linkedAlertsResolved: number }> {
  const res = await axiosForBackend({
    url: '/api/data-quality/confirmations',
    method: 'POST',
    data: input,
  });
  return res.data;
}

export async function getDataQualityConfirmations(
  eventIds: string[],
): Promise<DataQualityConfirmation[]> {
  if (eventIds.length === 0) return [];
  const res = await axiosForBackend({
    url: '/api/data-quality/confirmations',
    method: 'GET',
    params: { eventIds: eventIds.slice(0, 100).join(',') },
  });
  return res.data;
}

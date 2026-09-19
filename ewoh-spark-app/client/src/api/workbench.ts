import { axiosForBackend } from '../lib/http';

export interface WorkbenchNowItem {
  kind: 'anomaly' | 'approval' | 'notification' | 'material_gap';
  priority: 1 | 2 | 3 | 4 | 5;
  title: string;
  ref: string;
  route: string;
  severity: string | null;
  createdAt: string;
  detail?: string;
}

export interface WorkbenchNowResponse {
  items: WorkbenchNowItem[];
  generatedAt: string;
}

export async function getWorkbenchNow(): Promise<WorkbenchNowResponse> {
  const res = await axiosForBackend({
    url: '/api/dashboard/now',
    method: 'GET',
  });
  return res.data as WorkbenchNowResponse;
}

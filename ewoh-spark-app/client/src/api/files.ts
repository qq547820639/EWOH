import type { FileRecord } from '@shared/api.interface';
import { axiosForBackend } from '../lib/http';

export async function uploadFile(file: File, note?: string): Promise<FileRecord> {
  const form = new FormData();
  form.append('file', file);
  if (note) {
    form.append('note', note);
  }
  const res = await axiosForBackend<FileRecord>({
    url: '/api/files',
    method: 'POST',
    data: form,
  });
  return res.data;
}

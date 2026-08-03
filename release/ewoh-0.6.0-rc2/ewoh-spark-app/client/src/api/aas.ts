import { axiosForBackend } from '../lib/http';

export type AasValueType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'dateTime'
  | 'json';

export interface AasElement {
  idShort: string;
  value: unknown;
  valueType: AasValueType;
  unit?: string;
  semanticId?: string;
}

export interface AasSubmodel {
  id: string;
  idShort: string;
  elements: AasElement[];
}

export interface AasAsset {
  assetId: string;
  idShort: string;
  submodels: AasSubmodel[];
  importedBy: string;
  importedAt: string;
}

export interface AasSemantics {
  assetId: string;
  idShort: string;
  semantics: string[];
  submodels: Array<{
    id: string;
    idShort: string;
    properties: Array<{
      name: string;
      value: unknown;
      valueType: string;
      unit?: string;
      semanticId?: string;
    }>;
  }>;
}

export async function listAasAssets(): Promise<AasAsset[]> {
  const res = await axiosForBackend({ url: '/api/aas/assets', method: 'GET' });
  return res.data;
}

export async function importAasAsset(body: {
  assetId: string;
  idShort: string;
  submodels: AasSubmodel[];
}): Promise<AasAsset> {
  const res = await axiosForBackend({
    url: '/api/aas/assets',
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function getAasSemantics(assetId: string): Promise<AasSemantics> {
  const res = await axiosForBackend({
    url: `/api/aas/assets/${encodeURIComponent(assetId)}/semantics`,
    method: 'GET',
  });
  return res.data;
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';

interface GoldenFactory {
  apiVersion: string;
  kind: string;
  metadata?: { name?: string; version?: string };
  spec?: {
    compatibleCore?: string;
    modules?: string[];
    requiredConnectors?: Array<{
      id?: string;
      version?: string;
      runtime?: string;
      protocol?: string;
    }>;
    scenarioPacks?: Array<{
      id?: string;
      version?: string;
      workflows?: string[];
      policies?: string[];
      acceptance?: string;
    }>;
  };
}

describe('EWOH Golden Factory contract', () => {
  const spec = load(
    readFileSync(
      resolve(process.cwd(), '../contracts/factory/golden-factory.yaml'),
      'utf8',
    ),
  ) as GoldenFactory;

  it('is a versioned ewoh.io FactoryTemplate', () => {
    expect(spec.apiVersion).toBe('ewoh.io/v1alpha1');
    expect(spec.kind).toBe('FactoryTemplate');
    expect(spec.metadata?.name).toBe('ewoh-golden-standard');
    expect(spec.metadata?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(spec.spec?.compatibleCore).toMatch(/^>=/);
  });

  it('covers the MES/OEE/andon/audit baseline modules', () => {
    for (const module of [
      'organization',
      'device',
      'mes-p0',
      'oee',
      'andon',
      'audit',
    ]) {
      expect(spec.spec?.modules).toContain(module);
    }
  });

  it('defines at least three connectors and four scenario packs', () => {
    expect(spec.spec?.requiredConnectors?.length).toBeGreaterThanOrEqual(3);
    expect(spec.spec?.scenarioPacks?.length).toBeGreaterThanOrEqual(4);
  });

  it('keeps connector and scenario ids unique', () => {
    const connectorIds = (spec.spec?.requiredConnectors ?? []).map(
      (connector) => connector.id,
    );
    const scenarioIds = (spec.spec?.scenarioPacks ?? []).map((pack) => pack.id);
    expect(new Set(connectorIds).size).toBe(connectorIds.length);
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';

interface Chart {
  apiVersion: string;
  name: string;
  version: string;
  appVersion: string;
}

interface Values {
  namespace?: { name?: string; create?: boolean };
  image?: { repository?: string; tag?: string; pullPolicy?: string };
  replicaCount?: number;
  service?: { port?: number; targetPort?: string };
  ingress?: { enabled?: boolean; host?: string };
  autoscaling?: {
    enabled?: boolean;
    minReplicas?: number;
    maxReplicas?: number;
  };
  pdb?: { minAvailable?: number };
  secret?: { create?: boolean; name?: string };
  migration?: { enabled?: boolean; secretName?: string };
  storage?: { driver?: string; pvcName?: string };
  factory?: {
    id?: string;
    name?: string;
    upgradeRing?: string;
  };
}

describe('EWOH Helm chart contract', () => {
  const chart = load(
    readFileSync(
      resolve(process.cwd(), '../deploy/cloud/helm/ewoh/Chart.yaml'),
      'utf8',
    ),
  ) as Chart;
  const values = load(
    readFileSync(
      resolve(process.cwd(), '../deploy/cloud/helm/ewoh/values.yaml'),
      'utf8',
    ),
  ) as Values;

  it('is a v2 application chart with a semver version', () => {
    expect(chart.apiVersion).toBe('v2');
    expect(chart.name).toBe('ewoh');
    expect(chart.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(chart.appVersion).toBe('0.6.0-rc4');
  });

  it('defaults to a three-replica HA deployment with HPA and PDB', () => {
    expect(values.replicaCount).toBeGreaterThanOrEqual(3);
    expect(values.autoscaling?.enabled).toBe(true);
    expect(values.autoscaling?.minReplicas).toBeGreaterThanOrEqual(3);
    expect(values.autoscaling?.maxReplicas).toBeGreaterThanOrEqual(
      values.autoscaling?.minReplicas ?? 0,
    );
    expect(Number(values.pdb?.minAvailable)).toBeGreaterThanOrEqual(2);
  });

  it('carries factory values and never generates secrets from defaults', () => {
    expect(values.factory?.upgradeRing).toBe('pilot');
    expect(values.factory?.id).toBeTruthy();
    expect(values.factory?.name).toBeTruthy();
    expect(values.secret?.create).toBe(false);
  });

  it('exposes expected template files', () => {
    const expected = [
      'configmap.yaml',
      'deployment.yaml',
      'hpa.yaml',
      'ingress.yaml',
      'migration-job.yaml',
      'namespace.yaml',
      'pdb.yaml',
      'persistentvolumeclaim.yaml',
      'service.yaml',
    ];
    const dir = resolve(process.cwd(), '../deploy/cloud/helm/ewoh/templates');
    for (const name of expected) {
      expect(() => readFileSync(resolve(dir, name), 'utf8')).not.toThrow();
    }
  });
});

import path from 'node:path';
import { auditRepoFacts } from '../../../scripts/audit-repo-facts';

describe('audit-repo-facts', () => {
  it('passes all repository fact-source consistency checks', () => {
    const checks = auditRepoFacts(path.resolve(__dirname, '../../..'));
    const failed = checks.filter((entry) => !entry.ok);
    expect(failed).toEqual([]);
  });
});

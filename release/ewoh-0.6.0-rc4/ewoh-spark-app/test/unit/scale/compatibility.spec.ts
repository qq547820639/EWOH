import {
  matchesCoreRange,
  parseVersion,
} from '../../../server/modules/scale/compatibility';

describe('scale compatibility helpers', () => {
  it('parses semver-like versions with prerelease', () => {
    expect(parseVersion('0.6.0-rc2')).toEqual({
      major: 0,
      minor: 6,
      patch: 0,
      prerelease: ['rc2'],
    });
    expect(parseVersion('not-a-version')).toBeNull();
  });

  it('matches a core range with lower and upper bounds', () => {
    expect(matchesCoreRange('>=0.6.0-rc2 <1.0.0', '0.6.0-rc2')).toBe(true);
    expect(matchesCoreRange('>=0.6.0-rc2 <1.0.0', '0.7.0')).toBe(true);
    expect(matchesCoreRange('>=0.6.0-rc2 <1.0.0', '1.0.0')).toBe(false);
  });

  it('treats missing ranges as unconstrained', () => {
    expect(matchesCoreRange(null, '0.6.0-rc2')).toBe(true);
    expect(matchesCoreRange(undefined, '0.6.0-rc2')).toBe(true);
    expect(matchesCoreRange('', '0.6.0-rc2')).toBe(true);
  });

  it('orders prereleases before their release', () => {
    expect(matchesCoreRange('<=0.6.0', '0.6.0-rc2')).toBe(true);
    expect(matchesCoreRange('>=0.6.0', '0.6.0-rc2')).toBe(false);
  });
});

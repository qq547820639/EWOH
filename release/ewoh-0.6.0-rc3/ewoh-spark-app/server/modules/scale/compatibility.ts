export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseVersion(input: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    input.trim(),
  );
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : NaN;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : NaN;
    if (Number.isNaN(leftNumber) || Number.isNaN(rightNumber)) {
      if (leftPart !== rightPart) {
        return leftPart < rightPart ? -1 : 1;
      }
    } else if (leftNumber !== rightNumber) {
      return leftNumber < rightNumber ? -1 : 1;
    }
  }
  return 0;
}

export function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) {
      return left[key] < right[key] ? -1 : 1;
    }
  }
  const leftPrerelease = left.prerelease.length > 0;
  const rightPrerelease = right.prerelease.length > 0;
  if (leftPrerelease !== rightPrerelease) {
    return leftPrerelease ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function matchesCoreRange(
  range: string | null | undefined,
  version: string,
): boolean {
  if (!range || !range.trim()) {
    return true;
  }
  const parsedVersion = parseVersion(version);
  if (!parsedVersion) {
    return false;
  }
  const tokens = range.trim().split(/\s+/);
  for (const token of tokens) {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(token);
    if (!match) {
      return false;
    }
    const operator = match[1] || '=';
    const target = parseVersion(match[2]);
    if (!target) {
      return false;
    }
    const comparison = compareVersions(parsedVersion, target);
    switch (operator) {
      case '>=':
        if (comparison < 0) return false;
        break;
      case '<=':
        if (comparison > 0) return false;
        break;
      case '>':
        if (comparison <= 0) return false;
        break;
      case '<':
        if (comparison >= 0) return false;
        break;
      case '=':
        if (comparison !== 0) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

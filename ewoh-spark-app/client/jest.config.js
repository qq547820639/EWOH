const { jestAliasMap } = require('../scripts/jest-alias-map.cjs');

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  // V342：这份配置没有被任何配方接入（V1xx 已按"死配置"归档），但别名表照样改成派生——
  // 留着手抄的那份才会成为"只改一边"的靶子。
  moduleNameMapper: jestAliasMap({ rootDir: __dirname, tsconfig: 'tsconfig.spec.json' }),
};

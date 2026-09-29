const path = require('path');
const { jestAliasMap } = require('../../scripts/jest-alias-map.cjs');

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '../..',
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.spec.json',
      },
    ],
  },
  // V342：别名表由 ts-jest 用的那份 tsconfig 现算，不再手抄；rootDir 也从同一处取，避免两处各算一层。
  moduleNameMapper: jestAliasMap({ rootDir: path.resolve(__dirname, '../..'), tsconfig: 'tsconfig.spec.json' }),
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  testMatch: ['<rootDir>/test/e2e/**/*.e2e.spec.ts'],
  setupFiles: ['<rootDir>/test/e2e/e2e-global-env.ts'],
  testTimeout: 60000,
  maxWorkers: 1,
  clearMocks: true,
  verbose: true,
};

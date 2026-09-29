// 后端默认跑测档（V342 起从 package.json 的 `jest` 键迁到这份文件）。
// 迁移原因：`moduleNameMapper` 由 tsconfig 的 paths 现算（见 scripts/jest-alias-map.cjs），
// 而 JSON 里放不了函数调用 ⇒ 别名表在跑测档这一侧不再有手抄副本。
// 注意：jest 29 在同一目录里同时看到 `jest.config.*` 与 package.json 的 `jest` 键会直接拒绝运行
// （"Multiple configurations found"），所以这份文件与那个键必须**同批**存在其一。
const path = require('path');
const { jestAliasMap } = require('./scripts/jest-alias-map.cjs');

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.spec.json',
      },
    ],
  },
  moduleNameMapper: jestAliasMap({ rootDir: __dirname, tsconfig: 'tsconfig.spec.json' }),
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '<rootDir>/test/e2e/', '<rootDir>/test/browser/'],
  testMatch: [
    '<rootDir>/server/**/*.spec.ts',
    '<rootDir>/shared/**/*.spec.ts',
    '<rootDir>/test/**/*.spec.ts',
  ],
};

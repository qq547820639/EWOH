const { jestAliasMap } = require('../scripts/jest-alias-map.cjs');

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        // 基座 tsconfig.app.json + esModuleInterop（与 Vite/esbuild 的 CJS 互操作对齐，
        // 保证 `import React from 'react'` 等默认导入在 node/jest 下等价于真实构建）。
        tsconfig: '<rootDir>/tsconfig.jest.json',
      },
    ],
  },
  // V342：这张表由 ts-jest 用的那份 tsconfig 的 paths 现算，不再手抄（手抄才是"只改一边"会漂移的根源）。
  // prefix 也不用写死：由本配置的 rootDir（＝client/）与那份 tsconfig 自己的 baseUrl（＝包根）算相对关系。
  moduleNameMapper: jestAliasMap({ rootDir: __dirname, tsconfig: 'tsconfig.jest.json' }),
  modulePathIgnorePatterns: ['<rootDir>/../node_modules/', '<rootDir>/../dist/'],
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
};

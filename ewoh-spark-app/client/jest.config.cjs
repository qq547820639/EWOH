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
  moduleNameMapper: {
    // 与 tsconfig.app.json paths 保持一致：@client/* → client/*（rootDir 即 client/）
    '^@client/(.*)$': '<rootDir>/$1',
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@shared/(.*)$': '<rootDir>/../shared/$1',
  },
  modulePathIgnorePatterns: ['<rootDir>/../node_modules/', '<rootDir>/../dist/'],
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
};

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/../tsconfig.app.json',
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

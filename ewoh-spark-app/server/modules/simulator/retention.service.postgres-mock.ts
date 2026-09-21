export const postgres = {
  mock: jest.fn(() => {
    const instance = {
      unsafe: jest.fn(),
      end: jest.fn().mockResolvedValue(undefined),
    };
    postgres.instances.push(instance);
    return instance;
  }),
  instances: [] as Array<{ unsafe: jest.Mock; end: jest.Mock }>,
};

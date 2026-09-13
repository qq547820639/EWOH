const path = require('node:path');
require('tsconfig-paths').register({
  baseUrl: path.resolve(__dirname, '../../dist'),
  paths: { '@shared/*': ['shared/*'], '@server/*': ['server/*'] },
});
require('../../dist/server/standalone-main').bootstrapStandalone().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://ondaqui:ondaqui@localhost:5432/ondaqui_test',
      JWT_SECRET: 'segredo-de-teste',
      UPLOAD_DIR: './uploads-test',
      PUSH_MODE: 'test',
      SMS_PROVIDER: 'test',
      // os testes antigos cadastram sem código; test/codigos.test.ts liga a confirmação
      PHONE_VERIFICATION: 'off',
    },
  },
});

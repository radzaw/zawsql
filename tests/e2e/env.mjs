// Shared settings for the end-to-end tests. The database comes from the same variables as the C# tests.
export const PORT = Number(process.env.ZAWSQL_E2E_PORT ?? 5199);
export const TOKEN = process.env.ZAWSQL_E2E_TOKEN ?? 'e2e-token-0123456789abcdef';
export const DB = {
  host: process.env.ZAWSQL_TEST_HOST ?? '127.0.0.1',
  port: Number(process.env.ZAWSQL_TEST_PORT ?? 3306),
  user: process.env.ZAWSQL_TEST_USER ?? 'root',
  password: process.env.ZAWSQL_TEST_PASSWORD ?? '',
};
// Optional SSH tunnel test (see tests/ssh); dbHost/dbPort are the database as seen from the SSH server.
export const SSH = {
  host: process.env.ZAWSQL_TEST_SSH_HOST ?? '',
  port: Number(process.env.ZAWSQL_TEST_SSH_PORT ?? 22),
  user: process.env.ZAWSQL_TEST_SSH_USER ?? 'tunnel',
  password: process.env.ZAWSQL_TEST_SSH_PASSWORD ?? 'tunnel-pass',
  dbHost: process.env.ZAWSQL_TEST_SSH_DB_HOST ?? '127.0.0.1',
  dbPort: Number(process.env.ZAWSQL_TEST_SSH_DB_PORT ?? 3306),
};

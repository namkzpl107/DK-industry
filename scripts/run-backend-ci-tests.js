const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

require(path.resolve(__dirname, '../backend/node_modules/dotenv')).config({ path: path.resolve(__dirname, '../backend/.env') });

const testUri = String(process.env.TEST_MONGODB_URI || '').trim();
if (!testUri) {
  console.error('TEST_MONGODB_URI is required for the pre-push integration gate. Use a dedicated database ending in _test or -test.');
  process.exit(1);
}
let databaseName;
try { databaseName = new URL(testUri).pathname.replace(/^\//, '').split('/')[0]; }
catch { console.error('TEST_MONGODB_URI is invalid'); process.exit(1); }
if (!/(?:^|[_-])test$/i.test(databaseName)) {
  console.error('TEST_MONGODB_URI must use a dedicated database name ending in _test or -test.');
  process.exit(1);
}

// Keep real .env SMTP credentials from ever delivering integration-test mail.
const env = { ...process.env, NODE_ENV: 'test', EMAIL_TRANSPORT: 'json', MONGODB_URI: testUri, TEST_MONGODB_URI: testUri };
for (const name of ['ADMIN', 'AUTH', 'CHAT', 'CUSTOMER', 'LEAD', 'STAFF', 'SUPPORT']) env[`RUN_${name}_INTEGRATION`] = '1';
const backendRoot = path.resolve(__dirname, '../backend');
const c8Cli = path.join(backendRoot, 'node_modules', 'c8', 'bin', 'c8.js');
const reportsDirectory = path.join(os.tmpdir(), `dk-industry-backend-coverage-${process.pid}`);
const args = [
  c8Cli,
  '--reporter=text', '--reporter=lcov',
  '--reports-dir', reportsDirectory,
  '--check-coverage',
  '--statements', '40', '--branches', '55', '--functions', '35', '--lines', '40',
  process.execPath, '--test'
];
const result = spawnSync(process.execPath, args, { cwd: backendRoot, env, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);

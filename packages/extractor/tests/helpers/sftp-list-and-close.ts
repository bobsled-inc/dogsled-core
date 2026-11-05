import { SftpFileStorageClient } from '../../src/runtime/clients/sftp-file-client.js';

/**
 * Child-process script for the close test: it lists files, closes the
 * client and returns. The process must then exit on its own.
 */
const client = await SftpFileStorageClient.create(
  {
    host: '127.0.0.1',
    port: Number(process.env['SFTP_TEST_PORT']),
    username: 'acme',
    base_directory: '/data',
    keepalive_interval_seconds: 1,
  },
  {
    type: 'password',
    password_env: 'SFTP_TEST_PASSWORD',
    host_fingerprint: process.env['SFTP_TEST_FINGERPRINT'],
  },
  undefined,
  ['SFTP_TEST_PASSWORD']
);
for await (const file of client.list({ path: '*.csv' })) {
  process.stdout.write(`${file.path}\n`);
}
await client.close();

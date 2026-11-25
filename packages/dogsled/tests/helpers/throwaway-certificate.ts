import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const length =
    body.length < 0x80
      ? [body.length]
      : body.length < 0x100
        ? [0x81, body.length]
        : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

const sequence = (...parts: Buffer[]): Buffer => der(0x30, ...parts);
const oid = (hex: string): Buffer => der(0x06, Buffer.from(hex, 'hex'));
const octets = (value: Buffer): Buffer => der(0x04, value);
const utcTime = (date: Date): Buffer =>
  der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));

const ECDSA_WITH_SHA256 = sequence(oid('2a8648ce3d040302'));
const COMMON_NAME = oid('550403');
const SUBJECT_ALT_NAME = oid('551d11');
const BASIC_CONSTRAINTS = oid('551d13');
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A self-signed certificate for 127.0.0.1 and its key, made in memory for one test run.
 * Trust it with `NODE_EXTRA_CA_CERTS`; certificate checks stay on.
 */
export function createThrowawayCertificate(): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const name = sequence(
    der(0x31, sequence(COMMON_NAME, der(0x0c, Buffer.from('throwaway.example'))))
  );
  const extensions = sequence(
    sequence(
      BASIC_CONSTRAINTS,
      der(0x01, Buffer.from([0xff])),
      octets(sequence(der(0x01, Buffer.from([0xff]))))
    ),
    sequence(SUBJECT_ALT_NAME, octets(sequence(der(0x87, Buffer.from([127, 0, 0, 1])))))
  );
  const now = Date.now();
  const certificate = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.concat([Buffer.from([0x01]), randomBytes(8)])),
    ECDSA_WITH_SHA256,
    name,
    sequence(utcTime(new Date(now - DAY_MS)), utcTime(new Date(now + DAY_MS))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, extensions)
  );
  const signature = sign('sha256', certificate, privateKey);
  const signed = sequence(certificate, ECDSA_WITH_SHA256, der(0x03, Buffer.from([0]), signature));
  const body = signed.toString('base64').replace(/.{1,64}/g, '$&\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${body}-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

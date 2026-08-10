import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const localCertificatePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  '.dev',
  'certs',
  'localhost.pem',
);

/**
 * Chromium applies Playwright's ignoreHTTPSErrors setting to page requests, but
 * its service-worker fetch can still reject the repository's self-signed local
 * certificate. Trust only the exact public key generated for this repository's
 * local certificate instead of disabling certificate checks for the browser.
 */
export function localCertificateSpkiArgument(): string {
  const certificate = new X509Certificate(readFileSync(localCertificatePath));
  if (certificate.subjectAltName?.includes('IP Address:127.0.0.1') !== true) {
    throw new Error('PLAYWRIGHT_TLS_CERTIFICATE_MISSING_LOOPBACK_SAN');
  }

  const subjectPublicKeyInfo = certificate.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(subjectPublicKeyInfo)) {
    throw new Error('PLAYWRIGHT_TLS_PUBLIC_KEY_EXPORT_INVALID');
  }

  const fingerprint = createHash('sha256').update(subjectPublicKeyInfo).digest('base64');
  return `--ignore-certificate-errors-spki-list=${fingerprint}`;
}

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { join } from 'node:path';

import {
  CERTIFICATE_KEY_PATH,
  CERTIFICATE_PATH,
  REPOSITORY_NAME,
  REPOSITORY_ROOT,
} from './lib.mjs';

/** @param {string[]} argumentsList @returns {number} */
function parsePort(argumentsList) {
  const portFlagIndex = argumentsList.indexOf('--port');
  const rawPort = portFlagIndex === -1 ? undefined : argumentsList[portFlagIndex + 1];
  const port = Number.parseInt(rawPort ?? '', 10);
  if (!Number.isSafeInteger(port) || port < 4180 || port > 4189) {
    throw new Error(`FIXTURE_PORT_INVALID value=${rawPort ?? 'missing'}`);
  }
  return port;
}

function readFixtureManifest() {
  const manifestPath = join(REPOSITORY_ROOT, 'validation', 'fixtures', 'manifest.v1.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.fixtures)
  ) {
    throw new Error('FIXTURE_MANIFEST_INVALID');
  }
  return manifest;
}

const port = parsePort(process.argv.slice(2));
const manifest = readFixtureManifest();
const identity = {
  artifactDigest: process.env['DEV_ARTIFACT_DIGEST'] ?? '',
  certificateDigest: process.env['DEV_CERTIFICATE_DIGEST'] ?? '',
  configDigest: process.env['DEV_CONFIG_DIGEST'] ?? '',
  readinessSecret: process.env['DEV_READINESS_SECRET'] ?? '',
  runId: process.env['DEV_RUN_ID'] ?? '',
};
if (Object.values(identity).some((value) => value === '')) {
  throw new Error('FIXTURE_READINESS_IDENTITY_MISSING');
}
const server = createServer(
  {
    cert: readFileSync(CERTIFICATE_PATH),
    key: readFileSync(CERTIFICATE_KEY_PATH),
    minVersion: 'TLSv1.2',
  },
  (incomingRequest, outgoingResponse) => {
    const url = new URL(incomingRequest.url ?? '/', `https://127.0.0.1:${port}`);
    outgoingResponse.setHeader('cache-control', 'no-store');
    outgoingResponse.setHeader(
      'content-security-policy',
      "default-src 'none'; frame-ancestors 'none'",
    );
    outgoingResponse.setHeader('x-content-type-options', 'nosniff');

    if (incomingRequest.method !== 'GET' && incomingRequest.method !== 'HEAD') {
      outgoingResponse.statusCode = 405;
      outgoingResponse.setHeader('allow', 'GET, HEAD');
      outgoingResponse.end();
      return;
    }

    let payload;
    if (url.pathname === '/livez') {
      payload = {
        host: '127.0.0.1',
        pid: process.pid,
        port,
        repository: REPOSITORY_NAME,
        service: 'fixtures',
        status: 'alive',
      };
    } else if (url.pathname === '/readyz') {
      const challenge = url.searchParams.get('challenge') ?? '';
      if (!/^[a-f0-9]{64}$/u.test(challenge)) {
        outgoingResponse.statusCode = 400;
        outgoingResponse.end();
        return;
      }
      const signatureMessage = [
        challenge,
        REPOSITORY_NAME,
        'fixtures',
        '127.0.0.1',
        String(port),
        String(process.pid),
        identity.runId,
        identity.configDigest,
        identity.artifactDigest,
        identity.certificateDigest,
      ].join('\n');
      payload = {
        artifactDigest: identity.artifactDigest,
        certificateDigest: identity.certificateDigest,
        configDigest: identity.configDigest,
        corpusReady: manifest.fixtures.length > 0,
        fixtureCount: manifest.fixtures.length,
        host: '127.0.0.1',
        pid: process.pid,
        port,
        repository: REPOSITORY_NAME,
        runId: identity.runId,
        schemaVersion: manifest.schemaVersion,
        service: 'fixtures',
        signature: createHmac('sha256', identity.readinessSecret)
          .update(signatureMessage)
          .digest('hex'),
        status: 'ready',
      };
    } else if (url.pathname === '/fixtures/manifest.v1.json') {
      payload = manifest;
    } else {
      outgoingResponse.statusCode = 404;
      outgoingResponse.end();
      return;
    }

    outgoingResponse.statusCode = 200;
    outgoingResponse.setHeader('content-type', 'application/json; charset=utf-8');
    outgoingResponse.end(incomingRequest.method === 'HEAD' ? undefined : JSON.stringify(payload));
  },
);

server.on('error', (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close((error) => {
      if (error !== undefined) {
        console.error(error.message);
        process.exitCode = 1;
      }
    });
  });
}

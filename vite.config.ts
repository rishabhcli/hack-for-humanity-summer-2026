import { createHmac } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig, type Connect, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const repositoryName = 'hack-for-humanity-summer-2026';
const serviceName = process.env['DEV_SERVICE_NAME'] ?? 'pwa';
const servicePort = Number.parseInt(process.env['DEV_SERVICE_PORT'] ?? '4180', 10);
const repositoryRoot = resolve(import.meta.dirname);
const certificatePath = resolve(repositoryRoot, '.dev/certs/localhost.pem');
const certificateKeyPath = resolve(repositoryRoot, '.dev/certs/localhost-key.pem');
const readinessIdentity = {
  artifactDigest: process.env['DEV_ARTIFACT_DIGEST'] ?? '',
  certificateDigest: process.env['DEV_CERTIFICATE_DIGEST'] ?? '',
  configDigest: process.env['DEV_CONFIG_DIGEST'] ?? '',
  readinessSecret: process.env['DEV_READINESS_SECRET'] ?? '',
  runId: process.env['DEV_RUN_ID'] ?? '',
};

function httpsConfiguration(): { cert: Buffer; key: Buffer; minVersion: 'TLSv1.2' } | undefined {
  if (!existsSync(certificatePath) || !existsSync(certificateKeyPath)) {
    return undefined;
  }
  for (const path of [certificatePath, certificateKeyPath]) {
    const metadata = lstatSync(path);
    const realPath = realpathSync(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      !realPath.startsWith(`${repositoryRoot}/.dev/certs/`)
    ) {
      throw new Error(`TLS_FILE_PATH_REFUSED path=${path}`);
    }
  }
  return {
    cert: readFileSync(certificatePath),
    key: readFileSync(certificateKeyPath),
    minVersion: 'TLSv1.2',
  };
}

function healthMiddleware(): Connect.NextHandleFunction {
  return (request, response, next) => {
    const url = new URL(request.url ?? '/', 'https://127.0.0.1');
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(url.pathname).replaceAll('\\', '/');
    } catch {
      response.statusCode = 400;
      response.end();
      return;
    }
    if (decodedPath.split('/').includes('.dev')) {
      response.statusCode = 404;
      response.setHeader('cache-control', 'no-store');
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.setHeader('x-content-type-options', 'nosniff');
      response.end('Not found');
      return;
    }
    if (url.pathname !== '/livez' && url.pathname !== '/readyz') {
      next();
      return;
    }

    if (url.pathname === '/livez') {
      response.statusCode = 200;
      response.setHeader('cache-control', 'no-store');
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.setHeader('x-content-type-options', 'nosniff');
      response.end(
        JSON.stringify({
          host: '127.0.0.1',
          pid: process.pid,
          port: servicePort,
          repository: repositoryName,
          service: serviceName,
          status: 'alive',
        }),
      );
      return;
    }

    const challenge = url.searchParams.get('challenge') ?? '';
    if (!/^[a-f0-9]{64}$/u.test(challenge)) {
      response.statusCode = 400;
      response.end();
      return;
    }
    const signatureMessage = [
      challenge,
      repositoryName,
      serviceName,
      '127.0.0.1',
      String(servicePort),
      String(process.pid),
      readinessIdentity.runId,
      readinessIdentity.configDigest,
      readinessIdentity.artifactDigest,
      readinessIdentity.certificateDigest,
    ].join('\n');
    const signature = createHmac('sha256', readinessIdentity.readinessSecret)
      .update(signatureMessage)
      .digest('hex');

    response.statusCode = 200;
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('x-content-type-options', 'nosniff');
    response.end(
      JSON.stringify({
        artifactDigest: readinessIdentity.artifactDigest,
        certificateDigest: readinessIdentity.certificateDigest,
        configDigest: readinessIdentity.configDigest,
        host: '127.0.0.1',
        pid: process.pid,
        port: servicePort,
        repository: repositoryName,
        runId: readinessIdentity.runId,
        service: serviceName,
        signature,
        status: 'ready',
      }),
    );
  };
}

function readinessPlugin(): Plugin {
  return {
    configurePreviewServer(server) {
      server.middlewares.use(healthMiddleware());
    },
    configureServer(server) {
      server.middlewares.use(healthMiddleware());
    },
    name: 'repository-readiness',
  };
}

export default defineConfig(({ command }) => {
  const localHttps = httpsConfiguration();
  if (command === 'serve' && localHttps === undefined) {
    throw new Error('TLS_CERTIFICATE_MISSING run="npm run dev:up"');
  }
  if (
    command === 'serve' &&
    (readinessIdentity.artifactDigest === '' ||
      readinessIdentity.certificateDigest === '' ||
      readinessIdentity.configDigest === '' ||
      readinessIdentity.readinessSecret === '' ||
      readinessIdentity.runId === '')
  ) {
    throw new Error('DEV_READINESS_IDENTITY_MISSING run="npm run dev:up"');
  }
  const localHttpsOption = localHttps === undefined ? {} : { https: localHttps };

  return {
    build: {
      assetsInlineLimit: 0,
      reportCompressedSize: true,
      sourcemap: true,
      target: 'es2022',
    },
    cacheDir: `.dev/cache/vite-${serviceName}`,
    plugins: [
      readinessPlugin(),
      VitePWA({
        injectRegister: 'script',
        manifest: {
          background_color: '#0f1a16',
          description:
            'A local-first, non-diagnostic cervical joint-position measurement tool under validation.',
          display: 'standalone',
          lang: 'en',
          name: 'Head repositioning measurement',
          scope: '/',
          short_name: 'Head measurement',
          start_url: '/',
          theme_color: '#12211b',
        },
        registerType: 'prompt',
        workbox: {
          cleanupOutdatedCaches: true,
          globPatterns: ['**/*.{css,html,js,svg}'],
          navigateFallback: '/index.html',
          sourcemap: false,
        },
      }),
    ],
    preview: {
      host: '127.0.0.1',
      ...localHttpsOption,
      port: 4181,
      strictPort: true,
    },
    server: {
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.dev/**'],
      },
      host: '127.0.0.1',
      ...localHttpsOption,
      port: 4180,
      strictPort: true,
      watch: {
        ignored: ['**/.dev/**'],
      },
    },
  };
});

import { createServer } from 'node:net';

const rawPort = process.argv[2] ?? '';
const port = Number.parseInt(rawPort, 10);
if (!Number.isSafeInteger(port) || port < 4184 || port > 4189) {
  throw new Error(`TEST_LISTENER_PORT_INVALID value=${rawPort}`);
}

const server = createServer((socket) => {
  socket.end('foreign test listener\n');
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`ready ${String(port)}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close());
}

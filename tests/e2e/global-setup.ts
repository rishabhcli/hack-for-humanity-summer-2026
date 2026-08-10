import { execFileSync } from 'node:child_process';

export default function globalSetup(): void {
  execFileSync('npm', ['run', 'dev:health'], {
    encoding: 'utf8',
    stdio: 'inherit',
  });
}

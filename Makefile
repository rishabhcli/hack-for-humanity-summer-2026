.PHONY: bootstrap build check dev-down dev-health dev-preflight dev-up eval format lint release-check run-local test test-e2e test-integration typecheck verify-all

bootstrap:
	node scripts/bootstrap.mjs

build:
	npm run build

check:
	npm run check

dev-down:
	npm run dev:down

dev-health:
	npm run dev:health

dev-preflight:
	npm run dev:preflight

dev-up:
	npm run dev:up

eval:
	npm run eval

format:
	npm run format

lint:
	npm run lint

release-check:
	npm run release-check

run-local:
	npm run run-local

test:
	npm run test

test-e2e:
	npm run test-e2e

test-integration:
	npm run test-integration

typecheck:
	npm run typecheck

verify-all:
	npm run verify-all

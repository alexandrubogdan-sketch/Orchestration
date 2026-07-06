.PHONY: dev down logs migrate migrate-up migrate-down migrate-create seed \
        test test-unit test-contract test-integration lint lint-fix format typecheck build \
        hatchet-token replay-webhook recon-report observability observability-down load-test

dev: ## Boot the full local stack (postgres, redis, hatchet, api, worker)
	@if [ ! -f .env ]; then cp .env.example .env; echo "Created .env from .env.example — fill in Stripe test keys and HATCHET_CLIENT_TOKEN (see docs/runbooks/hatchet-setup.md)"; fi
	docker compose up --build

down: ## Stop and remove the local stack
	docker compose down

logs: ## Tail logs for all services
	docker compose logs -f

migrate-create: ## Scaffold a new migration: make migrate-create name=add_x
	npm run migrate -- $(name)

migrate-up: ## Apply all pending migrations
	npm run migrate:up

migrate-down: ## Roll back the most recent migration
	npm run migrate:down

seed: ## Run the seed script (2 merchant entities, 3 products, psp accounts, decline map)
	npm run seed

test: test-unit ## Alias for the fast unit suite (CI runs both unit + integration separately)

test-unit: ## Run unit tests (no external services required)
	npm run test:unit

test-contract: ## Run PSP contract tests against golden fixtures (no external services required)
	npm run test:contract

test-integration: ## Run integration tests against docker-compose services
	npm run test:integration

replay-webhook: ## Re-process a webhook_inbox row: make replay-webhook id=<uuid>
	npx tsx scripts/replay-webhook.ts $(id)

recon-report: ## Print every open recon_exceptions row, grouped by psp_account/type
	npx tsx scripts/recon-report.ts

lint: ## Lint + typecheck
	npm run lint
	npm run typecheck

lint-fix: ## Lint with autofix
	npm run lint:fix

format: ## Prettier write
	npm run format

build: ## Compile TypeScript
	npm run build

hatchet-token: ## Reminder for the one-time Hatchet token setup (see docs/runbooks/hatchet-setup.md)
	@echo "Open http://localhost:8888 (admin@example.com / Admin123!!), create an API token under Settings, and set HATCHET_CLIENT_TOKEN in .env. Full steps: docs/runbooks/hatchet-setup.md"

observability: ## Boot Prometheus + Grafana alongside the core dev stack (T7.2/ADR-0009)
	docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d prometheus grafana
	@echo "Grafana: http://localhost:3001 (admin/admin). Prometheus: http://localhost:9090."

observability-down: ## Stop the observability overlay
	docker compose -f docker-compose.yml -f docker-compose.observability.yml stop prometheus grafana

load-test: ## T7.5: run the k6 load test (requires the k6 binary + a live stack + API_TOKEN=po_xxx)
	k6 run -e BASE_URL=$${BASE_URL:-http://localhost:3000} -e API_TOKEN=$(API_TOKEN) scripts/load-test.k6.js

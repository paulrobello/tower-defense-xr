.PHONY: install prepare-assets build iwer-build test lint fmt typecheck checkall checkall-ci pre-commit dev dev-start dev-stop dev-restart preview xr-emu quest-perf model-check

install:
	bun install --frozen-lockfile

prepare-assets:
	bun run prepare-assets

build:
	bun run build

iwer-build:
	bun run iwer-build

test:
	bun run test

lint:
	bun run lint

fmt:
	bun run fmt

typecheck:
	bun run typecheck

checkall: lint typecheck test build

checkall-ci: checkall
	gitleaks dir . --redact --no-banner

pre-commit:
	pre-commit run --all-files

dev:
	bun run dev

dev-start: dev

dev-stop:
	bun run dev-stop

dev-restart:
	bun run dev-restart

preview:
	bun run preview

xr-emu: iwer-build
	bun scripts/xr-emu/walk.mjs

quest-perf:
	bun scripts/perf-quest.ts

model-check:
	PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p test_model_check.py
	PYTHONDONTWRITEBYTECODE=1 python3 scripts/validate_glbs.py $(MODEL_CHECK_ARGS)

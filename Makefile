# Build wrapper + deployment targets (DL11 D2, tech-plan §2/§3).
#
# `make build` reads and validates the root VERSION file ONCE, then feeds it to
# BOTH images as APP_VERSION via Compose build args. A Dockerfile ARG cannot read a
# build-context file, so the value must be fed in here. If VERSION is missing or
# empty the build FAILS LOUDLY — there is deliberately no silent `v0.0.0-dev`.
#
# Deployment is a private base topology (web + backend + redis, no host ports) plus
# exactly ONE ingress overlay:
#   make up            → base + direct overlay (publishes web only; needs PUBLIC_ORIGIN, no tunnel)
#   make up-cloudflare → base + cloudflare overlay (adds cloudflared; needs HTTPS PUBLIC_ORIGIN + token secret)
#
# `build` needs ONLY the version — runtime values (docker/.env, PUBLIC_ORIGIN, the
# tunnel secret) are required to START the stack, never to build it.

SHELL := /usr/bin/env bash

BASE := docker/compose.yml
DIRECT := docker/compose.direct.yml
CLOUDFLARE := docker/compose.cloudflare.yml
MEMORY := docker/compose.memory.yml
ENV_FILE := docker/.env
DIAGNOSTIC_REPORT_DIR := docker/diagnostic-reports
TUNNEL_SECRET_FILE := docker/secrets/cloudflare-tunnel-token
ORIGIN_VALIDATOR := docker/validate_origin.py

# For build (no overlay, no --env-file, so a clean checkout with no docker/.env works).
COMPOSE := docker compose -f $(BASE)
# Direct overlay: `make up` and its matching down/logs.
COMPOSE_DIRECT := docker compose -f $(BASE) -f $(DIRECT)
COMPOSE_DIRECT_ENV := docker compose --env-file $(ENV_FILE) -f $(BASE) -f $(DIRECT)
# Cloudflare overlay: `make up-cloudflare` and its matching down/logs.
COMPOSE_CLOUDFLARE := docker compose -f $(BASE) -f $(CLOUDFLARE)
COMPOSE_CLOUDFLARE_ENV := docker compose --env-file $(ENV_FILE) -f $(BASE) -f $(CLOUDFLARE)
# Opt-in diagnostic profile (base only; no ingress overlay). The memory variant
# layers the memory-store overlay so the diagnostic can exercise a memory backend.
#
# docker/.env is an OPTIONAL override source for the documented DIAGNOSTIC_* controls:
# loaded via --env-file WHEN present, silently skipped (compose defaults apply) when
# absent. This deliberate missing-file policy keeps ordinary diagnostic runs working
# on a clean checkout with no docker/.env — unlike `make up`, the diagnostic does NOT
# require the file (no check-env preflight). Shell-exported vars still win over it.
DIAGNOSTIC_ENV_FLAG := $(if $(wildcard $(ENV_FILE)),--env-file $(ENV_FILE),)
COMPOSE_DIAGNOSTIC := docker compose $(DIAGNOSTIC_ENV_FLAG) -f $(BASE) --profile diagnostic
COMPOSE_DIAGNOSTIC_MEMORY := docker compose $(DIAGNOSTIC_ENV_FLAG) -f $(BASE) -f $(MEMORY) --profile diagnostic

VERSION_FILE := VERSION
# Strip surrounding whitespace/newline; empty string if the file is missing.
APP_VERSION := $(strip $(shell cat $(VERSION_FILE) 2>/dev/null))

.PHONY: build up up-cloudflare down down-cloudflare logs logs-cloudflare \
	verify-deploy version check-version check-env check-public-origin \
	check-public-origin-https check-tunnel-secret \
	diagnostic diagnostic-memory diagnostic-report diagnostic-version-check

check-version:
	@if [ -z "$(APP_VERSION)" ]; then \
		echo "ERROR: $(VERSION_FILE) is missing or empty — refusing to build without a version stamp." >&2; \
		exit 1; \
	fi

check-env:
	@if [ ! -f "$(ENV_FILE)" ]; then \
		echo "ERROR: $(ENV_FILE) not found — copy docker/.env.example to $(ENV_FILE) and fill it in." >&2; \
		exit 1; \
	fi

# Direct mode: PUBLIC_ORIGIN must be an exact absolute http/https origin.
check-public-origin: check-env
	@set -a; . "./$(ENV_FILE)"; set +a; \
	python3 $(ORIGIN_VALIDATOR) direct

# Cloudflare mode: same exact-origin validation, but https is required.
check-public-origin-https: check-env
	@set -a; . "./$(ENV_FILE)"; set +a; \
	python3 $(ORIGIN_VALIDATOR) cloudflare

check-tunnel-secret:
	@if [ ! -s "$(TUNNEL_SECRET_FILE)" ]; then \
		echo "ERROR: $(TUNNEL_SECRET_FILE) missing or empty — write the named-tunnel token there (see docker/README.md)." >&2; \
		exit 1; \
	fi

version: check-version
	@echo "APP_VERSION=$(APP_VERSION)"

# Build only the images we own; cloudflared/redis are pulled images with no build.
build: check-version
	@echo "Building with APP_VERSION=$(APP_VERSION)"
	APP_VERSION="$(APP_VERSION)" $(COMPOSE) build backend web

up: check-version check-public-origin
	APP_VERSION="$(APP_VERSION)" $(COMPOSE_DIRECT_ENV) up -d

up-cloudflare: check-version check-public-origin-https check-tunnel-secret
	APP_VERSION="$(APP_VERSION)" $(COMPOSE_CLOUDFLARE_ENV) up -d

# down / logs still parse the compose files (which interpolate the APP_VERSION
# build arg), so the value must be present even though nothing is built here. Each
# pair uses the SAME file set as its `up` target.
down:
	APP_VERSION="$(APP_VERSION)" $(COMPOSE_DIRECT) down

down-cloudflare:
	APP_VERSION="$(APP_VERSION)" $(COMPOSE_CLOUDFLARE) down

logs:
	APP_VERSION="$(APP_VERSION)" $(COMPOSE_DIRECT) logs -f

logs-cloudflare:
	APP_VERSION="$(APP_VERSION)" $(COMPOSE_CLOUDFLARE) logs -f

# Reproducible non-streaming deploy gates (tech-plan §3/§6/§7). See docker/verify-deploy.sh.
verify-deploy: check-version
	APP_VERSION="$(APP_VERSION)" bash docker/verify-deploy.sh

# Opt-in ONE-SHOT public diagnostic against a REDIS-backed backend. `run --build`
# rebuilds the diagnostic image first (BuildKit caches unchanged layers, so this is
# cheap) so the current Dockerfile AND the APP_VERSION stamp always take effect — a
# plain `run` would silently reuse a stale image. It then starts the backend (+ redis)
# it depends on, runs the bounded diagnostic, and removes its container. Override the
# target/limits via docker/.env or inline DIAGNOSTIC_* vars; point DIAGNOSTIC_TARGET_URL
# at a public URL (add EXTRA_ARGS=--no-deps) to diagnose a real deployment. Tear the
# started stack down with `make down`.
diagnostic: check-version
	APP_VERSION="$(APP_VERSION)" $(COMPOSE_DIAGNOSTIC) run --build --rm $(EXTRA_ARGS) diagnostic

# Same one-shot diagnostic against a MEMORY-backed backend (memory-store overlay).
diagnostic-memory: check-version
	APP_VERSION="$(APP_VERSION)" $(COMPOSE_DIAGNOSTIC_MEMORY) run --build --rm $(EXTRA_ARGS) diagnostic

# Extract the timestamped JSON reports from the `diagnostic-reports` named volume to
# the host. Runs as the host user only to write the bind-mounted destination; it does
# not start the backend (`--no-deps`).
diagnostic-report: check-version
	@mkdir -p $(DIAGNOSTIC_REPORT_DIR)
	APP_VERSION="$(APP_VERSION)" $(COMPOSE_DIAGNOSTIC) run --rm --no-deps \
		--user "$$(id -u):$$(id -g)" \
		--volume "$$(pwd)/$(DIAGNOSTIC_REPORT_DIR):/export" \
		--entrypoint sh diagnostic -c 'cp -R /reports/. /export/'

# Sensitive version-stamp gate: builds the diagnostic image and proves its
# `get_app_version()` returns the root VERSION (not `v0.0.0-unknown`), and that the
# unstamped fallback would still be `v0.0.0-unknown`. See docker/test_diagnostic_version.sh.
diagnostic-version-check: check-version
	APP_VERSION="$(APP_VERSION)" bash docker/test_diagnostic_version.sh

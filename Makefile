# Build wrapper — the single, reproducible version-stamping step (DL11 D2, tech-plan §2).
#
# Reads and validates the root VERSION file ONCE, then feeds it to BOTH images as
# APP_VERSION via Compose build args. A Dockerfile ARG cannot read a build-context
# file, so the value must be fed in here. If VERSION is missing or empty the build
# FAILS LOUDLY — there is deliberately no silent `v0.0.0-dev` fallback.
#
# `build` needs ONLY the version — runtime tunnel config (docker/.env, PUBLIC_ORIGIN,
# CLOUDFLARE_TUNNEL_TOKEN) is required to start the stack (`up`), never to build it.

SHELL := /usr/bin/env bash

COMPOSE_FILE := docker/compose.yml
ENV_FILE := docker/.env
# For build/down/logs: no --env-file, so a clean checkout with no docker/.env works.
COMPOSE := docker compose -f $(COMPOSE_FILE)
# For up: load runtime values from docker/.env.
COMPOSE_ENV := docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE)

VERSION_FILE := VERSION
# Strip surrounding whitespace/newline; empty string if the file is missing.
APP_VERSION := $(strip $(shell cat $(VERSION_FILE) 2>/dev/null))

.PHONY: build up down logs verify-deploy version check-version check-env check-runtime

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

# Runtime-only values needed to START the stack (validated at `up`, not `build`).
check-runtime: check-env
	@set -a; . "./$(ENV_FILE)"; set +a; \
	if [ -z "$$PUBLIC_ORIGIN" ]; then \
		echo "ERROR: PUBLIC_ORIGIN is empty in $(ENV_FILE) — see docker/.env.example." >&2; exit 1; fi; \
	if [ -z "$$CLOUDFLARE_TUNNEL_TOKEN" ]; then \
		echo "ERROR: CLOUDFLARE_TUNNEL_TOKEN is empty in $(ENV_FILE) — see docker/.env.example." >&2; exit 1; fi

version: check-version
	@echo "APP_VERSION=$(APP_VERSION)"

# Build only the images we own; cloudflared is a pulled image with no build.
build: check-version
	@echo "Building with APP_VERSION=$(APP_VERSION)"
	APP_VERSION="$(APP_VERSION)" $(COMPOSE) build backend web

up: check-version check-runtime
	APP_VERSION="$(APP_VERSION)" $(COMPOSE_ENV) up -d

# down / logs still parse the compose file (which interpolates the APP_VERSION
# build arg), so the value must be present even though nothing is built here.
down:
	APP_VERSION="$(APP_VERSION)" $(COMPOSE) down

logs:
	APP_VERSION="$(APP_VERSION)" $(COMPOSE) logs -f

# Reproducible non-streaming deploy gates (tech-plan §6 item 8). See docker/verify-deploy.sh.
verify-deploy: check-version
	APP_VERSION="$(APP_VERSION)" bash docker/verify-deploy.sh

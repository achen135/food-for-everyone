# ml subsystem tasks. Run from `ml/`, or `make -C ml <target>` from the repo root.
#
# The DoD for M11 is that `make data` populates `events` deterministically from
# a clean checkout, so `data` brings its own database up and installs its own
# dependencies rather than assuming a prepared environment.

SHELL := /bin/bash
.DEFAULT_GOAL := help

PY      ?= python3
VENV    := .venv
BIN     := $(VENV)/bin
SEED    ?= 20250718
MONTHS  ?= 6
OUT     ?= out

# Docker Desktop on macOS does not always put the CLI on PATH.
DOCKER  ?= $(shell command -v docker 2>/dev/null || echo /Applications/Docker.app/Contents/Resources/bin/docker)
COMPOSE := $(DOCKER) compose -f ../docker-compose.yml

export ML_DATABASE_URL ?= postgresql://ffe_ml:ffe_ml@localhost:55432/ffe_ml

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# -- environment ------------------------------------------------------------

$(BIN)/python:
	$(PY) -m venv $(VENV)
	$(BIN)/python -m pip install --quiet --upgrade pip

.PHONY: install
install: $(BIN)/python ## Create the venv and install the package (editable, with dev extras)
	@$(BIN)/python -m pip install --quiet -e ".[dev]"

# -- database ---------------------------------------------------------------

.PHONY: db-up
db-up: ## Start the corpus Postgres and wait for it to accept queries
	@$(COMPOSE) up -d postgres
	@printf 'waiting for postgres'
	@for i in $$(seq 1 60); do \
	  if $(COMPOSE) exec -T postgres pg_isready -U ffe_ml -d ffe_ml >/dev/null 2>&1; then \
	    echo " ready"; exit 0; fi; \
	  printf '.'; sleep 1; \
	done; echo; echo "postgres did not become ready" >&2; exit 1

.PHONY: db-down
db-down: ## Stop the corpus Postgres (keeps the volume)
	@$(COMPOSE) stop postgres

.PHONY: db-reset
db-reset: db-up ## Drop and recreate the ml schema. Needed after editing ml/sql/.
	@$(COMPOSE) exec -T postgres psql -U ffe_ml -d ffe_ml -q \
	  -c 'drop schema public cascade; create schema public;'
	@$(BIN)/python -m ml.db_reset

.PHONY: psql
psql: ## Open a psql shell on the corpus database
	@$(COMPOSE) exec postgres psql -U ffe_ml -d ffe_ml

# -- the corpus -------------------------------------------------------------

.PHONY: data
data: install db-up ## Generate the events corpus into Postgres (SEED=, MONTHS=)
	@$(BIN)/python -m ml.simulate --seed $(SEED) --months $(MONTHS) --out postgres

.PHONY: jsonl
jsonl: install ## Write the reference JSONL stream to $(OUT)/events.jsonl
	@mkdir -p $(OUT)
	@$(BIN)/python -m ml.simulate --seed $(SEED) --months $(MONTHS) \
	  --out jsonl --path $(OUT)/events.jsonl

.PHONY: features
features: install db-up ## Compute point-in-time features + labels into features_waste
	@$(BIN)/python -m ml.features

.PHONY: eval-baselines
eval-baselines: install db-up ## Measure the rules baselines, rewrite baselines.json
	@$(BIN)/python -m ml.baselines

.PHONY: model
model: install db-up ## Train Model A, calibrate it, rewrite ml/model/
	@$(BIN)/python -m ml.model

.PHONY: reproduce
reproduce: data features eval-baselines model ## The full chain a clean checkout runs

.PHONY: hash
hash: install ## Print the stream hash — the determinism check, by hand
	@$(BIN)/python -m ml.simulate --seed $(SEED) --months $(MONTHS) \
	  --out jsonl --path - 2>/dev/null | shasum -a 256

# -- checks -----------------------------------------------------------------

.PHONY: lint
lint: install ## ruff
	@$(BIN)/ruff check src tests
	@$(BIN)/ruff format --check src tests

.PHONY: fmt
fmt: install ## ruff format (writes)
	@$(BIN)/ruff format src tests
	@$(BIN)/ruff check --fix src tests

.PHONY: typecheck
typecheck: install ## mypy
	@$(BIN)/mypy

.PHONY: test
test: install ## pytest (fast tests only)
	@$(BIN)/pytest

.PHONY: test-pg
test-pg: install db-up ## pytest including the Postgres integration tests
	@ML_TEST_POSTGRES=1 $(BIN)/pytest

.PHONY: test-slow
test-slow: install ## pytest including the full-scale volume run
	@ML_RUN_SLOW=1 $(BIN)/pytest

.PHONY: check
check: lint typecheck test ## Everything CI runs (bar the Postgres and slow tests)

.PHONY: clean
clean: ## Remove build and cache artefacts (not the venv, not the database)
	@rm -rf $(OUT) .pytest_cache .mypy_cache .ruff_cache src/*.egg-info
	@find . -name __pycache__ -type d -prune -exec rm -rf {} +

"""The backend scheduling-semantics profile advertised to clients (T08).

# This file is part of Nurse Scheduling Project, see <https://github.com/j3soon/nurse-scheduling>.
#
# Copyright (C) 2023-2026 Johnson Sun
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

These versions describe SCHEDULING SEMANTICS, not the build. `app_version` moves
with every commit; these move only when the meaning of a solved model changes,
which is what makes them safe to compare two runs' evidence across.

Bump `SOLVER_SEMANTIC_VERSION` when a constraint, objective, or solver setting
changes what "feasible" means for identical bytes. Bump
`BACKEND_CAPABILITY_VERSION` when the set of capabilities a job may rely on
changes. Either bump invalidates every retained basis for evidence comparison:
the browser's recorded profile no longer matches, so a stored result becomes a
semantic mismatch and requires a fresh Optimize run rather than being silently
reinterpreted under the new semantics.
"""

SUBMISSION_CONTRACT_VERSION = "optimize-yaml-v1"
"""Version of the submission wire contract (exact strict YAML bytes + form fields)."""

SOLVER_SEMANTIC_VERSION = "ortools/cp-sat@2"
"""Version of the solver's scheduling semantics. Bump on any meaning-changing model change."""

BACKEND_CAPABILITY_VERSION = "nurse-scheduling-backend@1"
"""Version of the backend capability set a job may rely on."""


def semantic_profile() -> dict[str, str]:
    """Return the public semantic profile advertised by `/info` and bound into a basis."""
    return {
        "submission_contract_version": SUBMISSION_CONTRACT_VERSION,
        "solver_semantic_version": SOLVER_SEMANTIC_VERSION,
        "backend_capability_version": BACKEND_CAPABILITY_VERSION,
    }

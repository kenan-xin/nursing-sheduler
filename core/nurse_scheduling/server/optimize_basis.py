"""Canonical `OptimizeBasisV2` encoding and submission identity (T08).

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

This is the Python half of ONE schema-specific canonical encoder. The TypeScript
half lives in `web/lib/optimize/basis/optimize-basis.ts`, and both are pinned to
the shared golden vectors in `contracts/optimize-basis-v2.golden.json`.

Deliberately NOT a generic object serializer:

  * the field order is a fixed literal list, not `dict` iteration order;
  * every value carries an explicit type tag (`s:` / `b:` / `i:` / `z:`), so a
    string `"true"` can never encode like the boolean `true` and a string `"2"`
    can never encode like the integer `2`;
  * integers are canonical decimal (no `+`, no leading zero, no float form);
  * strings escape `\\`, LF, CR, and TAB, so no value can inject a field line.

A generic encoder would let an added/renamed/reordered field silently change the
identity of retained evidence. The browser's non-cryptographic `canonicalHash`
is explicitly excluded: it is a dirty-state fingerprint, not a submission identity.
"""

import hashlib
import re
from dataclasses import dataclass


ENCODING_VERSION = "optimize-basis/v2"
"""Header line of the canonical encoding; bumping it changes every `basis_id`."""

BASIS_SCHEMA_VERSION = 2
"""The only `schema_version` this encoder accepts."""

_SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")
"""Lowercase-hex SHA-256; an uppercase or truncated digest is rejected, not normalized."""

ANONYMIZATION_MODES = frozenset({"none", "people"})
"""Submission anonymization policies whose bytes differ, so the basis must bind them."""


class OptimizeBasisError(ValueError):
    """An `OptimizeBasisV2` field is missing, mistyped, or out of domain."""


@dataclass(frozen=True)
class NormalizedOptions:
    """The solver options that change scheduling semantics for identical bytes."""

    solver: str
    """Canonical solver selector."""
    prettify: bool
    """Resolved schedule-prettification preference (never `None` in a basis)."""
    timeout_seconds: int
    """Resolved optimization timeout in seconds."""


@dataclass(frozen=True)
class OptimizeBasisV2:
    """The immutable identity of one Optimize submission.

    It binds the exact submitted bytes AND the semantics under which they were
    solved, so evidence cannot be compared across a serializer, anonymization,
    option, solver, or backend-capability change.
    """

    submission_contract_version: str
    """Version of the submission wire contract (currently `optimize-yaml-v1`)."""
    workspace_schema_version: str
    """Workspace document schema version the browser projected from."""
    serializer_version: str
    """Version of the exact-YAML serializer that produced the submitted bytes."""
    anonymization_mode: str
    """Which anonymization transform produced the bytes (`none` or `people`)."""
    input_sha256: str
    """SHA-256 of the exact submitted UTF-8 YAML bytes, lowercase hex."""
    normalized_options: NormalizedOptions
    """Resolved solver options, never the raw request defaults."""
    solver_semantic_version: str
    """Version of the solver's scheduling semantics."""
    backend_capability_version: str
    """Version of the backend capability set that executed the job."""
    schema_version: int = BASIS_SCHEMA_VERSION
    """Basis schema version; only `2` is encodable."""


def _encode_string(field: str, value: object) -> str:
    """Encode a required non-empty string field.

    Raises:
        OptimizeBasisError: If the value is not a non-empty string.
    """
    if value is None:
        raise OptimizeBasisError(f"{field} must not be null")
    if not isinstance(value, str) or value == "":
        raise OptimizeBasisError(f"{field} must be a non-empty string")
    escaped = value.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return f"s:{escaped}"


def _encode_bool(field: str, value: object) -> str:
    """Encode a required boolean field.

    Raises:
        OptimizeBasisError: If the value is not exactly a `bool`.
    """
    if value is None:
        raise OptimizeBasisError(f"{field} must not be null")
    if not isinstance(value, bool):
        raise OptimizeBasisError(f"{field} must be a boolean")
    return "b:true" if value else "b:false"


def _encode_int(field: str, value: object) -> str:
    """Encode a required integer field in canonical decimal form.

    Raises:
        OptimizeBasisError: If the value is not an integer (`bool` excluded).
    """
    if value is None:
        raise OptimizeBasisError(f"{field} must not be null")
    # `bool` subclasses `int`; encoding `True` as `i:1` would alias a real integer.
    if isinstance(value, bool) or not isinstance(value, int):
        raise OptimizeBasisError(f"{field} must be an integer")
    return f"i:{value:d}"


def encode_optimize_basis_v2(basis: OptimizeBasisV2) -> bytes:
    """Return the canonical UTF-8 encoding of a basis.

    Raises:
        OptimizeBasisError: If any field is missing, mistyped, or out of domain.
    """
    if basis.schema_version != BASIS_SCHEMA_VERSION:
        raise OptimizeBasisError(f"schemaVersion must be {BASIS_SCHEMA_VERSION}")
    if not isinstance(basis.input_sha256, str) or not _SHA256_HEX.match(basis.input_sha256):
        raise OptimizeBasisError("inputSha256 must be 64 lowercase hex characters")
    if basis.anonymization_mode not in ANONYMIZATION_MODES:
        raise OptimizeBasisError(f"anonymizationMode must be one of {sorted(ANONYMIZATION_MODES)}")
    options = basis.normalized_options
    if not isinstance(options, NormalizedOptions):
        raise OptimizeBasisError("normalizedOptions must be supplied")
    if isinstance(options.timeout_seconds, bool) or not isinstance(options.timeout_seconds, int):
        raise OptimizeBasisError("normalizedOptions.timeoutSeconds must be an integer")
    if options.timeout_seconds <= 0:
        raise OptimizeBasisError("normalizedOptions.timeoutSeconds must be positive")

    # The field order is this literal list. Never derive it from the dataclass.
    lines = [
        ENCODING_VERSION,
        f"schemaVersion={_encode_int('schemaVersion', basis.schema_version)}",
        f"submissionContractVersion={_encode_string('submissionContractVersion', basis.submission_contract_version)}",
        f"workspaceSchemaVersion={_encode_string('workspaceSchemaVersion', basis.workspace_schema_version)}",
        f"serializerVersion={_encode_string('serializerVersion', basis.serializer_version)}",
        f"anonymizationMode={_encode_string('anonymizationMode', basis.anonymization_mode)}",
        f"inputSha256={_encode_string('inputSha256', basis.input_sha256)}",
        f"normalizedOptions.solver={_encode_string('normalizedOptions.solver', options.solver)}",
        f"normalizedOptions.prettify={_encode_bool('normalizedOptions.prettify', options.prettify)}",
        f"normalizedOptions.timeoutSeconds={_encode_int('normalizedOptions.timeoutSeconds', options.timeout_seconds)}",
        f"solverSemanticVersion={_encode_string('solverSemanticVersion', basis.solver_semantic_version)}",
        f"backendCapabilityVersion={_encode_string('backendCapabilityVersion', basis.backend_capability_version)}",
    ]
    return ("\n".join(lines) + "\n").encode("utf-8")


def sha256_hex(data: bytes) -> str:
    """Return the lowercase-hex SHA-256 of exact bytes."""
    return hashlib.sha256(data).hexdigest()


def compute_basis_id(basis: OptimizeBasisV2) -> str:
    """Return the SHA-256 of the canonical encoding of a basis.

    Raises:
        OptimizeBasisError: If any field is missing, mistyped, or out of domain.
    """
    return sha256_hex(encode_optimize_basis_v2(basis))

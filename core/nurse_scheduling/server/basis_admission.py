"""Pre-job verification of a claimed `OptimizeBasisV2` submission identity (T08).

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

The browser reads the semantic profile from `/info`, computes its own digests, and
sends both with the submission. This module NEVER trusts those values: it
recomputes the input digest over the bytes it actually received and rebuilds the
basis from the server's OWN live profile and RESOLVED options, then compares. A
claim that disagrees is rejected before job creation, so no job, no capacity
consumption, and no retained evidence ever exists under semantics the two sides
disagreed about.

A submission that claims nothing is accepted unchanged: ordinary Optimize, and the
whole app, must stay fully usable without the assistant.
"""

from dataclasses import dataclass

from .optimize_basis import (
    ANONYMIZATION_MODES,
    NormalizedOptions,
    OptimizeBasisV2,
    compute_basis_id,
    sha256_hex,
)
from .scheduling_errors import (
    CODE_BASIS_CLAIM_INCOMPLETE,
    CODE_BASIS_ID_MISMATCH,
    CODE_BASIS_INPUT_DIGEST_MISMATCH,
    CODE_SEMANTIC_PROFILE_MISMATCH,
    ISSUE_INVALID_VALUE,
    ISSUE_MISSING_FIELD,
    ISSUE_UNSUPPORTED_VALUE,
    SchedulingContentError,
    SchedulingIssue,
)
from .semantic_profile import (
    BACKEND_CAPABILITY_VERSION,
    SOLVER_SEMANTIC_VERSION,
    SUBMISSION_CONTRACT_VERSION,
)


@dataclass(frozen=True)
class BasisClaim:
    """The exact basis fields a client may send alongside a submission.

    Every field is optional at the transport layer so an absent claim is a valid
    ordinary submission; a PARTIAL claim is a client bug and is rejected rather
    than completed with server guesses.
    """

    basis_id: str | None = None
    input_sha256: str | None = None
    submission_contract_version: str | None = None
    workspace_schema_version: str | None = None
    serializer_version: str | None = None
    anonymization_mode: str | None = None
    expected_solver_semantic_version: str | None = None
    expected_backend_capability_version: str | None = None
    parent_basis_id: str | None = None
    transform_digest: str | None = None

    @property
    def is_absent(self) -> bool:
        """Return whether the client made no basis claim at all."""
        return all(
            value is None
            for value in (
                self.basis_id,
                self.input_sha256,
                self.submission_contract_version,
                self.workspace_schema_version,
                self.serializer_version,
                self.anonymization_mode,
                self.expected_solver_semantic_version,
                self.expected_backend_capability_version,
                self.parent_basis_id,
                self.transform_digest,
            )
        )


@dataclass(frozen=True)
class VerifiedBasis:
    """A claim the server independently reproduced from the received bytes."""

    basis: OptimizeBasisV2
    basis_id: str
    parent_basis_id: str | None
    transform_digest: str | None


def _reject(code: str, message: str, field: str, issue_code: str) -> SchedulingContentError:
    """Build the normative pre-job 422 for one basis-admission failure."""
    return SchedulingContentError(code, message, [SchedulingIssue([field], issue_code, message)])


_REQUIRED_CLAIM_FIELDS = (
    "basis_id",
    "input_sha256",
    "submission_contract_version",
    "workspace_schema_version",
    "serializer_version",
    "anonymization_mode",
    "expected_solver_semantic_version",
    "expected_backend_capability_version",
)
"""Fields that must ALL be present once any basis field is supplied."""


def verify_basis_claim(
    claim: BasisClaim,
    *,
    received_bytes: bytes,
    resolved_solver: str,
    resolved_prettify: bool | None,
    resolved_timeout_seconds: int,
) -> VerifiedBasis | None:
    """Independently reproduce and verify a claimed submission basis.

    Returns `None` when no claim was made. The options bound into the basis are
    the server's RESOLVED values, so a client that guessed a default it did not
    send fails the `basis_id` comparison instead of silently recording evidence
    under options the solver never used.

    Raises:
        SchedulingContentError: If the claim is partial, the recomputed input
            digest disagrees, the advertised semantic profile has moved, or the
            recomputed `basis_id` disagrees.
    """
    if claim.is_absent:
        return None

    missing = [field for field in _REQUIRED_CLAIM_FIELDS if getattr(claim, field) is None]
    if missing:
        raise _reject(
            CODE_BASIS_CLAIM_INCOMPLETE,
            f"An Optimize basis claim must supply every field; missing: {', '.join(sorted(missing))}.",
            missing[0],
            ISSUE_MISSING_FIELD,
        )
    if claim.anonymization_mode not in ANONYMIZATION_MODES:
        raise _reject(
            CODE_BASIS_CLAIM_INCOMPLETE,
            f"Unsupported anonymization mode: {claim.anonymization_mode}.",
            "anonymization_mode",
            ISSUE_UNSUPPORTED_VALUE,
        )

    # 1. The digest is recomputed over the bytes THIS request carried, never taken
    #    from the claim. A transport corruption or a substituted document is
    #    caught here rather than becoming evidence bound to the wrong bytes.
    actual_digest = sha256_hex(received_bytes)
    if claim.input_sha256 != actual_digest:
        raise _reject(
            CODE_BASIS_INPUT_DIGEST_MISMATCH,
            "The submitted bytes do not match the claimed input digest.",
            "input_sha256",
            ISSUE_INVALID_VALUE,
        )

    # 2. The client tells us which semantics it believes it is submitting under.
    #    A backend that has since moved rejects rather than silently solving under
    #    different semantics and returning evidence the client would misattribute.
    profile_mismatches = [
        field
        for field, claimed, live in (
            ("submission_contract_version", claim.submission_contract_version, SUBMISSION_CONTRACT_VERSION),
            ("expected_solver_semantic_version", claim.expected_solver_semantic_version, SOLVER_SEMANTIC_VERSION),
            (
                "expected_backend_capability_version",
                claim.expected_backend_capability_version,
                BACKEND_CAPABILITY_VERSION,
            ),
        )
        if claimed != live
    ]
    if profile_mismatches:
        raise _reject(
            CODE_SEMANTIC_PROFILE_MISMATCH,
            "The backend scheduling-semantics profile has changed since this submission was prepared.",
            profile_mismatches[0],
            ISSUE_UNSUPPORTED_VALUE,
        )

    # 3. Rebuild the whole basis from server-side truth and compare the identity.
    #    Any field the client encoded differently — including one this server does
    #    not otherwise inspect — changes the id and is caught here.
    basis = OptimizeBasisV2(
        submission_contract_version=SUBMISSION_CONTRACT_VERSION,
        workspace_schema_version=str(claim.workspace_schema_version),
        serializer_version=str(claim.serializer_version),
        anonymization_mode=str(claim.anonymization_mode),
        input_sha256=actual_digest,
        normalized_options=NormalizedOptions(
            solver=resolved_solver,
            prettify=bool(resolved_prettify),
            timeout_seconds=resolved_timeout_seconds,
        ),
        solver_semantic_version=SOLVER_SEMANTIC_VERSION,
        backend_capability_version=BACKEND_CAPABILITY_VERSION,
    )
    recomputed = compute_basis_id(basis)
    if claim.basis_id != recomputed:
        raise _reject(
            CODE_BASIS_ID_MISMATCH,
            "The claimed Optimize basis identity does not match the submission the server received.",
            "basis_id",
            ISSUE_INVALID_VALUE,
        )

    return VerifiedBasis(
        basis=basis,
        basis_id=recomputed,
        parent_basis_id=claim.parent_basis_id,
        transform_digest=claim.transform_digest,
    )

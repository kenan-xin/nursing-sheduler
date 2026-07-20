"""Explicit slow gate: prove the supervised CP-SAT process on the large ward.

This probe drives the real ``OptimizationRunner`` through the process supervisor
(``run_optimization_process``) against the large real scenario and classifies
each supervised termination behavior. It is CP-SAT only: the rebuild exposes a
single solver, so there is no solver matrix, registry, or selector widening
here.

Each capability round runs inside an isolated, hard-watchdog subprocess so a
wedged native solver can always be reaped. Every round has a deterministic time
budget, cleans its process tree in ``finally`` through the executor, and reports
machine-readable evidence (terminal classification, score, artifact, timing,
intermediate progress, and post-termination process residue).

This tool lives outside the pytest test tree (``core/scripts``) and pytest is
scoped to ``core/tests`` (see pyproject ``testpaths``), so ordinary test
discovery cannot collect or execute it. Run it explicitly (see
``core/scripts/README.md``):

    cd core
    PYTHONPATH=. python3 scripts/solver_capability_probe.py --json-output report.json
"""

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

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import threading
import time
import traceback
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CORE_ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(CORE_ROOT))

from nurse_scheduling.server.jobs.models import (  # noqa: E402
    Job,
    JobRequest,
    JobState,
)
from nurse_scheduling.server.jobs.process_executor import (  # noqa: E402
    ProcessControl,
    ProcessStatus,
    run_optimization_process,
)
from nurse_scheduling.server.jobs.runner import OptimizationRunner  # noqa: E402
from nurse_scheduling.server.scheduling_input import (  # noqa: E402
    SUPPORTED_SOLVER,
    canonicalize_submission,
)


REAL_TESTCASE = CORE_ROOT / "tests" / "testcases" / "real" / "large-ward-with-87-people-2025-11.yaml"
RESULT_MARKER = "SOLVER_CAPABILITY_RESULT="
ROUND_ORDER = ("timeout", "hard-watchdog", "cancel", "finish-now", "intermediate-scores")
"""Fixed capability round order exercised for the one supported solver."""

# Deterministic per-round budgets. Native model build of the large scenario is a
# couple of seconds and CP-SAT honors its native timeout, so these keep every
# round bounded while still letting a real feasible incumbent appear.
DEFAULT_TIMEOUT_SECONDS = 8
DEFAULT_TIMEOUT_GRACE_SECONDS = 25.0
DEFAULT_WATCHDOG_NATIVE_SECONDS = 600
DEFAULT_WATCHDOG_HARD_SECONDS = 8.0
DEFAULT_CONTROL_TIMEOUT_SECONDS = 90
DEFAULT_CONTROL_FALLBACK_SECONDS = 45.0
DEFAULT_CONTROL_GRACE_SECONDS = 30.0
DEFAULT_STARTUP_MARGIN_SECONDS = 60.0
MIN_TIMEOUT_EXERCISE_RATIO = 0.8
"""Fraction of the native timeout that must elapse for a timeout to count as exercised."""


@dataclass(frozen=True)
class ProbeConfig:
    """Runtime limits shared by every CP-SAT capability round."""

    testcase: Path = REAL_TESTCASE
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    timeout_grace_seconds: float = DEFAULT_TIMEOUT_GRACE_SECONDS
    watchdog_native_seconds: int = DEFAULT_WATCHDOG_NATIVE_SECONDS
    watchdog_hard_seconds: float = DEFAULT_WATCHDOG_HARD_SECONDS
    control_timeout_seconds: int = DEFAULT_CONTROL_TIMEOUT_SECONDS
    control_fallback_seconds: float = DEFAULT_CONTROL_FALLBACK_SECONDS
    control_grace_seconds: float = DEFAULT_CONTROL_GRACE_SECONDS
    startup_margin_seconds: float = DEFAULT_STARTUP_MARGIN_SECONDS


@dataclass(frozen=True)
class RoundReport:
    """Normalized result of one isolated capability round."""

    name: str
    status: str
    detail: str
    process_status: str | None = None
    termination_reason: str | None = None
    failure_code: str | None = None
    solver_status: str | None = None
    score: int | None = None
    artifact_available: bool | None = None
    artifact_bytes: int | None = None
    progress_events: int | None = None
    first_incumbent_seconds: float | None = None
    elapsed_seconds: float | None = None
    elapsed_from: str | None = None
    residue_checked: bool | None = None
    residue_clean: bool | None = None
    worker_stderr_tail: str | None = None


@dataclass(frozen=True)
class SolverReport:
    """Ordered capability results for the single supported solver."""

    selector: str
    rounds: tuple[RoundReport, ...]


# --------------------------------------------------------------------------- #
# Round observation model and pure classification (unit-tested in isolation).
# --------------------------------------------------------------------------- #


def _round_report(name: str, status: str, detail: str, observation: dict[str, Any] | None = None) -> RoundReport:
    """Build a normalized round report from an optional observation dict."""
    observation = observation or {}
    elapsed = observation.get("elapsed_seconds")
    first_incumbent = observation.get("first_incumbent_seconds")
    return RoundReport(
        name=name,
        status=status,
        detail=detail,
        process_status=observation.get("process_status"),
        termination_reason=observation.get("termination_reason"),
        failure_code=observation.get("failure_code"),
        solver_status=observation.get("solver_status"),
        score=observation.get("score"),
        artifact_available=observation.get("artifact_available"),
        artifact_bytes=observation.get("artifact_bytes"),
        progress_events=observation.get("progress_events"),
        first_incumbent_seconds=round(first_incumbent, 3) if first_incumbent is not None else None,
        elapsed_seconds=round(elapsed, 3) if elapsed is not None else None,
        elapsed_from=observation.get("elapsed_from"),
        residue_checked=observation.get("residue_checked"),
        residue_clean=observation.get("residue_clean"),
    )


def _residue_detail(observation: dict[str, Any]) -> str:
    """Describe the post-termination process-tree residue outcome."""
    if not observation.get("residue_checked"):
        return "Residue audit skipped on this platform."
    if observation.get("residue_clean"):
        return "Supervised process tree left no residual child."
    return "Residual optimization child survived termination."


def evaluate_timeout(observation: dict[str, Any], config: ProbeConfig) -> RoundReport:
    """Classify the native graceful-timeout round for CP-SAT."""
    elapsed = observation.get("elapsed_seconds") or 0.0
    exercised = elapsed >= config.timeout_seconds * MIN_TIMEOUT_EXERCISE_RATIO
    if elapsed > config.timeout_seconds + config.timeout_grace_seconds:
        return _round_report(
            "timeout", "FAIL", "Solver returned after the timeout budget and grace period.", observation
        )
    if observation.get("process_status") == ProcessStatus.FAILED.value:
        if observation.get("failure_code") == "process_timeout":
            return _round_report(
                "timeout",
                "FAIL",
                "Watchdog force-terminated CP-SAT instead of a graceful native timeout.",
                observation,
            )
        if observation.get("failure_code") == "no_solution_found" and exercised:
            return _round_report(
                "timeout",
                "INCONCLUSIVE",
                "Solver stopped on time before any feasible incumbent.",
                observation,
            )
        return _round_report("timeout", "FAIL", "Timeout round ended with an unexpected failure.", observation)
    if observation.get("process_status") != ProcessStatus.COMPLETED.value:
        return _round_report("timeout", "FAIL", "Timeout round did not complete normally.", observation)
    if observation.get("termination_reason") == "solver_timeout" and exercised:
        if not observation.get("artifact_available"):
            return _round_report("timeout", "FAIL", "solver_timeout produced no downloadable schedule.", observation)
        return _round_report(
            "timeout",
            "PASS",
            "CP-SAT returned a feasible schedule at the native timeout (solver_timeout).",
            observation,
        )
    if observation.get("termination_reason") in {"optimality_proven", "infeasibility_proven"}:
        return _round_report(
            "timeout", "INCONCLUSIVE", "Solver finished before the timeout was exercised.", observation
        )
    return _round_report("timeout", "FAIL", "Timeout round did not yield a solver_timeout result.", observation)


def evaluate_hard_watchdog(observation: dict[str, Any], config: ProbeConfig) -> RoundReport:
    """Classify the forced hard-watchdog round: expect process_timeout and clean residue."""
    if observation.get("process_status") != ProcessStatus.FAILED.value:
        return _round_report(
            "hard-watchdog",
            "FAIL",
            "A solver that outran its hard deadline was not force-terminated.",
            observation,
        )
    if observation.get("failure_code") != "process_timeout":
        return _round_report(
            "hard-watchdog", "FAIL", "Watchdog failure was not classified process_timeout.", observation
        )
    elapsed = observation.get("elapsed_seconds") or 0.0
    if elapsed > config.watchdog_hard_seconds + config.startup_margin_seconds:
        return _round_report("hard-watchdog", "FAIL", "Watchdog fired far later than the hard deadline.", observation)
    if observation.get("residue_checked") and not observation.get("residue_clean"):
        return _round_report(
            "hard-watchdog",
            "FAIL",
            "Force-terminated solver left a residual child process.",
            observation,
        )
    return _round_report(
        "hard-watchdog",
        "PASS",
        f"Watchdog terminated the solver as process_timeout. {_residue_detail(observation)}",
        observation,
    )


def evaluate_cancel(observation: dict[str, Any], _config: ProbeConfig) -> RoundReport:
    """Classify forced cancellation: expect a cancelled status with discarded output."""
    if observation.get("process_status") != ProcessStatus.CANCELLED.value:
        return _round_report("cancel", "FAIL", "Cancellation did not settle a cancelled status.", observation)
    if observation.get("artifact_available") or observation.get("score") is not None:
        return _round_report(
            "cancel", "FAIL", "Cancellation retained solver output instead of discarding it.", observation
        )
    if observation.get("residue_checked") and not observation.get("residue_clean"):
        return _round_report("cancel", "FAIL", "Cancelled solver left a residual child process.", observation)
    incumbent = (
        "after a feasible incumbent" if observation.get("first_incumbent_seconds") is not None else "while solving"
    )
    return _round_report(
        "cancel",
        "PASS",
        f"Server cancelled CP-SAT {incumbent} and discarded its output. {_residue_detail(observation)}",
        observation,
    )


def evaluate_finish_now(observation: dict[str, Any], _config: ProbeConfig) -> RoundReport:
    """Classify cooperative finish-now: expect user_requested with a feasible incumbent."""
    if observation.get("process_status") != ProcessStatus.COMPLETED.value:
        if observation.get("failure_code") == "no_solution_found":
            return _round_report(
                "finish-now",
                "INCONCLUSIVE",
                "Finish-now was requested before any feasible incumbent existed.",
                observation,
            )
        return _round_report("finish-now", "FAIL", "Finish-now did not complete with a feasible result.", observation)
    if observation.get("termination_reason") == "solver_timeout":
        return _round_report(
            "finish-now",
            "INCONCLUSIVE",
            "Native timeout returned the schedule before finish-now could stop the search.",
            observation,
        )
    if observation.get("termination_reason") != "user_requested":
        return _round_report("finish-now", "FAIL", "Finish-now result was not classified user_requested.", observation)
    if not observation.get("artifact_available") or observation.get("score") is None:
        return _round_report("finish-now", "FAIL", "user_requested result carried no feasible schedule.", observation)
    return _round_report(
        "finish-now",
        "PASS",
        "CP-SAT cooperatively returned its current feasible incumbent (user_requested).",
        observation,
    )


def evaluate_intermediate_scores(observation: dict[str, Any], _config: ProbeConfig) -> RoundReport:
    """Classify intermediate progress: expect at least one incumbent score before terminal."""
    progress_events = observation.get("progress_events") or 0
    if observation.get("process_status") == ProcessStatus.FAILED.value and progress_events == 0:
        return _round_report(
            "intermediate-scores",
            "INCONCLUSIVE",
            "Solver returned before emitting an incumbent that could carry a score.",
            observation,
        )
    if progress_events == 0 or observation.get("score") is None:
        return _round_report(
            "intermediate-scores",
            "FAIL",
            "Solver produced no intermediate incumbent score before returning.",
            observation,
        )
    return _round_report(
        "intermediate-scores",
        "PASS",
        f"CP-SAT emitted {progress_events} intermediate incumbent score(s) before returning.",
        observation,
    )


_EVALUATORS = {
    "timeout": evaluate_timeout,
    "hard-watchdog": evaluate_hard_watchdog,
    "cancel": evaluate_cancel,
    "finish-now": evaluate_finish_now,
    "intermediate-scores": evaluate_intermediate_scores,
}


# --------------------------------------------------------------------------- #
# Process residue sampling (Linux only; skipped elsewhere).
# --------------------------------------------------------------------------- #


def _proc_state_and_ppid(pid: int) -> tuple[str, int] | None:
    """Return one process's scheduler state and parent PID from /proc, if present."""
    try:
        raw = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None
    try:
        fields = raw[raw.rindex(")") + 2 :].split()
        return fields[0], int(fields[1])
    except (ValueError, IndexError):
        return None


def _optimization_child_pids(parent_pid: int) -> set[int]:
    """Return spawned supervision children of ``parent_pid``, excluding the resource tracker."""
    pids: set[int] = set()
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        pid = int(entry)
        state_ppid = _proc_state_and_ppid(pid)
        if state_ppid is None or state_ppid[1] != parent_pid:
            continue
        try:
            cmdline = Path(f"/proc/{pid}/cmdline").read_bytes()
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        if b"spawn_main" in cmdline and b"resource_tracker" not in cmdline:
            pids.add(pid)
    return pids


def _pid_is_active(pid: int) -> bool:
    """Return whether a PID is still a live, non-zombie process."""
    state_ppid = _proc_state_and_ppid(pid)
    return state_ppid is not None and state_ppid[0] not in {"X", "Z"}


class _ResidueSampler:
    """Poll for the supervised child/guard PIDs so residue can be checked after termination."""

    def __init__(self, poll_seconds: float = 0.05):
        self._parent_pid = os.getpid()
        self._poll_seconds = poll_seconds
        self._seen: set[int] = set()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="residue-sampler", daemon=True)
        self.supported = sys.platform == "linux"

    def _run(self) -> None:
        while not self._stop.is_set():
            self._seen |= _optimization_child_pids(self._parent_pid)
            self._stop.wait(self._poll_seconds)

    def __enter__(self) -> "_ResidueSampler":
        if self.supported:
            self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stop.set()
        if self.supported:
            self._thread.join(timeout=2)

    def residue(self) -> tuple[bool, bool | None]:
        """Return ``(checked, clean)`` for the sampled children after the round ends."""
        if not self.supported:
            return False, None
        # Give the executor's finally-block cleanup a brief moment to be reaped.
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if not any(_pid_is_active(pid) for pid in self._seen):
                return True, True
            time.sleep(0.05)
        return True, not any(_pid_is_active(pid) for pid in self._seen)


# --------------------------------------------------------------------------- #
# Round execution: drive the real runner through the process supervisor.
# --------------------------------------------------------------------------- #


@dataclass
class _RoundState:
    """Mutable observation shared by the supervisor's event and control callbacks."""

    solving_at: float | None = None
    first_incumbent_at: float | None = None
    progress_events: int = 0
    best_score: int | None = None
    control_sent_at: float | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def _real_job(job_id: str, timeout_seconds: int) -> Job:
    """Build a running CP-SAT job for the large real scenario."""
    return Job(
        id=job_id,
        state=JobState.RUNNING,
        request=JobRequest(
            input_name="large-ward-with-87-people-2025-11.yaml",
            client_id="solver-capability-probe",
            solver=SUPPORTED_SOLVER,
            prettify=False,
            timeout_seconds=timeout_seconds,
        ),
        created_at=datetime.now(timezone.utc),
    )


def _round_parameters(name: str, config: ProbeConfig) -> dict[str, Any]:
    """Return the native timeout, hard timeout, and finish-now flag for one round."""
    if name in {"timeout", "intermediate-scores"}:
        native = config.timeout_seconds
        return {"native": native, "hard": native + config.timeout_grace_seconds, "finish_now": False}
    if name == "hard-watchdog":
        return {"native": config.watchdog_native_seconds, "hard": config.watchdog_hard_seconds, "finish_now": False}
    native = config.control_timeout_seconds
    return {"native": native, "hard": native + config.timeout_grace_seconds, "finish_now": name == "finish-now"}


def _make_control(name: str, state: _RoundState, config: ProbeConfig):
    """Return the executor control callback for one round."""

    def control() -> ProcessControl | None:
        if name == "cancel":
            if state.first_incumbent_at is not None or (
                state.solving_at is not None and time.monotonic() - state.solving_at > config.control_fallback_seconds
            ):
                state.control_sent_at = state.control_sent_at or time.monotonic()
                return ProcessControl.CANCEL
        elif name == "finish-now" and state.first_incumbent_at is not None:
            state.control_sent_at = state.control_sent_at or time.monotonic()
            return ProcessControl.FINISH
        return None

    return control


def _observe_round(name: str, config: ProbeConfig) -> dict[str, Any]:
    """Run one supervised CP-SAT round and return its normalized observation."""
    parameters = _round_parameters(name, config)
    input_bytes = canonicalize_submission(config.testcase.read_bytes())
    state = _RoundState()

    def event_callback(event_type: str, data: dict[str, Any], score: int | None) -> None:
        if event_type == "job.phase_changed" and data.get("code") == "solving":
            if state.solving_at is None:
                state.solving_at = time.monotonic()
        elif event_type == "job.progressed":
            state.progress_events += 1
            if state.first_incumbent_at is None:
                state.first_incumbent_at = time.monotonic()
            if score is not None:
                state.best_score = score

    started_at = time.monotonic()
    with _ResidueSampler() as sampler:
        result = run_optimization_process(
            OptimizationRunner(),
            _real_job(f"probe-{name}", parameters["native"]),
            input_bytes,
            event_callback=event_callback,
            control=_make_control(name, state, config),
            hard_timeout_seconds=parameters["hard"],
            finish_now_enabled=parameters["finish_now"],
        )
        residue_checked, residue_clean = sampler.residue()

    reference = state.solving_at or started_at
    output = result.output
    observation: dict[str, Any] = {
        "process_status": result.status.value,
        "termination_reason": output.result.termination_reason if output is not None else None,
        "solver_status": output.result.solver_status if output is not None else None,
        "score": output.result.score if output is not None else None,
        "failure_code": result.failure.code if result.failure is not None else None,
        "artifact_available": bool(output is not None and output.artifact is not None),
        "artifact_bytes": (
            len(output.artifact.content) if output is not None and output.artifact is not None else None
        ),
        "progress_events": state.progress_events,
        "first_incumbent_seconds": (state.first_incumbent_at - reference) if state.first_incumbent_at else None,
        "elapsed_seconds": time.monotonic() - reference,
        "elapsed_from": "solving_started" if state.solving_at is not None else "start",
        "residue_checked": residue_checked,
        "residue_clean": residue_clean,
    }
    return observation


def run_worker_round(name: str, config: ProbeConfig) -> RoundReport:
    """Execute one real capability round in the current isolated subprocess."""
    observation = _observe_round(name, config)
    return _EVALUATORS[name](observation, config)


# --------------------------------------------------------------------------- #
# Subprocess isolation and orchestration.
# --------------------------------------------------------------------------- #


def _worker_timeout(name: str, config: ProbeConfig) -> float:
    """Return the parent-side hard watchdog for one round subprocess."""
    parameters = _round_parameters(name, config)
    if name == "hard-watchdog":
        active = config.watchdog_hard_seconds
    elif name == "cancel":
        active = config.control_fallback_seconds + config.control_grace_seconds
    else:
        active = parameters["hard"]
    return active + config.startup_margin_seconds


def _round_command(name: str, config: ProbeConfig) -> list[str]:
    """Build the hidden worker-round command line for one round subprocess."""
    return [
        sys.executable,
        str(Path(__file__).resolve()),
        "--worker-round",
        name,
        "--testcase",
        str(config.testcase),
        "--timeout-seconds",
        str(config.timeout_seconds),
        "--timeout-grace-seconds",
        str(config.timeout_grace_seconds),
        "--watchdog-native-seconds",
        str(config.watchdog_native_seconds),
        "--watchdog-hard-seconds",
        str(config.watchdog_hard_seconds),
        "--control-timeout-seconds",
        str(config.control_timeout_seconds),
        "--control-fallback-seconds",
        str(config.control_fallback_seconds),
        "--control-grace-seconds",
        str(config.control_grace_seconds),
        "--startup-margin-seconds",
        str(config.startup_margin_seconds),
    ]


def run_round_subprocess(name: str, config: ProbeConfig) -> RoundReport:
    """Run one capability round in a killable child process and parse its report."""
    environment = os.environ.copy()
    environment.update(PYTHONUNBUFFERED="1", PYTHONPATH=str(CORE_ROOT))
    try:
        completed = subprocess.run(
            _round_command(name, config),
            cwd=CORE_ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=_worker_timeout(name, config),
            check=False,
        )
    except subprocess.TimeoutExpired:
        return RoundReport(name=name, status="FAIL", detail="Round subprocess exceeded its hard watchdog.")

    payload = None
    for line in reversed(completed.stdout.splitlines()):
        if line.startswith(RESULT_MARKER):
            payload = line.removeprefix(RESULT_MARKER)
            break
    stderr_tail = completed.stderr[-2_000:].strip() or None
    if payload is None:
        return RoundReport(
            name=name,
            status="FAIL",
            detail=f"Round subprocess exited with code {completed.returncode} without a result payload.",
            worker_stderr_tail=stderr_tail,
        )
    try:
        report = RoundReport(**json.loads(payload))
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        return RoundReport(
            name=name,
            status="FAIL",
            detail=f"Round subprocess returned an invalid payload: {error}",
            worker_stderr_tail=stderr_tail,
        )
    if completed.returncode != 0:
        return RoundReport(
            **{
                **asdict(report),
                "status": "FAIL",
                "detail": f"Round subprocess exited with code {completed.returncode}: {report.detail}",
                "worker_stderr_tail": stderr_tail,
            }
        )
    if report.status == "FAIL" and stderr_tail:
        return RoundReport(**{**asdict(report), "worker_stderr_tail": stderr_tail})
    return report


def probe_cp_sat(config: ProbeConfig) -> SolverReport:
    """Run every CP-SAT capability round in fixed order."""
    reports: list[RoundReport] = []
    for name in ROUND_ORDER:
        print(f"[{SUPPORTED_SOLVER}] {name}: running", file=sys.stderr, flush=True)
        report = run_round_subprocess(name, config)
        print(f"[{SUPPORTED_SOLVER}] {name}: {report.status}", file=sys.stderr, flush=True)
        reports.append(report)
    return SolverReport(selector=SUPPORTED_SOLVER, rounds=tuple(reports))


# --------------------------------------------------------------------------- #
# Reporting.
# --------------------------------------------------------------------------- #


def _status_cell(report: RoundReport) -> str:
    """Format one compact Markdown status cell."""
    if report.elapsed_seconds is None:
        return report.status
    return f"{report.status} ({report.elapsed_seconds:.1f}s)"


def render_markdown(report: SolverReport) -> str:
    """Render the human-readable capability summary table."""
    header = [name.replace("-", " ").title() for name in ROUND_ORDER]
    lines = [
        "| Selector | " + " | ".join(header) + " | Notes |",
        "| --- | " + " | ".join("---" for _ in header) + " | --- |",
    ]
    by_name = {round_report.name: round_report for round_report in report.rounds}
    notes = " ".join(
        " ".join(f"{round_report.name}: {round_report.detail}".split()) for round_report in report.rounds
    ).replace("|", "\\|")
    cells = [_status_cell(by_name[name]) for name in ROUND_ORDER]
    lines.append("| " + " | ".join([f"`{report.selector}`", *cells, notes]) + " |")
    return "\n".join(lines)


def _json_payload(report: SolverReport, config: ProbeConfig) -> dict[str, Any]:
    """Build the machine-readable report with runtime context."""
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "platform": platform.platform(),
        "pythonVersion": platform.python_version(),
        "testcase": str(config.testcase),
        "roundOrder": list(ROUND_ORDER),
        "config": {**asdict(config), "testcase": str(config.testcase)},
        "solver": {
            "selector": report.selector,
            "rounds": [asdict(round_report) for round_report in report.rounds],
        },
    }


# --------------------------------------------------------------------------- #
# Command line.
# --------------------------------------------------------------------------- #


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def _positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    """Build the public and hidden worker-round CLI arguments."""
    parser = argparse.ArgumentParser(
        description="Probe supervised CP-SAT timeout, cancel, and finish-now behavior on the large real scenario.",
    )
    parser.add_argument("--testcase", type=Path, default=REAL_TESTCASE)
    parser.add_argument("--timeout-seconds", type=_positive_int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--timeout-grace-seconds", type=_positive_float, default=DEFAULT_TIMEOUT_GRACE_SECONDS)
    parser.add_argument("--watchdog-native-seconds", type=_positive_int, default=DEFAULT_WATCHDOG_NATIVE_SECONDS)
    parser.add_argument("--watchdog-hard-seconds", type=_positive_float, default=DEFAULT_WATCHDOG_HARD_SECONDS)
    parser.add_argument("--control-timeout-seconds", type=_positive_int, default=DEFAULT_CONTROL_TIMEOUT_SECONDS)
    parser.add_argument("--control-fallback-seconds", type=_positive_float, default=DEFAULT_CONTROL_FALLBACK_SECONDS)
    parser.add_argument("--control-grace-seconds", type=_positive_float, default=DEFAULT_CONTROL_GRACE_SECONDS)
    parser.add_argument("--startup-margin-seconds", type=_positive_float, default=DEFAULT_STARTUP_MARGIN_SECONDS)
    parser.add_argument("--json-output", type=Path, help="Also write the full machine-readable report to this path.")
    parser.add_argument("--worker-round", choices=ROUND_ORDER, help=argparse.SUPPRESS)
    return parser


def _config_from_args(args: argparse.Namespace) -> ProbeConfig:
    """Translate validated CLI arguments into an immutable probe configuration."""
    return ProbeConfig(
        testcase=args.testcase.resolve(),
        timeout_seconds=args.timeout_seconds,
        timeout_grace_seconds=args.timeout_grace_seconds,
        watchdog_native_seconds=args.watchdog_native_seconds,
        watchdog_hard_seconds=args.watchdog_hard_seconds,
        control_timeout_seconds=args.control_timeout_seconds,
        control_fallback_seconds=args.control_fallback_seconds,
        control_grace_seconds=args.control_grace_seconds,
        startup_margin_seconds=args.startup_margin_seconds,
    )


def main(argv: list[str] | None = None) -> int:
    """Run one hidden worker round or orchestrate the full CP-SAT probe."""
    parser = build_parser()
    args = parser.parse_args(argv)
    config = _config_from_args(args)

    if args.worker_round is not None:
        try:
            report = run_worker_round(args.worker_round, config)
        except Exception as error:  # noqa: BLE001 - reported as a structured FAIL payload
            traceback.print_exc()
            report = _round_report(args.worker_round, "FAIL", f"Unhandled round error: {error}")
        print(f"{RESULT_MARKER}{json.dumps(asdict(report), sort_keys=True)}", flush=True)
        return 0

    if not config.testcase.is_file():
        parser.error(f"testcase does not exist: {config.testcase}")

    report = probe_cp_sat(config)
    print(render_markdown(report))
    if args.json_output is not None:
        args.json_output.parent.mkdir(parents=True, exist_ok=True)
        args.json_output.write_text(json.dumps(_json_payload(report, config), indent=2) + "\n", encoding="utf-8")
    return int(any(round_report.status == "FAIL" for round_report in report.rounds))


if __name__ == "__main__":
    raise SystemExit(main())

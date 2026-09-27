"""Opt-in real check: a cancelled CP-SAT job leaves no solver child process behind.

This keeps the process-residue audit from the v2 ``scripts/solver_capability_probe.py``
(bead ``nursing-sheduler-r6g``). The v1 probe in ``solver_capabilities.py`` replaced that
probe; only its Linux ``/proc`` audit survives here, as one small separate check rather
than a patch to the verbatim upstream file.

The audit samples the ``multiprocessing`` spawn children of the process hosting the app
while the probe's cancellation round is in flight, then requires that none of them is
still alive once the job is terminal. It is Linux-only; other platforms skip.

The file intentionally omits pytest's ``test_`` filename prefix so the default suite does
not collect it. Run it explicitly like the other real-world checks:

```sh
cd core
PYTHONPATH=. pytest -q tests/real/solver_capabilities_residue.py
```
"""

import os
import sys
import threading
import time
from pathlib import Path

import pytest

from . import solver_capabilities

# X4: the product ships OR-Tools CP-SAT only.
SOLVER = "ortools/cp-sat"


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
    """Poll for the supervised child PIDs so residue can be checked after termination."""

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

    @property
    def sampled(self) -> set[int]:
        """Supervised child PIDs observed while the round was in flight."""
        return set(self._seen)

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


@pytest.mark.skipif(sys.platform != "linux", reason="the /proc residue audit is Linux only")
def test_cancel_leaves_no_solver_child_process():
    """Cancel a real CP-SAT job and require the supervised child to be gone afterwards."""
    config = solver_capabilities.ProbeConfig(
        control_timeout_seconds=30,
        cancel_delay_seconds=1.0,
        control_grace_seconds=30,
    )

    with _ResidueSampler() as sampler:
        report = solver_capabilities._run_worker_round("cancel", SOLVER, config)
    checked, clean = sampler.residue()

    assert report.status == "PASS", report.detail
    assert checked, "the residue sampler never ran"
    # Fail loudly rather than pass vacuously if the supervisor stops spawning a
    # direct child of this process, which would make the audit meaningless.
    assert sampler.sampled, "the residue audit observed no supervised child process"
    assert clean, "a solver child process survived cancellation"

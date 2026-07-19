"""In-container driver for the Redis-backed deploy gates (T02r, tech-plan §3/§7).

`docker/verify-deploy.sh` streams this file into a throwaway container built from
the backend image (`python - <mode> [args]`), so it may import ONLY the vendored
`nurse_scheduling.server` package that already ships in the lean runtime image —
never `tests/`, which the runtime stage deliberately excludes.

It talks to the private Compose Redis over the project network and uses its own
`GATE_PREFIX` namespace, so it never sees or disturbs the live backend's job keys.
Every mode prints exactly one `GATE_RESULT:<value>` sentinel line on success and
exits non-zero on any failed assertion.

Modes:
  seed          create one queued job; print GATE_RESULT:<job_id>
  check <id>    assert that job still exists after a backend/redis restart
  replay        assert Last-Event-ID replay returns only events after the cursor
  workerlost    SIGKILL a claim-holding process; assert terminal worker_lost
  cleanup       delete every key under GATE_PREFIX
"""

import multiprocessing
import os
import signal
import sys
import time

from nurse_scheduling.server.event_cursor import encode_cursor
from nurse_scheduling.server.jobs.controller import JobController
from nurse_scheduling.server.jobs.models import JobState, StoreLimits
from nurse_scheduling.server.stores.redis import RedisJobStore

URL = os.environ.get("JOB_REDIS_URL", "redis://redis:6379/0")
PREFIX = os.environ["GATE_PREFIX"]

# Test-only lease settings for the worker-loss gate: bounded waits, never the
# 90s production lease (tech-plan §7).
LEASE_SECONDS = 3.0
MAINTENANCE_INTERVAL_SECONDS = 0.25


def _store() -> RedisJobStore:
    return RedisJobStore(url=URL, key_prefix=PREFIX)


def _controller(store: RedisJobStore, lease: float = 90.0) -> JobController:
    return JobController(
        store,
        limits=StoreLimits(max_pending=8, max_retained=128),
        retention_seconds=3600,
        claim_lease_seconds=lease,
    )


def _new_job(controller: JobController):
    return controller.create_job(
        input_name="gate.yaml",
        client_id="deploy-gate",
        solver="ortools/cp-sat",
        prettify=None,
        timeout_seconds=300,
        input_bytes=b"deploy-gate",
    )


def _result(value: str) -> None:
    print(f"GATE_RESULT:{value}")


def seed() -> None:
    job = _new_job(_controller(_store()))
    _result(job.id)


def check(job_id: str) -> None:
    # get() raises JobNotFoundError (non-zero exit) if the restart lost the record.
    job = _controller(_store()).get_job(job_id)
    assert job.state == JobState.QUEUED, f"expected QUEUED after restart, got {job.state}"
    _result("OK")


def replay() -> None:
    controller = _controller(_store())
    job = _new_job(controller)
    claimed = controller.claim_next_job("gate-worker")
    assert claimed is not None, "queued job was not claimable"
    for index in range(5):
        controller.record_event(job.id, "job.progressed", {"n": index}, worker_id="gate-worker")

    full = controller.prepare_event_replay(job.id, None)
    # initial_events carry native store IDs; the public Last-Event-ID cursor is the
    # job-bound encoding of a native ID.
    ids = [event.id for event in full.initial_events]
    assert len(ids) >= 3, f"expected >=3 retained events, got {len(ids)}"

    # Reconnect with a mid-stream Last-Event-ID: replay must return only events
    # strictly after that cursor, never the cursor itself or anything before it.
    cursor = encode_cursor(job.id, ids[1])
    after = controller.prepare_event_replay(job.id, cursor)
    replayed = [event.id for event in after.initial_events]
    assert ids[1] not in replayed, "cursor event was re-sent on reconnect"
    assert replayed == ids[2:], f"replay after cursor was {replayed}, expected {ids[2:]}"
    _result("OK")


def _hold_claim_forever(job_id: str) -> None:
    """Child process: claim the job and renew its lease until SIGKILLed."""
    controller = _controller(_store(), lease=LEASE_SECONDS)
    claimed = controller.claim_next_job("hold-worker")
    if claimed is None:
        return
    while True:
        controller.renew_claim(claimed.id, "hold-worker")
        time.sleep(LEASE_SECONDS / 3)


def workerlost() -> None:
    controller = _controller(_store(), lease=LEASE_SECONDS)
    job = _new_job(controller)

    context = multiprocessing.get_context("fork")
    holder = context.Process(target=_hold_claim_forever, args=(job.id,))
    holder.start()
    try:
        assert _wait(lambda: controller.get_job(job.id).state == JobState.RUNNING, 15.0), "job never reached RUNNING"
        # Active cross-process renewal keeps it RUNNING past one lease.
        time.sleep(LEASE_SECONDS + 0.5)
        assert controller.get_job(job.id).state == JobState.RUNNING, "job expired while worker still alive"

        os.kill(holder.pid, signal.SIGKILL)
        holder.join(timeout=5)
        assert not holder.is_alive(), "holder survived SIGKILL"

        # This process is the replacement observer — it never held the claim, so
        # its expiry of the abandoned lease is a genuine cross-process recovery.
        observer = _controller(_store(), lease=LEASE_SECONDS)
        deadline = time.monotonic() + LEASE_SECONDS + 5.0
        while time.monotonic() < deadline:
            observer.expire_worker_claims()
            current = observer.get_job(job.id)
            if current.state.terminal:
                assert current.failure is not None and current.failure.code == "worker_lost", (
                    f"terminal without worker_lost: {current.state}/{current.failure}"
                )
                _result("OK")
                return
            time.sleep(MAINTENANCE_INTERVAL_SECONDS)
        raise AssertionError("worker_lost not recorded within lease + 5s")
    finally:
        if holder.is_alive():
            holder.kill()
            holder.join(timeout=5)


def cleanup() -> None:
    store = _store()
    keys = list(store._redis.scan_iter(f"{PREFIX}:*"))
    if keys:
        store._redis.delete(*keys)
    _result("OK")


def _wait(predicate, timeout: float, interval: float = 0.1) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


MODES = {
    "seed": seed,
    "check": check,
    "replay": replay,
    "workerlost": workerlost,
    "cleanup": cleanup,
}


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in MODES:
        print(f"usage: driver <{'|'.join(MODES)}> [args]", file=sys.stderr)
        raise SystemExit(2)
    MODES[sys.argv[1]](*sys.argv[2:])


if __name__ == "__main__":
    main()

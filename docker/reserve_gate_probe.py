"""In-container HTTP + real-Redis probe for the diagnostic reserve (T09 admission, T11 gate).

`docker/verify-deploy.sh` streams this file into a throwaway container built from the
backend image, exactly like `deploy_gate_driver.py`, so it may import ONLY the
vendored `nurse_scheduling.server` package that ships in the lean runtime image --
never `tests/`, which the runtime stage excludes.

WHY THIS EXISTS SEPARATELY FROM THE PARITY SUITE. `core/tests/test_server_priority_queue.py`
already proves the reserve arithmetic across memory, fakeredis and real Redis, but it
proves it at the STORE and TestClient level. The Phase-1 acceptance asks for the
seven-diagnostic reserve in assembled form: a real ASGI server, real HTTP, real Redis,
and the real admission path from form parsing through purpose validation to the store
transition. That is what this runs.

WHY IT IS DETERMINISTIC RATHER THAN A RACE. The app is constructed with
`start_background=False`, so no worker claims and no maintenance pass runs: submitted
jobs simply stay QUEUED. Nothing is solved, nothing is timed, and the outcome does not
depend on how fast anything is. That is also why this cannot use the live gate
backend, whose worker would claim the queue out from under the assertions.

ISOLATION. Its own `GATE_PREFIX` Redis namespace and its own loopback port, so the
live backend's keys are never read or written. Every job it creates is deleted, each
deletion is confirmed by a 404, and any residual key under the prefix is removed and
asserted gone -- so a passing run leaves nothing behind and a leaking run says so.

Prints exactly one `GATE_RESULT:<value>` sentinel on success and exits non-zero on any
failed assertion.
"""

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import uvicorn

from nurse_scheduling.server.app import create_app
from nurse_scheduling.server.config import ServerSettings
from nurse_scheduling.server.stores.redis import RedisJobStore

URL = os.environ.get("JOB_REDIS_URL", "redis://redis:6379/0")
PREFIX = os.environ["GATE_PREFIX"]
PORT = int(os.environ.get("GATE_PORT", "8111"))
BASE = f"http://127.0.0.1:{PORT}"

# The SHIPPED defaults, restated so the arithmetic below is legible: eight pending
# slots with one reserved for ordinary work means the seventh diagnostic is the last
# one that fits.
MAX_PENDING = 8
RESERVED_FOR_ORDINARY = 1
DIAGNOSTICS_THAT_FIT = MAX_PENDING - RESERVED_FOR_ORDINARY

# Minimal and always feasible. It is never solved -- no worker runs -- so its only job
# is to be a valid submission.
SCENARIO = "\n".join(
    [
        "apiVersion: alpha",
        "dates:",
        "  range:",
        "    startDate: 2025-01-01",
        "    endDate: 2025-01-01",
        "people:",
        "  items:",
        "    - id: alice",
        "shiftTypes:",
        "  items:",
        "    - id: day",
        "preferences:",
        "  - type: at most one shift per day",
        "  - type: shift type requirement",
        "    shiftType: day",
        "    requiredNumPeople: 1",
    ]
)


def _start_server() -> uvicorn.Server:
    """Serve the real app over real HTTP, with no worker and no maintenance pass."""
    settings = ServerSettings(
        job_backend="redis",
        redis_url=URL,
        redis_key_prefix=PREFIX,
        max_pending_jobs=MAX_PENDING,
        ordinary_reserved_slots=RESERVED_FOR_ORDINARY,
    )
    app = create_app(settings=settings, start_background=False)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="error", access_log=False))
    threading.Thread(target=server.run, daemon=True).start()

    deadline = time.monotonic() + 30.0
    while time.monotonic() < deadline:
        if server.started:
            return server
        time.sleep(0.05)
    raise AssertionError("probe server did not start within 30s")


def _request(method: str, path: str, fields: dict | None = None) -> tuple[int, dict]:
    data = urllib.parse.urlencode(fields).encode() if fields is not None else None
    request = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            body = response.read().decode()
            return response.status, (json.loads(body) if body else {})
    except urllib.error.HTTPError as error:
        body = error.read().decode()
        return error.code, (json.loads(body) if body else {})


def _submit(purpose: str | None) -> tuple[int, dict]:
    fields = {"yaml_content": SCENARIO}
    if purpose is not None:
        fields["purpose"] = purpose
    return _request("POST", "/optimize", fields)


def _error_code(body: dict) -> str:
    return str(body.get("error", {}).get("code", ""))


def main() -> None:
    _start_server()
    created: list[str] = []
    cleanup: dict = {}

    try:
        # 1. Fill every slot a diagnostic is entitled to.
        for index in range(DIAGNOSTICS_THAT_FIT):
            status, body = _submit("assistant_diagnostic")
            assert status == 202, f"diagnostic {index + 1} was refused with {status}: {body}"
            assert body["request"]["purpose"] == "assistant_diagnostic", body["request"]
            assert body["queue_position"] == index + 1, f"diagnostic {index + 1} took position {body['queue_position']}"
            created.append(body["id"])

        # 2. The next diagnostic must be refused, and refused for the RESERVE
        #    specifically -- a client told the whole queue is full would back off from
        #    work that is in fact still admissible.
        status, body = _submit("assistant_diagnostic")
        assert status == 429, f"the eighth diagnostic was not refused: {status} {body}"
        assert _error_code(body) == "diagnostic_capacity_reserved", body
        # The refusal describes capacity, never the document it refused.
        serialized = json.dumps(body)
        assert "alice" not in serialized and "apiVersion" not in serialized, serialized

        # 3. The reserved slot is still there for ordinary work -- the whole point --
        #    and ordinary work goes to the FRONT, ahead of every queued diagnostic.
        status, body = _submit(None)
        assert status == 202, f"ordinary work was refused at the reserve: {status} {body}"
        assert body["request"]["purpose"] == "ordinary", body["request"]
        assert body["queue_position"] == 1, f"ordinary took position {body['queue_position']}"
        created.append(body["id"])

        # 4. Sensitivity. All eight slots are now genuinely occupied, so a further
        #    ordinary submission must be refused too -- with the OTHER code. Without
        #    this, step 2 would pass just as well against a queue that was simply full,
        #    which would prove nothing about the reserve.
        status, body = _submit(None)
        assert status == 429, f"a ninth job was admitted beyond max_pending: {status} {body}"
        assert _error_code(body) == "job_capacity_exceeded", body

    finally:
        # 5. Always clean up, even on a failed assertion -- but only RECORD what
        #    happened here. Asserting inside `finally` would replace an in-flight
        #    failure with a cleanup failure and hide the reason the gate went red.
        cleanup["residue"] = []
        for job_id in created:
            # Cancel FIRST: deletion is only allowed on a terminal job, and every job
            # here is still QUEUED because nothing claims. A queued cancel goes
            # straight to terminal CANCELLED with no worker involved, so this stays
            # deterministic -- there is no state for it to wait on.
            cancel_status, cancel_body = _request("POST", f"/optimize/{job_id}/cancel")
            delete_status, _ = _request("DELETE", f"/optimize/{job_id}")
            get_status, _ = _request("GET", f"/optimize/{job_id}")
            if cancel_status != 202 or not cancel_body.get("terminal") or delete_status != 204 or get_status != 404:
                cleanup["residue"].append(f"{job_id}:{cancel_status}/{delete_status}/{get_status}")
        # Belt and braces: nothing may remain under this probe's namespace, including
        # index entries an incomplete delete could have orphaned.
        store = RedisJobStore(url=URL, key_prefix=PREFIX)
        keys = list(store._redis.scan_iter(f"{PREFIX}:*"))
        if keys:
            store._redis.delete(*keys)
        cleanup["left"] = list(store._redis.scan_iter(f"{PREFIX}:*"))

    # Reached only when the assertions above all held, so these speak for cleanup.
    assert not cleanup["residue"], f"jobs were not cleanly deleted: {cleanup['residue']}"
    assert not cleanup["left"], f"{len(cleanup['left'])} key(s) remained under {PREFIX}"

    print(f"GATE_RESULT:OK:{DIAGNOSTICS_THAT_FIT}-diagnostics-then-reserved-slot")


if __name__ == "__main__":
    main()

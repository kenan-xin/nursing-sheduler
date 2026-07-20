"""Fast unit tests for the opt-in real CP-SAT capability probe helpers.

These cover the probe's pure classification and reporting logic with fabricated
observations. They never launch the real solver, so they stay in the ordinary
suite while the slow supervised rounds live in the opt-in
``scripts/solver_capability_probe.py`` tool.
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

from scripts import solver_capability_probe as probe


def _completed(termination_reason, *, score=-42, artifact=True, progress=3, elapsed=8.1, solving=True):
    return {
        "process_status": "completed",
        "termination_reason": termination_reason,
        "solver_status": "FEASIBLE",
        "score": score,
        "failure_code": None,
        "artifact_available": artifact,
        "artifact_bytes": 1024 if artifact else None,
        "progress_events": progress,
        "first_incumbent_seconds": 1.2 if progress else None,
        "elapsed_seconds": elapsed,
        "elapsed_from": "solving_started" if solving else "start",
        "residue_checked": True,
        "residue_clean": True,
    }


def _failed(failure_code, *, elapsed=8.0, progress=0, residue_clean=True):
    return {
        "process_status": "failed",
        "termination_reason": None,
        "solver_status": None,
        "score": None,
        "failure_code": failure_code,
        "artifact_available": False,
        "artifact_bytes": None,
        "progress_events": progress,
        "first_incumbent_seconds": None,
        "elapsed_seconds": elapsed,
        "elapsed_from": "solving_started",
        "residue_checked": True,
        "residue_clean": residue_clean,
    }


def _cancelled(*, incumbent=True, residue_clean=True, artifact=False, score=None):
    return {
        "process_status": "cancelled",
        "termination_reason": None,
        "solver_status": None,
        "score": score,
        "failure_code": None,
        "artifact_available": artifact,
        "artifact_bytes": None,
        "progress_events": 2 if incumbent else 0,
        "first_incumbent_seconds": 1.5 if incumbent else None,
        "elapsed_seconds": 3.0,
        "elapsed_from": "solving_started",
        "residue_checked": True,
        "residue_clean": residue_clean,
    }


def test_round_order_is_cp_sat_only_and_fixed():
    assert probe.ROUND_ORDER == ("timeout", "hard-watchdog", "cancel", "finish-now", "intermediate-scores")
    assert probe.SUPPORTED_SOLVER == "ortools/cp-sat"


def test_config_defaults():
    config = probe._config_from_args(probe.build_parser().parse_args([]))
    assert config.timeout_seconds == 8
    assert config.timeout_grace_seconds == 25
    assert config.watchdog_native_seconds > config.watchdog_hard_seconds
    assert config.testcase == probe.REAL_TESTCASE


def test_timeout_classification():
    config = probe.ProbeConfig(timeout_seconds=8, timeout_grace_seconds=25)
    assert probe.evaluate_timeout(_completed("solver_timeout"), config).status == "PASS"
    # A graceful solver forced by the watchdog is a failure, not a pass.
    assert probe.evaluate_timeout(_failed("process_timeout"), config).status == "FAIL"
    # Returning after the whole grace budget is a failure.
    assert probe.evaluate_timeout(_completed("solver_timeout", elapsed=40.0), config).status == "FAIL"
    # An optimal solve before the timeout could bite is inconclusive, not a failure.
    assert probe.evaluate_timeout(_completed("optimality_proven", elapsed=1.0), config).status == "INCONCLUSIVE"
    # solver_timeout without a downloadable schedule is a failure.
    assert probe.evaluate_timeout(_completed("solver_timeout", artifact=False), config).status == "FAIL"


def test_hard_watchdog_classification():
    config = probe.ProbeConfig(watchdog_hard_seconds=8, startup_margin_seconds=60)
    assert probe.evaluate_hard_watchdog(_failed("process_timeout", elapsed=8.5), config).status == "PASS"
    # A graceful native timeout means the watchdog never had to fire.
    assert probe.evaluate_hard_watchdog(_completed("solver_timeout"), config).status == "FAIL"
    # process_timeout with a surviving child is a residue failure.
    residual = probe.evaluate_hard_watchdog(_failed("process_timeout", elapsed=8.5, residue_clean=False), config)
    assert residual.status == "FAIL"


def test_hard_watchdog_reports_skipped_residue_as_pass():
    config = probe.ProbeConfig(watchdog_hard_seconds=8, startup_margin_seconds=60)
    observation = _failed("process_timeout", elapsed=8.5)
    observation.update(residue_checked=False, residue_clean=None)
    report = probe.evaluate_hard_watchdog(observation, config)
    assert report.status == "PASS"
    assert "skipped" in report.detail.lower()


def test_cancel_classification():
    config = probe.ProbeConfig()
    assert probe.evaluate_cancel(_cancelled(), config).status == "PASS"
    # Retained output contradicts a discarding cancellation.
    assert probe.evaluate_cancel(_cancelled(artifact=True, score=-1), config).status == "FAIL"
    # A surviving child after cancellation is a residue failure.
    assert probe.evaluate_cancel(_cancelled(residue_clean=False), config).status == "FAIL"
    # A different terminal status is a failure.
    assert probe.evaluate_cancel(_completed("solver_timeout"), config).status == "FAIL"


def test_finish_now_classification():
    config = probe.ProbeConfig()
    assert probe.evaluate_finish_now(_completed("user_requested"), config).status == "PASS"
    # No incumbent yet is inconclusive rather than a failure.
    assert probe.evaluate_finish_now(_failed("no_solution_found"), config).status == "INCONCLUSIVE"
    # A native timeout preempting finish-now is inconclusive.
    assert probe.evaluate_finish_now(_completed("solver_timeout"), config).status == "INCONCLUSIVE"
    # user_requested without a schedule is a failure.
    assert probe.evaluate_finish_now(_completed("user_requested", artifact=False), config).status == "FAIL"


def test_intermediate_scores_classification():
    config = probe.ProbeConfig()
    assert probe.evaluate_intermediate_scores(_completed("solver_timeout", progress=4), config).status == "PASS"
    # No incumbent that could carry a score is inconclusive when the solver failed.
    assert probe.evaluate_intermediate_scores(_failed("no_solution_found"), config).status == "INCONCLUSIVE"
    # A completed run that somehow emitted no score is a failure.
    no_score = _completed("solver_timeout", progress=0, score=None)
    assert probe.evaluate_intermediate_scores(no_score, config).status == "FAIL"


def test_probe_runs_rounds_in_order(monkeypatch):
    calls = []

    def fake_round(name, _config):
        calls.append(name)
        return probe.RoundReport(name=name, status="PASS", detail="ok")

    monkeypatch.setattr(probe, "run_round_subprocess", fake_round)
    report = probe.probe_cp_sat(probe.ProbeConfig())

    assert calls == list(probe.ROUND_ORDER)
    assert report.selector == "ortools/cp-sat"
    assert [round_report.name for round_report in report.rounds] == list(probe.ROUND_ORDER)


def test_markdown_report_lists_every_round():
    rounds = tuple(
        probe.RoundReport(name=name, status="PASS", detail="ok", elapsed_seconds=1.0) for name in probe.ROUND_ORDER
    )
    markdown = probe.render_markdown(probe.SolverReport("ortools/cp-sat", rounds))

    header = markdown.splitlines()[0]
    assert header == "| Selector | Timeout | Hard Watchdog | Cancel | Finish Now | Intermediate Scores | Notes |"
    assert "`ortools/cp-sat`" in markdown


def test_round_parameters_bound_each_round():
    config = probe.ProbeConfig()
    timeout = probe._round_parameters("timeout", config)
    assert timeout["hard"] == config.timeout_seconds + config.timeout_grace_seconds
    assert timeout["finish_now"] is False

    watchdog = probe._round_parameters("hard-watchdog", config)
    assert watchdog["hard"] < watchdog["native"]

    finish = probe._round_parameters("finish-now", config)
    assert finish["finish_now"] is True

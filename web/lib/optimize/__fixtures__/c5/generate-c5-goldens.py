#!/usr/bin/env python3
# Provenance generator for the T16c XLSX-restoration golden fixtures.
#
# These fixtures are REAL Contract C5 workbooks: each one is produced by the
# actual backend exporter (`nurse_scheduling.exporter.export_to_excel`, driven
# by `nurse_scheduling.schedule(...)`), NOT hand-built by ExcelJS/openpyxl in a
# test. They stand in for the anonymized workbook the frontend downloads: the
# submitted `person.id` values are the anonymized `P#` ids the frontend feeds
# the solver, so column A of the schedule sheet holds exactly those `P#` cells.
#
# The frontend restoration then swaps those `P#` cells back to the original ids.
# The reverse maps used by the tests live in the TypeScript suite; this script
# only fixes the workbook side (the `P#` ids present, in row order) and records
# it in `manifest.json`.
#
# Regenerate (from the backend repo, with its venv active):
#     cd /home/kenan/work/nurse-scheduling/core && . .venv/bin/activate
#     python /home/kenan/work/nursing-sheduler/web/lib/optimize/__fixtures__/c5/generate-c5-goldens.py
#
# The workbooks are committed; this script documents how they were made and lets
# a reviewer reproduce them byte-for-content. Determinism uses `deterministic=1`
# so the schedule solution is stable across runs.

import json
import os
from io import BytesIO

import nurse_scheduling
import nurse_scheduling.exporter as exporter

OUT_DIR = os.path.dirname(os.path.abspath(__file__))


def scenario(people_ids, *, with_history=False):
    """A minimal but real feasible scenario whose people carry the given ids.

    `people_ids` become `person.id` verbatim (int or str), exactly as an
    anonymized submission carries `P#` strings in column A.
    """
    lines = [
        "apiVersion: alpha",
        "dates:",
        "  range:",
        "    startDate: 2023-08-18",
        "    endDate: 2023-08-20",
        "people:",
        "  items:",
    ]
    histories = ["[D]", "[E]", "[N]", "[OFF]"]
    for i, pid in enumerate(people_ids):
        lines.append(f"    - id: {pid}")
        if with_history:
            lines.append(f"      history: {histories[i % len(histories)]}")
    lines += [
        "shiftTypes:",
        "  items:",
        "    - id: D",
        "    - id: E",
        "    - id: N",
        "preferences:",
        "  - type: at most one shift per day",
        "  - type: shift type requirement",
        "    shiftType: [D, E, N]",
        "    requiredNumPeople: 1",
    ]
    # Give each of the first three people a distinct daily request so the solver
    # has a unique feasible optimum (stable output).
    for i, pid in enumerate(people_ids[:3]):
        st = ["D", "E", "N"][i]
        lines += [
            "  - type: shift request",
            f"    person: {pid}",
            "    date: ALL",
            f"    shiftType: {st}",
        ]
    return ("\n".join(lines) + "\n").encode("utf-8")


def export(result):
    buf = BytesIO()
    exporter.export_to_excel(result.dataframe, buf, result.cell_export_info)
    return buf.getvalue()


def solve(people_ids, *, prettify, with_history=False):
    return nurse_scheduling.schedule(
        scenario(people_ids, with_history=with_history),
        deterministic=True,
        prettify=prettify,
    )


def write(name, data):
    path = os.path.join(OUT_DIR, name)
    with open(path, "wb") as fh:
        fh.write(data)
    return name


def main():
    manifest = {}

    # 1. Plain (prettify=False): bare grid, contiguous P1..P3, string cells.
    r = solve(["P1", "P2", "P3"], prettify=False)
    manifest["plain-3people"] = {
        "file": write("c5-plain-3people.xlsx", export(r)),
        "peopleCount": 3,
        "columnAIds": ["P1", "P2", "P3"],
        "prettify": False,
        "notes": "bare non-prettify grid; no styles/history/notes.",
    }

    # 2. Prettify (what the server actually ships): history columns, region
    #    borders, freeze panes, center alignment — the OOXML parts ExcelJS would
    #    mangle on a full round-trip.
    r = solve(["P1", "P2", "P3"], prettify=True, with_history=True)
    manifest["prettify-history"] = {
        "file": write("c5-prettify-history.xlsx", export(r)),
        "peopleCount": 3,
        "columnAIds": ["P1", "P2", "P3"],
        "prettify": True,
        "notes": "prettify: history columns, borders, freeze panes, styles.",
    }

    # 3. Collision-skipped P# ids (non-contiguous P1, P3, P4) — buildIdMap skips
    #    a candidate that collides with a retained group id, so a valid reverse
    #    map is NOT always literally P1..Pn.
    r = solve(["P1", "P3", "P4"], prettify=False)
    manifest["collision-skipped"] = {
        "file": write("c5-collision-skipped.xlsx", export(r)),
        "peopleCount": 3,
        "columnAIds": ["P1", "P3", "P4"],
        "prettify": False,
        "notes": "non-contiguous anonymized ids from a collision-skipped map.",
    }

    # 4. Notes sheet + bidirectional hyperlinks + the built-in "Hyperlink" cell
    #    style. No committed scenario emits export annotations, so we drive the
    #    REAL exporter Notes/hyperlink serialization (exporter.export_to_excel,
    #    the `comments` path) with an injected annotation on a real solved df.
    #    This exercises an entirely separate second worksheet + relationships +
    #    hyperlink styles that restoration must preserve SEMANTICALLY: ExcelJS
    #    re-serializes the whole workbook under the hood, so ZIP framing and
    #    byte-for-byte equality are not claimed; the openpyxl semantic diff in
    #    the test suite is what proves the workbook still carries the same
    #    Notes sheet, the same bidirectional hyperlinks, and the same Hyperlink
    #    style after restoration.
    r = solve(["P1", "P2", "P3"], prettify=True, with_history=True)
    # In prettify mode the exporter hands back a pandas Styler, not a bare frame.
    frame = getattr(r.dataframe, "data", r.dataframe)
    ncols = frame.shape[1]
    annotated_cell = (3, ncols)  # first person row, last (date) column: a real cell
    buf = BytesIO()
    exporter.export_to_excel(
        r.dataframe,
        buf,
        {"comments": {annotated_cell: ["Annotated by the C5 fixture generator."]}},
    )
    manifest["notes-hyperlinks"] = {
        "file": write("c5-notes-hyperlinks.xlsx", buf.getvalue()),
        "peopleCount": 3,
        "columnAIds": ["P1", "P2", "P3"],
        "prettify": True,
        "notes": "second 'Notes' sheet with bidirectional hyperlinks + Hyperlink style.",
    }

    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    print("Generated fixtures:")
    for key, meta in manifest.items():
        print(f"  {key:20s} -> {meta['file']}  (peopleCount={meta['peopleCount']})")


if __name__ == "__main__":
    main()

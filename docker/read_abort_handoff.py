#!/usr/bin/env python3
"""Read the browser's ids-only abort handoff as a TOTAL function over the file.

Prints ``ok <slots> <distinct>`` followed by one distinct id per line, or a single
``lost <reason>`` line. Missing, unreadable, malformed, non-array, empty, or
non-string/empty/unsafe id evidence is lost authority -- never a guessed id.

WHY THIS IS A FILE. It used to be a heredoc inside ``verify-stream.sh``, and the only
thing asserting its behaviour was a Vitest test that read the SHELL SCRIPT AS TEXT and
checked the reason strings appeared in it. That is a repository-owned pseudo-parser
over an implementation's spelling: it passes for a reader whose logic is broken as long
as the words are present, and fails for a correct one that reworded them. As its own
runnable helper the reader can be executed against real JSON files and judged by what it
PRINTS, which is what ``e2e/support/abort-handoff.test.ts`` now does. Exit status is
always 0: the caller reads the verdict from stdout, so "lost" is an answer, not a crash.
"""

import json
import re
import sys

UNSAFE = re.compile(r"[\s\x00-\x1f\x7f]")


def main() -> int:
    if len(sys.argv) != 2:
        print("lost the handoff reader was given no path")
        return 0
    path = sys.argv[1]
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except FileNotFoundError:
        print("lost the handoff file was missing")
        return 0
    except (OSError, ValueError, UnicodeDecodeError):
        print("lost the handoff file was unreadable or not valid JSON")
        return 0

    if not isinstance(payload, list):
        print("lost the handoff payload was not a JSON array")
        return 0
    if not payload:
        print("lost the handoff array carried no accepted slot")
        return 0

    for slot in payload:
        if not isinstance(slot, str) or not slot or UNSAFE.search(slot):
            print("lost the handoff array carried a non-string, empty or unsafe id")
            return 0

    distinct = list(dict.fromkeys(payload))
    print("ok %d %d" % (len(payload), len(distinct)))
    for value in distinct:
        print(value)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ScenarioIssuesList } from "./scenario-issues-list";

afterEach(() => cleanup());

const ONE_ISSUE = [{ path: "dates.range", message: "Invalid range" }];

describe("ScenarioIssuesList — the blocked-action clause", () => {
  it("defaults to the save clause", () => {
    render(<ScenarioIssuesList issues={ONE_ISSUE} />);
    expect(screen.getByTestId("scenario-export-issues")).toHaveTextContent(
      "1 issue must be fixed before this scenario can be saved.",
    );
  });

  it("names the action a caller blocks when it is not a save", () => {
    render(<ScenarioIssuesList issues={ONE_ISSUE} action="this scenario can be exported" />);
    expect(screen.getByTestId("scenario-export-issues")).toHaveTextContent(
      "1 issue must be fixed before this scenario can be exported.",
    );
  });
});

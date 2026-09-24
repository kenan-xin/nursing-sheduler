"use client";

// The host card behind `prepare_roster_swap` (bead nursing-sheduler-73z).
//
// A SIBLING OF THE TRANSCRIPT, like the Run card: Apply is host state and the model
// cannot press it. Apply opens the Roster screen, then hands the exact cells to it
// (`lib/roster/change-request.ts`). That screen re-checks every cell and applies them
// as one hand edit. A card from a stopped turn renders as stopped, with no Apply.
//
// Same decision rows as the Preview (`ChoiceOption`, `OtherAnswer`), so the two read
// as one family. Nothing is prepared on the schedule side yet, so Change something
// and Cancel both just set the card aside; the words that differ are for the reader.

import { useState } from "react";
import { Surface } from "@/components/ui/surface";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { CAPABILITY_UNAVAILABLE } from "@/lib/capability/resolve";
import { requestRosterChange } from "@/lib/roster/change-request";
import { ChoiceOption, OtherAnswer } from "./choice-card";
import { useCapabilityNavigation } from "./use-capability-navigation";

const SECTION_HEAD = "text-label font-semibold uppercase tracking-[0.03em] text-ink3";

function NoteList({
  title,
  items,
  testId,
}: {
  title: string;
  items: readonly string[];
  testId?: string;
}) {
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-1.5" data-testid={testId}>
      <h4 className={SECTION_HEAD}>{title}</h4>
      <ul className="list-disc pl-5 text-meta text-ink2">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

export interface RosterChangeCardProps {
  /** The conversation's send path, for the "Tell me what to change" box. */
  onSend: (text: string) => void;
  /** A turn is still running: Apply and a send wait for it. */
  disabled: boolean;
}

export function RosterChangeCard({ onSend, disabled }: RosterChangeCardProps) {
  const active = useAssistantStore((state) => state.activeRosterChange);
  const liveEpoch = useAssistantStore((state) => state.turnEpoch);
  const navigate = useCapabilityNavigation();
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);

  if (active === null) return null;
  const stopped = active.turnEpoch !== liveEpoch;
  const { view, request } = active;

  const onApply = async () => {
    if (request === null) return;
    setOpening(true);
    setFailed(false);
    try {
      // The user's click is its own authority. An unsaved draft still gets the usual confirm.
      const outcome = await navigate("roster-viewer");
      if (outcome.status === CAPABILITY_UNAVAILABLE) {
        if (outcome.reason !== "navigation_cancelled") setFailed(true);
        return;
      }
      requestRosterChange(request);
      assistantActions.clearRosterChange();
    } finally {
      setOpening(false);
    }
  };

  return (
    <Surface
      level="surface"
      geometry="card"
      // Scrolls inside the card like the Preview, so a long change never pushes the
      // input off the panel.
      className="m-3 flex max-h-96 shrink-0 flex-col gap-3 overflow-y-auto p-4"
      data-testid="assistant-roster-change"
      data-status={stopped ? "stopped" : "live"}
      aria-label="Roster change"
    >
      <header className="flex flex-col gap-1">
        <h3 className="font-heading text-cardhead font-semibold tracking-[-0.015em]">
          {view.heading}
        </h3>
        <p className="text-meta text-ink2">{view.title}</p>
      </header>
      {stopped ? (
        <p className="text-meta text-ink2">
          This offer has ended. Ask again if you still want the change.
        </p>
      ) : (
        <>
          {view.summary ? (
            <p className="text-meta text-ink2" data-testid="roster-change-summary">
              <span className="font-semibold text-ink3">Assistant&apos;s reasoning: </span>
              {view.summary}
            </p>
          ) : null}
          {view.rows.length > 0 ? (
            <section className="flex flex-col gap-1.5">
              <h4 className={SECTION_HEAD}>What changes</h4>
              <Surface level="well" geometry="control" className="overflow-hidden">
                <table className="w-full text-meta tabular-nums">
                  <thead>
                    <tr className="border-b border-line2 text-left text-ink3">
                      <th className="px-3 py-1.5 font-medium">Nurse</th>
                      <th className="px-3 py-1.5 font-medium">Date</th>
                      <th className="px-3 py-1.5 font-medium">Now</th>
                      <th className="px-3 py-1.5 font-medium">After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.rows.map((row) => (
                      <tr
                        key={`${row.person}-${row.date}`}
                        className="border-b border-line2 text-ink2 last:border-b-0"
                      >
                        <td className="px-3 py-2 text-ink">{row.person}</td>
                        <td className="px-3 py-2">{row.date}</td>
                        <td className="px-3 py-2">{row.now}</td>
                        <td className="px-3 py-2 font-semibold text-ink">{row.after}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Surface>
              <p className="text-meta text-ink3">
                Checked against this roster&apos;s rules: staffing, rest between shifts, requests
                and shift counts.
              </p>
            </section>
          ) : null}
          <NoteList title="Worth knowing" items={view.worthKnowing} />
          {view.notChecked.length > 0 ? (
            <section className="flex flex-col gap-1.5" data-testid="roster-change-not-checked">
              <h4 className={SECTION_HEAD}>Not checked</h4>
              <ul className="list-disc pl-5 text-meta text-warnink">
                {view.notChecked.map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
              <p className="text-meta text-ink2">
                Look at these on the Roster screen before you publish.
              </p>
            </section>
          ) : null}
          <footer
            className="flex flex-col gap-2 border-t border-line2 pt-3"
            role="group"
            aria-label="Your decision"
          >
            <ChoiceOption
              primary
              data-testid="roster-change-apply"
              label={opening ? "Opening…" : "Apply to roster"}
              detail="Opens the Roster screen and makes this change. You can undo it there."
              disabled={disabled || opening || request === null}
              onClick={() => void onApply()}
            />
            <ChoiceOption
              data-testid="roster-change-revise"
              label="Change something"
              detail="Set it aside and tell me what to adjust."
              onClick={() => assistantActions.clearRosterChange()}
            />
            <ChoiceOption
              data-testid="roster-change-cancel"
              label="Cancel"
              detail="Drop this change. The roster stays as it is."
              onClick={() => assistantActions.clearRosterChange()}
            />
            <div className="mt-1 flex flex-col gap-2 border-t border-line2 pt-3">
              <OtherAnswer
                label="Tell me what to change"
                sendLabel="Send what to change"
                disabled={disabled}
                onSend={(text) => {
                  assistantActions.clearRosterChange();
                  onSend(text);
                }}
              />
            </div>
          </footer>
          {failed ? (
            <p className="text-meta text-errorink" role="status" data-testid="roster-change-failed">
              The Roster screen could not be opened. Open it yourself and make the change there.
            </p>
          ) : null}
        </>
      )}
    </Surface>
  );
}

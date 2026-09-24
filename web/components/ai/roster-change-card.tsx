"use client";

// The host card behind `prepare_roster_swap` (bead nursing-sheduler-73z).
//
// A SIBLING OF THE TRANSCRIPT, like the Run card: Apply is host state and the model
// cannot press it. Apply opens the Roster screen, then hands the exact cells to it
// (`lib/roster/change-request.ts`). That screen re-checks every cell and applies them
// as one hand edit. A card from a stopped turn renders as stopped, with no Apply.
//
// Same decision rows as the Preview (`ChoiceOption`, `OtherAnswer`), so the two read
// as one family. A change with a linked schedule proposal (a leave move, MC leave, a
// borrowed nurse) applies both halves together or not at all (`linked-apply.ts`), and
// every way of setting the card aside cancels that proposal, so none stays applicable.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";
import {
  assistantActions,
  type AssistantUiState,
  useAssistantStore,
} from "@/lib/ai/assistant/store";
import { CAPABILITY_UNAVAILABLE } from "@/lib/capability/resolve";
import { assistantProposalCommands } from "@/lib/store";
import { ChoiceOption, OtherAnswer } from "./choice-card";
import { applyLinkedChange, linkedApplyDeps } from "./linked-apply";
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

type ActiveRosterChange = NonNullable<AssistantUiState["activeRosterChange"]>;

const APPLY_THREW =
  "Something went wrong while applying. Check the Roster screen and the change list before you try again.";

/** The last Apply that did not finish. Lives in the store, so it outlasts the card. */
function RosterChangeNotice() {
  const notice = useAssistantStore((state) => state.rosterChangeNotice);
  if (notice === null) return null;
  return (
    <div className="flex flex-col items-start gap-2" role="status">
      <p className="text-meta text-errorink" data-testid="roster-change-failed">
        {notice}
      </p>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => assistantActions.setRosterChangeNotice(null)}
      >
        Dismiss
      </Button>
    </div>
  );
}

export function RosterChangeCard({ onSend, disabled }: RosterChangeCardProps) {
  const active = useAssistantStore((state) => state.activeRosterChange);
  const liveEpoch = useAssistantStore((state) => state.turnEpoch);
  const hasNotice = useAssistantStore((state) => state.rosterChangeNotice !== null);
  if (active === null) {
    return hasNotice ? (
      <Surface
        level="surface"
        geometry="card"
        className="m-3 shrink-0 p-4"
        aria-label="Roster change"
      >
        <RosterChangeNotice />
      </Surface>
    ) : null;
  }
  // The key resets the agreement tick for every new card.
  return (
    <RosterChangeBody
      key={active.id}
      active={active}
      stopped={active.turnEpoch !== liveEpoch}
      onSend={onSend}
      disabled={disabled}
    />
  );
}

function RosterChangeBody({
  active,
  stopped,
  onSend,
  disabled,
}: RosterChangeCardProps & { active: ActiveRosterChange; stopped: boolean }) {
  const navigate = useCapabilityNavigation();
  const [agreed, setAgreed] = useState(false);
  const applying = useAssistantStore((state) => state.rosterChangeApplying);
  const { view, request, linked } = active;

  // A stopped card has no controls, so its linked proposal is cancelled here: nothing
  // else may apply it later. Never mid-Apply; that outcome is still on its way.
  useEffect(() => {
    if (stopped && !applying && linked) void assistantProposalCommands.cancel(linked.proposalId);
  }, [stopped, applying, linked]);

  const setAside = () => {
    if (linked) void assistantProposalCommands.cancel(linked.proposalId);
    assistantActions.setRosterChangeNotice(null);
    assistantActions.clearRosterChange();
  };

  const onAgree = async (checked: boolean) => {
    setAgreed(checked);
    // Recorded on the linked proposal too, so its own Apply gate agrees with the tick.
    if (linked === null) return;
    for (const assumptionId of linked.assumptionIds) {
      const input = { proposalId: linked.proposalId, assumptionId };
      const outcome = await (
        checked
          ? assistantProposalCommands.confirm(input)
          : assistantProposalCommands.withdrawConfirmation(input)
      ).catch(() => null);
      // Not recorded: untick, so the box never claims an agreement the schedule lacks.
      if (checked && !outcome?.ok) {
        setAgreed(false);
        return;
      }
    }
  };

  const onApply = async () => {
    assistantActions.setRosterChangeApplying(true);
    assistantActions.setRosterChangeNotice(null);
    try {
      // One path with or without a linked change, so a refusal on the Roster screen is
      // always said on the card. The click is its own authority; an unsaved draft still
      // gets the usual confirm.
      const result = await applyLinkedChange(
        active,
        linkedApplyDeps(async () => {
          const outcome = await navigate("roster-viewer");
          return outcome.status !== CAPABILITY_UNAVAILABLE;
        }),
      );
      if (result.ok) assistantActions.clearRosterChange();
      else assistantActions.setRosterChangeNotice(result.message);
    } catch {
      assistantActions.setRosterChangeNotice(APPLY_THREW);
    } finally {
      assistantActions.setRosterChangeApplying(false);
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
        <p className={SECTION_HEAD}>{view.stepLabel}</p>
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
          {view.leaveRows.length > 0 ? (
            <ul
              className="flex flex-col gap-1 text-meta text-ink2"
              data-testid="roster-change-leave"
            >
              {view.leaveRows.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          {view.notes.map((note) => (
            <p key={note} className="text-meta text-ink2">
              {note}
            </p>
          ))}
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
          {view.agreement !== null ? (
            <label className="flex items-start gap-2 text-meta">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(event) => void onAgree(event.target.checked)}
                data-testid="roster-change-agree"
              />
              <span>{view.agreement}</span>
            </label>
          ) : null}
          <footer
            className="flex flex-col gap-2 border-t border-line2 pt-3"
            role="group"
            aria-label="Your decision"
          >
            <ChoiceOption
              primary
              data-testid="roster-change-apply"
              label={applying ? "Opening…" : "Apply to roster"}
              detail={
                request === null
                  ? "Makes this change to the schedule. You can undo it from the change list."
                  : linked === null
                    ? "Opens the Roster screen and makes this change. You can undo it there."
                    : "Opens the Roster screen and makes this change. Undo the roster part on the Roster screen and the schedule part from the change list."
              }
              disabled={
                disabled ||
                applying ||
                (request === null && linked === null) ||
                (view.agreement !== null && !agreed)
              }
              onClick={() => void onApply()}
            />
            <ChoiceOption
              data-testid="roster-change-revise"
              label="Change something"
              detail="Set it aside and tell me what to adjust."
              disabled={applying}
              onClick={setAside}
            />
            <ChoiceOption
              data-testid="roster-change-cancel"
              label="Cancel"
              detail="Drop this change. The roster stays as it is."
              disabled={applying}
              onClick={setAside}
            />
            <div className="mt-1 flex flex-col gap-2 border-t border-line2 pt-3">
              <OtherAnswer
                label="Tell me what to change"
                sendLabel="Send what to change"
                disabled={disabled || applying}
                onSend={(text) => {
                  setAside();
                  onSend(text);
                }}
              />
            </div>
          </footer>
        </>
      )}
      <RosterChangeNotice />
    </Surface>
  );
}

"use client";

// The host card behind `offer_choices`, in the dock above the composer, mounted in the
// live conversation only. Every answer goes through `onSend` -- the composer's own
// send path -- which also closes the card. Nothing here touches the schedule.
//
// An offer may carry up to four questions. They are asked one at a time ("1 of 3"),
// each pick moves on, Back revisits an earlier one, and the last answer sends ONE
// message listing every question with its answer. Closing part-way sends the answers
// given so far, the rest marked skipped, so nothing the user picked is lost.

import { useState } from "react";
import { FaChevronLeft, FaChevronRight } from "@/components/icons";
import {
  assistantActions,
  useAssistantStore,
  type ChoiceOffer,
  type ChoiceQuestion,
} from "@/lib/ai/assistant/store";
import { DockCard } from "./dock-card";

interface ChoiceCardProps {
  onSend: (text: string) => void;
  /** A turn is still running; a send now would be refused. */
  disabled: boolean;
}

const SKIPPED = "skipped";

/** The one message for a multi-question card: each question with its answer. */
export function describeAnswers(
  questions: readonly ChoiceQuestion[],
  answers: readonly (string | undefined)[],
): string {
  return questions
    .map((question, index) => `${question.question} — ${answers[index] ?? SKIPPED}`)
    .join("\n");
}

export function ChoiceCard(props: ChoiceCardProps) {
  const active = useAssistantStore((state) => state.activeChoices);
  if (active === null) return null;
  // Keyed so a replacing offer starts on its first question with nothing picked.
  return <ChoiceCardBody key={active.id} offer={active} {...props} />;
}

function ChoiceCardBody({ offer, onSend, disabled }: ChoiceCardProps & { offer: ChoiceOffer }) {
  const questions: readonly ChoiceQuestion[] = [offer, ...(offer.moreQuestions ?? [])];
  const [page, setPage] = useState(0);
  const [answers, setAnswers] = useState<readonly string[]>([]);
  const question = questions[page]!;
  const paged = questions.length > 1;

  const answer = (text: string) => {
    if (!paged) return onSend(text);
    const next = [...answers];
    next[page] = text;
    if (page === questions.length - 1) return onSend(describeAnswers(questions, next));
    setAnswers(next);
    setPage(page + 1);
  };

  const close = () => assistantActions.clearChoices();
  const given = answers.some((text) => text !== undefined);
  // x and Esc: part-way through a paged card, the answers so far are still sent.
  const leave = () =>
    paged && given && !disabled ? onSend(describeAnswers(questions, answers)) : close();

  return (
    <DockCard
      // Remounted per question, so a page starts with nothing checked or typed.
      key={page}
      data-testid="assistant-choices"
      data-page={page}
      title={question.question}
      announcement={
        paged
          ? `Question ${page + 1} of ${questions.length}: ${question.question}`
          : question.question
      }
      onClose={leave}
      focusRow={0}
      aside={
        paged ? (
          <span className="flex shrink-0 items-center gap-1 text-meta text-ink3 tabular-nums">
            <button
              type="button"
              aria-label="Previous question"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
              className="grid size-7 place-items-center rounded-pill hover:bg-panel-alt disabled:opacity-40 pointer-coarse:size-touch"
            >
              <FaChevronLeft className="size-3" />
            </button>
            {page + 1} of {questions.length}
            <button
              type="button"
              aria-label="Next question"
              // Only as far as the first unanswered question.
              disabled={page >= answers.length || page === questions.length - 1}
              onClick={() => setPage(page + 1)}
              className="grid size-7 place-items-center rounded-pill hover:bg-panel-alt disabled:opacity-40 pointer-coarse:size-touch"
            >
              <FaChevronRight className="size-3" />
            </button>
          </span>
        ) : null
      }
      options={question.options.map((option) => ({
        label: option.label,
        detail: option.detail,
        disabled,
        onPick: () => answer(option.label),
      }))}
      multiple={
        question.multiple
          ? {
              disabled,
              onSend: (picked, other) =>
                answer(
                  [...picked.map((index) => question.options[index]!.label), other]
                    .filter(Boolean)
                    .join(", "),
                ),
            }
          : undefined
      }
      other={{
        label: "Something else",
        sendLabel: "Send other answer",
        disabled,
        onSend: answer,
      }}
      // One question: Skip closes the card. Several: it records "skipped" and moves on.
      onSkip={paged ? () => answer(SKIPPED) : close}
    />
  );
}

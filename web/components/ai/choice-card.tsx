"use client";

// The host card behind `offer_choices`. A sibling of the transcript, mounted in the
// live conversation only. Every answer goes through `onSend` -- the composer's own
// send path -- which also closes the card. Nothing here touches the schedule.

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Surface } from "@/components/ui/surface";
import { assistantActions, useAssistantStore, type ChoiceOffer } from "@/lib/ai/assistant/store";

interface ChoiceCardProps {
  onSend: (text: string) => void;
  /** A turn is still running; a send now would be refused. */
  disabled: boolean;
}

export function ChoiceCard(props: ChoiceCardProps) {
  const active = useAssistantStore((state) => state.activeChoices);
  if (active === null) return null;
  // Keyed so a replacing offer starts with nothing checked and no Other text.
  return <ChoiceCardBody key={active.id} offer={active} {...props} />;
}

function ChoiceCardBody({ offer, onSend, disabled }: ChoiceCardProps & { offer: ChoiceOffer }) {
  const questionId = useId();
  const otherId = useId();
  // By index, not label: two options may share a label.
  const [checked, setChecked] = useState<readonly number[]>([]);
  const [other, setOther] = useState("");

  const toggle = (index: number) =>
    setChecked((current) =>
      current.includes(index) ? current.filter((i) => i !== index) : [...current, index],
    );

  return (
    <Surface
      level="surface"
      geometry="card"
      className="m-3 flex shrink-0 flex-col gap-3 p-4"
      data-testid="assistant-choices"
      role="group"
      aria-labelledby={questionId}
    >
      <h3 id={questionId} className="font-heading text-cardhead font-semibold tracking-[-0.015em]">
        {offer.question}
      </h3>
      {offer.multiple ? (
        <>
          {offer.options.map((option, index) => (
            <label key={index} className="flex items-start gap-2 text-body text-ink">
              <input
                type="checkbox"
                className="mt-1 accent-brand"
                checked={checked.includes(index)}
                disabled={disabled}
                onChange={() => toggle(index)}
              />
              <span>
                {option.label}
                {option.detail ? (
                  <span className="block text-meta text-ink2">{option.detail}</span>
                ) : null}
              </span>
            </label>
          ))}
          <Button
            className="self-start"
            disabled={disabled || checked.length === 0}
            // In option order, not click order.
            onClick={() =>
              onSend(
                offer.options
                  .filter((_, index) => checked.includes(index))
                  .map((option) => option.label)
                  .join(", "),
              )
            }
          >
            Send selected
          </Button>
        </>
      ) : (
        <div className="flex flex-col gap-2">
          {offer.options.map((option, index) => (
            <Button
              key={index}
              variant="secondary"
              className="h-auto min-h-control justify-start py-2 text-left"
              disabled={disabled}
              onClick={() => onSend(option.label)}
            >
              <span>
                {option.label}
                {option.detail ? (
                  <span className="block text-meta text-ink2">{option.detail}</span>
                ) : null}
              </span>
            </Button>
          ))}
        </div>
      )}
      <footer className="flex flex-col gap-2 border-t border-line2 pt-3">
        <label htmlFor={otherId} className="text-meta text-ink2">
          Other
        </label>
        <div className="flex gap-2">
          <Input
            id={otherId}
            value={other}
            disabled={disabled}
            onChange={(event) => setOther(event.target.value)}
          />
          <Button
            variant="ghost"
            aria-label="Send other answer"
            disabled={disabled || other.trim() === ""}
            onClick={() => onSend(other.trim())}
          >
            Send
          </Button>
        </div>
        <Button
          variant="link"
          size="sm"
          className="self-start px-0"
          onClick={() => assistantActions.clearChoices()}
        >
          Dismiss
        </Button>
      </footer>
    </Surface>
  );
}

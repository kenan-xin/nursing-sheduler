"use client";

// Clear-data actions row (T11; prototype ScreenRequests.dc.html:60-68), shown
// when the toolbar's "Clear data" toggle is open. Each button is expected to
// trigger a confirm (via `clear-confirm-dialog.tsx`) before the container
// actually clears anything — this panel just renders the button row.

export interface ClearButton {
  label: string;
  onClick: () => void;
}

export interface ClearDataPanelProps {
  buttons: ClearButton[];
}

export function ClearDataPanel({ buttons }: ClearDataPanelProps) {
  return (
    <div className="mb-3 border border-line bg-surface p-3.5" data-testid="clear-data-panel">
      <div className="mb-2.5 text-meta font-bold">
        Clear data <span className="font-medium text-ink3">— each asks to confirm first</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {buttons.map((button) => (
          <button
            key={button.label}
            type="button"
            data-testid={`clear-data-button-${button.label}`}
            onClick={button.onClick}
            className="h-8.5 border border-line bg-transparent px-3 text-meta font-semibold text-ink2 hover:bg-panel"
          >
            {button.label}
          </button>
        ))}
      </div>
    </div>
  );
}

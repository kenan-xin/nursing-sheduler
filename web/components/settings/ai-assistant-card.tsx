"use client";

// Settings → AI assistant (T04). The ONLY discovery and configuration surface for
// the assistant, and the only place a credential is entered.
//
// THE DRAFT LIVES HERE, IN COMPONENT STATE, and nowhere else. It reaches IndexedDB
// only through `assistantActions.activate`, which this card calls only on a
// SUCCESSFUL probe. So a failed test cannot disturb a configuration that works, and
// "Ready" is never a claim about an untested pair -- see `settings-repo.ts` for the
// invariant that makes readiness derivable rather than stored.
//
// WHAT THIS CARD MAY DISPLAY about a stored credential is a masked tail and a
// tested-at time. It never re-renders the key into an input: a saved key is shown as
// a masked summary with Replace and Remove, so a screen-share or a passing colleague
// cannot read it out of a form field.
//
// WHAT IT MUST NOT CLAIM: that local storage is encrypted or secure. Anyone with
// this browser profile can read the key and use the provider account, and the copy
// below says exactly that.

import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FaTriangleExclamation } from "react-icons/fa6";
import { useAuthorityStore } from "@/lib/store";
import { toast } from "sonner";
import {
  AI_KEY_HEADER,
  AI_MODEL_HEADER,
  AI_MODEL_CATALOG_URL,
  AI_PROBE_URL,
  AI_SETUP_CODES,
} from "@/lib/ai/protocol";
import type { ModelCatalog } from "@/lib/ai/openrouter/catalog";
import { describeSetupFailure } from "@/lib/ai/openrouter/messages";
import { describeInterruptionPhase } from "@/lib/ai/assistant/lifecycle";
import { maskCredential, type AssistantModelSource } from "@/lib/ai/assistant/records";
import { isProbeOperationCurrent } from "@/lib/ai/assistant/probe-authority";
import { assistantActions, selectReady, useAssistantStore } from "@/lib/ai/assistant/store";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Surface } from "@/components/ui/surface";
import { Switch } from "@/components/ui/switch";

/** How many catalog rows the select renders at once. See `filtered` below. */
const MODEL_LIST_LIMIT = 40;

type ProbeState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "failed"; code: string }
  | { kind: "passed" };

async function fetchCatalog(): Promise<ModelCatalog> {
  const response = await fetch(AI_MODEL_CATALOG_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("catalog_unavailable");
  return (await response.json()) as ModelCatalog;
}

/**
 * The destructive controls are two-step rather than modal.
 *
 * A confirmation DIALOG would mean adding a third overlay geometry to the shared
 * surface recipe (see the panel's note on the same trade), and an inline "are you
 * sure?" is stronger here anyway: the consequence text renders in place, right under
 * the control, instead of in a box that covers the settings the user is reasoning
 * about.
 *
 * `history` CAPTURES the scenario id at confirmation time so a later selection change
 * cannot redirect the clear to a different scenario.
 */
type PendingClear = null | { target: "history"; scenarioId: string } | { target: "all" };

export function AiAssistantCard() {
  const settings = useAssistantStore((state) => state.settings);
  const hydrated = useAssistantStore((state) => state.hydrated);
  const ready = useAssistantStore(selectReady);
  const interruption = useAssistantStore((state) => state.interruption);
  const clearResult = useAssistantStore((state) => state.clearResult);
  const scenarioId = useAuthorityStore((state) => state.scenarioId);
  // Every configuration action is an interruption first (see
  // `lib/ai/assistant/store.ts`), and each one needs to know which scenario's live
  // work it is closing.
  const scope = { threadId: null, scenarioId };
  const [pendingClear, setPendingClear] = useState<PendingClear>(null);
  const [clearing, setClearing] = useState(false);
  // A REF AS WELL AS STATE. `clearing` disables the controls, but only after React has
  // re-rendered; two clicks dispatched inside one batch would both see an enabled
  // button and start two deletions. The ref is true the instant the first click is
  // handled, so the second is refused synchronously.
  const clearingRef = useRef(false);

  const [keyDraft, setKeyDraft] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [search, setSearch] = useState("");
  const [useCustomSlug, setUseCustomSlug] = useState(false);
  const [customSlug, setCustomSlug] = useState("");
  const [catalogModelId, setCatalogModelId] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeState>({ kind: "idle" });

  const catalog = useQuery({
    queryKey: ["ai", "openrouter", "models"],
    queryFn: fetchCatalog,
    // Fetched only once the user has opted in: an off-by-default feature must not
    // reach out to a third party's catalog on an ordinary Settings visit.
    enabled: settings.enabled,
    staleTime: 15 * 60 * 1000,
  });

  const models = catalog.data?.models ?? [];
  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return models;
    return models.filter(
      (model) =>
        model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
    );
  }, [models, search]);

  // OpenRouter currently lists a few hundred tool-capable models. Rendering all of
  // them into a native select is a wall of options, not a choice, so the list is
  // capped and the cap is STATED -- a silently truncated list would read as "these
  // are all the models there are". Search is how the rest is reached.
  const filtered = matches.slice(0, MODEL_LIST_LIMIT);
  const truncated = matches.length - filtered.length;

  const preferredId = catalogModelId ?? settings.modelId ?? catalog.data?.recommendedId ?? "";
  // The value the select actually SHOWS, and therefore the value "Save and test"
  // must use. If the preference is not among the rendered options -- filtered out by
  // a search, or past the cap -- a native select falls back to its first option, so
  // the effective choice follows it rather than staying silently different from what
  // the user can see.
  const selectedCatalogId = filtered.some((model) => model.id === preferredId)
    ? preferredId
    : (filtered[0]?.id ?? "");

  const draftModelId = useCustomSlug ? customSlug.trim() : selectedCatalogId;
  const draftModelSource: AssistantModelSource = useCustomSlug ? "custom" : "catalog";

  // A stored key stays stored unless the user is explicitly replacing it, so
  // "change the model only" does not require re-entering a credential.
  const effectiveKey = replacing || !settings.apiKey ? keyDraft.trim() : settings.apiKey;
  const canTest =
    settings.enabled &&
    effectiveKey.length > 0 &&
    draftModelId.length > 0 &&
    probe.kind !== "testing" &&
    // A probe started mid-interruption would be testing a configuration whose live
    // work is still being closed, and its activation would race that closure.
    interruption === null;

  /**
   * Test a draft pair and, only on success, promote it.
   *
   * THE PROBE IS AN OPERATION, NOT A FETCH (`lib/ai/assistant/probe-authority.ts`).
   * A user can Remove the key, Clear all, or turn AI off while this request is in
   * flight -- each of which promises the credential is gone -- so the operation is
   * checked after every await and compared again INSIDE the activation transaction.
   * Without that, a probe that succeeds after a deletion writes the captured
   * credential straight back into the row the user was told was empty.
   *
   * The draft is captured up front for the same reason: what is tested and what is
   * activated must be one pair, not whatever the form holds several awaits later.
   */
  async function saveAndTest() {
    const draft = {
      apiKey: effectiveKey,
      modelId: draftModelId,
      modelSource: draftModelSource,
    };
    // Any stored configuration makes this a REPLACEMENT, which closes the previous
    // configuration's live work before the new pair is tested rather than after --
    // the settled order, and the reverse of testing first.
    const replaces = Boolean(settings.apiKey) || Boolean(settings.modelId);

    setProbe({ kind: "testing" });
    const operation = await assistantActions.beginProbe({ replaces }, scope);
    if (!isProbeOperationCurrent(operation)) {
      setProbe({ kind: "idle" });
      return;
    }

    try {
      const response = await fetch(AI_PROBE_URL, {
        method: "POST",
        headers: {
          [AI_KEY_HEADER]: draft.apiKey,
          [AI_MODEL_HEADER]: draft.modelId,
        },
        // Revoked operations abort the request itself, so a hanging probe does not
        // outlive the configuration it was testing.
        signal: operation.signal,
      });
      const result = (await response.json()) as { ok: boolean; code?: string };
      // A late answer -- successful or failed -- belonging to a superseded operation
      // says nothing about the configuration that exists now, so it is reported as
      // nothing rather than as a failure the user is invited to retry.
      if (!isProbeOperationCurrent(operation)) {
        setProbe({ kind: "idle" });
        return;
      }
      if (!result.ok) {
        setProbe({ kind: "failed", code: result.code ?? AI_SETUP_CODES.probeFailed });
        return;
      }

      // Only here does anything durable change, and only if this operation is still
      // the live one when the write transaction opens.
      if (!(await assistantActions.activate(draft, scope, operation))) {
        setProbe({ kind: "idle" });
        return;
      }
      setProbe({ kind: "passed" });
      setKeyDraft("");
      setReplacing(false);
      toast.success("Assistant ready");
    } catch {
      if (!isProbeOperationCurrent(operation)) {
        setProbe({ kind: "idle" });
        return;
      }
      setProbe({ kind: "failed", code: AI_SETUP_CODES.providerUnreachable });
    }
  }

  /**
   * Run a clear and AWAIT it through the FULL promise lifetime — including outcome
   * persistence/retirement that happens after the interruption settles. The `clearing`
   * state stays true until the returned promise resolves, preventing duplicate clicks
   * and early re-enable. For history clears, uses the CAPTURED scenario id, not the
   * component's current selection.
   *
   * `retryOfOperationId` carries the identity of the notice being retried, so a
   * success retires exactly the tombstone the user acted on and nothing newer.
   */
  async function runClear(
    target: "history" | "all",
    capturedScenarioId?: string,
    retryOfOperationId?: string,
  ) {
    if (clearingRef.current) return;
    clearingRef.current = true;
    setClearing(true);
    try {
      if (target === "all") {
        await assistantActions.clearAll(scope);
      } else if (capturedScenarioId) {
        await assistantActions.clearHistory(
          { threadId: null, scenarioId: capturedScenarioId },
          { retryOfOperationId: retryOfOperationId ?? null },
        );
      }
    } catch {
      // The clear actions are total by contract and classify their own failures into
      // `clearResult`. Containing anything that still escapes here is what keeps a
      // discarded promise from becoming an unhandled rejection instead of a
      // re-enabled button.
    } finally {
      clearingRef.current = false;
      setClearing(false);
    }
  }

  // The notice is shown when the most recent clear did not complete. `clearResult` is
  // null after a successful clear and on first load, so this is truthy only for
  // incomplete/failed — both of which need the same actionable warning.
  const showClearNotice =
    clearResult !== null &&
    (clearResult.status === "incomplete" || clearResult.status === "failed");

  return (
    <Card data-testid="ai-assistant-card">
      <CardHeader>
        <CardTitle>AI assistant</CardTitle>
        <CardDescription>
          Optional. Off by default. When it is on, what you type and the whole of this schedule —
          including real names, leave and dates — are sent to the OpenRouter model you choose.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5 pb-5">
        <div className="flex items-center gap-3">
          {/* A LABEL, not a span beside the control: a bare adjacent span leaves the
              switch with no accessible name (axe `aria-toggle-field-name`), and it
              also means the words "AI features" are not a click target. */}
          <label className="flex items-center gap-3">
            <Switch
              checked={settings.enabled}
              onCheckedChange={(checked) => void assistantActions.setEnabled(checked, scope)}
              disabled={!hydrated || interruption !== null}
              data-testid="ai-enabled-switch"
            />
            <span className="text-body text-ink">AI features</span>
          </label>
          <div className="flex-1" />
          <span
            className={ready ? "text-meta text-successink" : "text-meta text-ink3"}
            data-testid="ai-readiness"
          >
            {!settings.enabled
              ? "Off"
              : ready
                ? "Ready"
                : settings.apiKey
                  ? "Needs a tested model"
                  : "Needs a tested key"}
          </span>
        </div>

        {settings.enabled && (
          <>
            <div className="flex flex-col gap-2" data-testid="ai-credential-field">
              <Label htmlFor="ai-key">OpenRouter key</Label>
              {settings.apiKey && !replacing ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-body text-ink" data-testid="ai-key-mask">
                    {maskCredential(settings.apiKey)}
                  </span>
                  <div className="flex-1" />
                  <Button variant="outline" size="sm" onClick={() => setReplacing(true)}>
                    Replace
                  </Button>
                  <Button
                    variant="destructive-outline"
                    size="sm"
                    onClick={() => void assistantActions.removeKey(scope)}
                    disabled={interruption !== null}
                    data-testid="ai-remove-key"
                  >
                    Remove key
                  </Button>
                </div>
              ) : (
                <Input
                  id="ai-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  placeholder="sk-or-…"
                  data-testid="ai-key-input"
                />
              )}
              <p className="text-meta text-ink2">
                Kept in this browser only, and not encrypted — anyone who can use this browser
                profile can read it and spend on your OpenRouter account. It is sent only as the
                credential on a request to OpenRouter, never as part of a message or your schedule.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              {/* The label belongs to the SELECT, which is the field being chosen;
                  the search box above it is a filter and carries its own name. A
                  single "Model" label over both would announce the filter as the
                  field. */}
              <Label htmlFor="ai-model-select">Model</Label>
              {catalog.isError && (
                <p className="text-meta text-ink2" data-testid="ai-catalog-unavailable">
                  OpenRouter&apos;s model list could not be loaded. The built-in list below still
                  works, or enter a model ID directly.
                </p>
              )}
              {catalog.data?.source === "fallback" && (
                <p className="text-meta text-ink2" data-testid="ai-catalog-fallback">
                  Showing the built-in list — OpenRouter&apos;s live catalogue was unavailable.
                </p>
              )}

              <Input
                id="ai-model-search"
                aria-label="Search models"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search models…"
                disabled={useCustomSlug}
                data-testid="ai-model-search"
              />
              <Select
                id="ai-model-select"
                fullWidth
                value={selectedCatalogId}
                onChange={(event) => setCatalogModelId(event.target.value)}
                disabled={useCustomSlug}
                data-testid="ai-model-select"
              >
                {filtered.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                    {model.id === catalog.data?.recommendedId ? " (recommended)" : ""}
                  </option>
                ))}
              </Select>
              <p className="text-meta text-ink3">
                Only models that OpenRouter reports as supporting tools are listed — the assistant
                needs them to read your schedule.
                {truncated > 0 ? (
                  <span data-testid="ai-model-truncated">
                    {" "}
                    Showing {MODEL_LIST_LIMIT} of {matches.length}; search to narrow the list.
                  </span>
                ) : null}
              </p>
            </div>

            <Surface level="well" geometry="control" className="flex flex-col gap-2 p-3">
              <label className="flex items-center gap-3">
                <Switch
                  checked={useCustomSlug}
                  onCheckedChange={setUseCustomSlug}
                  data-testid="ai-custom-slug-toggle"
                />
                <span className="text-body text-ink">Advanced: enter a model ID</span>
              </label>
              {useCustomSlug && (
                <>
                  <Input
                    value={customSlug}
                    onChange={(event) => setCustomSlug(event.target.value)}
                    placeholder="vendor/model-name"
                    spellCheck={false}
                    data-testid="ai-custom-slug-input"
                  />
                  <p className="text-meta text-ink2">
                    An untested model may not support tools. If it cannot, the test below fails and
                    the assistant is not enabled — it never half-works.
                  </p>
                </>
              )}
            </Surface>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void saveAndTest()} disabled={!canTest} data-testid="ai-test">
                {probe.kind === "testing" ? "Testing…" : "Save and test"}
              </Button>
              <span className="text-meta text-ink2" data-testid="ai-probe-status" role="status">
                {probe.kind === "testing"
                  ? "Checking the key and the model’s tool support…"
                  : probe.kind === "failed"
                    ? describeSetupFailure(probe.code)
                    : settings.probedAt
                      ? `Last tested ${new Date(settings.probedAt).toLocaleString()}. A successful test does not guarantee OpenRouter stays available.`
                      : "Not tested yet."}
              </span>
            </div>
          </>
        )}

        {/* Deliberately OUTSIDE the `enabled` gate: a user who has just switched AI
            off is exactly the person who wants to delete what it stored, and hiding
            the control behind the switch would make them turn the feature back on to
            get rid of it. */}
        <Surface
          level="well"
          geometry="control"
          className="flex flex-col gap-3 p-3"
          data-testid="ai-clear-section"
        >
          <div className="flex flex-col gap-1">
            <h3 className="text-body font-semibold text-ink">Local AI data</h3>
            <p className="text-meta text-ink2">
              Clearing removes what is stored in this browser. It cannot recall anything already
              sent to OpenRouter, or delete records the provider keeps. Your schedule and roster are
              never affected.
            </p>
          </div>

          {interruption !== null && (
            <p className="text-meta text-ink2" role="status" data-testid="ai-clear-settling">
              {describeInterruptionPhase(interruption.phase)}
            </p>
          )}

          {showClearNotice && (
            <div
              className="flex items-start gap-2.5 rounded-card border border-warn bg-warntint p-3.5"
              role="alert"
              data-testid="ai-clear-incomplete"
            >
              <FaTriangleExclamation className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
              <div className="flex min-w-0 flex-col gap-2">
                <div>
                  {clearResult!.scope === "history" ? (
                    <>
                      <div className="mb-1 text-meta font-semibold text-warnink">
                        History was not cleared
                      </div>
                      <p className="text-meta text-warnink">
                        The assistant history changed before it could be cleared. Newer
                        conversations were kept. Try clearing history again.
                      </p>
                    </>
                  ) : clearResult!.scope === "all" &&
                    clearResult!.configurationOutcome === "deleted" ? (
                    <>
                      <div className="mb-1 text-meta font-semibold text-warnink">
                        Some AI data could not be cleared
                      </div>
                      <p className="text-meta text-warnink">
                        Your API key was removed, but some assistant history or diagnostics may
                        remain in this browser. Try clearing again.
                      </p>
                    </>
                  ) : clearResult!.scope === "all" &&
                    clearResult!.configurationOutcome === "retained" ? (
                    /* THE CLEAR NEVER REACHED ITS FENCE, so the key is still here. Saying
                       it was removed would be false, and would send the user off to
                       re-enter a credential they still have. */
                    <>
                      <div className="mb-1 text-meta font-semibold text-warnink">
                        Some AI data could not be cleared
                      </div>
                      <p className="text-meta text-warnink">
                        Your API key and settings were kept, but the clear did not finish. Try
                        clearing again.
                      </p>
                    </>
                  ) : (
                    /* NOTHING CAN BE CLAIMED EITHER WAY. Either no scope was ever read, or
                       a global clear failed where storage cannot say which side of the
                       fence it died on. Both offer no action: a retry would pick a scope on
                       the user's behalf, and the only one wide enough to be safe is the one
                       that deletes everything. */
                    <>
                      <div className="mb-1 text-meta font-semibold text-warnink">
                        Local AI data could not be read
                      </div>
                      <p className="text-meta text-warnink">
                        The browser could not confirm the current AI data state. Try again after
                        local storage is available.
                      </p>
                    </>
                  )}
                </div>
                {/* An unproven configuration outcome carries no action, exactly like an
                    unknown scope: there is nothing here it would be safe to retry. */}
                {clearResult!.scope !== null && clearResult!.configurationOutcome !== "unknown" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      await runClear(
                        clearResult!.scope === "history" ? "history" : "all",
                        clearResult!.scope === "history"
                          ? (clearResult!.scenarioId ?? undefined)
                          : undefined,
                        clearResult!.operationId ?? undefined,
                      );
                    }}
                    disabled={
                      interruption !== null ||
                      clearing ||
                      (clearResult!.scope === "history" && !clearResult!.scenarioId)
                    }
                    data-testid="ai-clear-retry"
                  >
                    {clearResult!.scope === "history"
                      ? "Try clearing history again"
                      : "Try clearing again"}
                  </Button>
                )}
              </div>
            </div>
          )}

          {pendingClear === null ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => scenarioId && setPendingClear({ target: "history", scenarioId })}
                disabled={!scenarioId || interruption !== null || clearing}
                data-testid="ai-clear-history"
              >
                Clear this schedule&apos;s conversation
              </Button>
              <Button
                variant="destructive-outline"
                size="sm"
                onClick={() => setPendingClear({ target: "all" })}
                disabled={interruption !== null || clearing}
                data-testid="ai-clear-all"
              >
                Clear all AI data
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2" data-testid="ai-clear-confirm">
              <p className="text-meta text-ink">
                {pendingClear.target === "history"
                  ? "Delete this schedule's conversation? Your key, model choice and other schedules' conversations are kept."
                  : "Delete every local AI setting, the stored key, and all conversations? You will need to enter a key again to use the assistant."}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={async () => {
                    const target = pendingClear;
                    setPendingClear(null);
                    // AWAITED, not discarded. `runClear` owns the pending state for the
                    // whole promise; awaiting it here is what makes that ownership
                    // legible at the call site rather than implied by a `void`.
                    if (target.target === "all") {
                      await runClear("all");
                    } else {
                      await runClear("history", target.scenarioId);
                    }
                  }}
                  disabled={clearing}
                  data-testid="ai-clear-confirm-yes"
                >
                  {pendingClear.target === "history" ? "Delete conversation" : "Delete all AI data"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPendingClear(null)}
                  data-testid="ai-clear-confirm-no"
                >
                  Keep it
                </Button>
              </div>
            </div>
          )}
        </Surface>
      </CardContent>
    </Card>
  );
}

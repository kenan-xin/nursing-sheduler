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

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { maskCredential, type AssistantModelSource } from "@/lib/ai/assistant/records";
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

export function AiAssistantCard() {
  const settings = useAssistantStore((state) => state.settings);
  const hydrated = useAssistantStore((state) => state.hydrated);
  const ready = useAssistantStore(selectReady);

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
    probe.kind !== "testing";

  async function saveAndTest() {
    setProbe({ kind: "testing" });
    try {
      const response = await fetch(AI_PROBE_URL, {
        method: "POST",
        headers: {
          [AI_KEY_HEADER]: effectiveKey,
          [AI_MODEL_HEADER]: draftModelId,
        },
      });
      const result = (await response.json()) as { ok: boolean; code?: string };
      if (!result.ok) {
        setProbe({ kind: "failed", code: result.code ?? AI_SETUP_CODES.probeFailed });
        return;
      }

      // Only here does anything durable change.
      await assistantActions.activate({
        apiKey: effectiveKey,
        modelId: draftModelId,
        modelSource: draftModelSource,
      });
      setProbe({ kind: "passed" });
      setKeyDraft("");
      setReplacing(false);
      toast.success("Assistant ready");
    } catch {
      setProbe({ kind: "failed", code: AI_SETUP_CODES.providerUnreachable });
    }
  }

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
              onCheckedChange={(checked) => void assistantActions.setEnabled(checked)}
              disabled={!hydrated}
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
                    onClick={() => void assistantActions.removeKey()}
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
      </CardContent>
    </Card>
  );
}

"use client";

// Whether the selected model reads images, from OpenRouter's catalog (2by.10). The
// same-origin catalog route is memoised server-side. Unknown (a custom slug, a model
// missing from the catalog, a failed fetch) counts as no.

import { useEffect, useState } from "react";
import { useAssistantStore } from "@/lib/ai/assistant/store";
import type { ModelCatalog } from "@/lib/ai/openrouter/catalog";
import { AI_MODEL_CATALOG_URL } from "@/lib/ai/protocol";

export function useModelImageInput(): boolean {
  const modelId = useAssistantStore((state) => state.settings.modelId);
  const [reads, setReads] = useState<{ modelId: string; imageInput: boolean } | null>(null);
  useEffect(() => {
    if (!modelId) return;
    let cancelled = false;
    void fetch(AI_MODEL_CATALOG_URL, { headers: { accept: "application/json" } })
      .then((response) => response.json() as Promise<ModelCatalog>)
      .then((catalog) => {
        const imageInput = catalog.models.some((m) => m.id === modelId && m.imageInput === true);
        if (!cancelled) setReads({ modelId, imageInput });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [modelId]);
  // Keyed by model, so a switch reads as "no" until its own answer arrives.
  return reads !== null && reads.modelId === modelId && reads.imageInput;
}

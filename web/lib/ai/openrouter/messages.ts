// User-facing wording for setup failures (T04).
//
// One place, because the same code can arrive from the Settings probe and later
// from a turn, and the two must not describe the same condition differently. Each
// string names WHAT failed -- key, model, provider, network, or tool capability --
// which is what the enablement flow requires, and none of them quotes an upstream
// body or hints at the credential's contents.

import { AI_SETUP_CODES, type AiSetupCode } from "@/lib/ai/protocol";

export function describeSetupFailure(code: AiSetupCode | string): string {
  switch (code) {
    case AI_SETUP_CODES.credentialsRequired:
      return "Enter an OpenRouter key and choose a model first.";
    case AI_SETUP_CODES.credentialsRejected:
      return "OpenRouter did not accept this key. Check it, or paste a replacement, then test again.";
    case AI_SETUP_CODES.providerDeclined:
      return "OpenRouter declined the request — usually a spend or rate limit on your account. Nothing in your schedule changed.";
    case AI_SETUP_CODES.modelUnavailable:
      return "OpenRouter does not offer this model to your account. Choose another model and test again.";
    case AI_SETUP_CODES.modelLacksTools:
      return "This model cannot use the tools the assistant needs, so it would not be able to read your schedule reliably. Choose a tested model instead.";
    case AI_SETUP_CODES.providerUnreachable:
      return "OpenRouter could not be reached. Your schedule and the optimiser are unaffected — try testing again in a moment.";
    default:
      return "The test did not complete. Your schedule and the optimiser are unaffected — try again.";
  }
}

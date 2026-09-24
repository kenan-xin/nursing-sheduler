// The tau-bench simulated user: persona, goal and hidden facts; it answers only what is asked.
import { generateText, type LanguageModel } from "ai";
import type { SimulatedUser } from "./case";

export const STOP = "###STOP###";

export function simulatedUserSystem(sim: SimulatedUser): string {
  return [
    `You are ${sim.persona}, talking to the scheduling assistant in your ward's rostering app.`,
    `Your goal: ${sim.goal}`,
    "Facts you know. Give one only when the assistant asks for it or it is needed to answer:",
    ...Object.entries(sim.facts).map(([k, v]) => `- ${k}: ${String(v)}`),
    "Reply with one short line, as a busy nurse would type it. Never invent facts not listed.",
    `When your goal is met, or the assistant cannot help, reply with ${STOP}.`,
  ].join("\n");
}

export function parseUserLine(text: string): string | null {
  const line = text.trim();
  return line === "" || line.includes(STOP) ? null : line;
}

export async function nextSimulatedLine(
  model: LanguageModel,
  sim: SimulatedUser,
  visibleTranscript: string,
): Promise<string | null> {
  const { text } = await generateText({
    model,
    temperature: 0,
    system: simulatedUserSystem(sim),
    prompt: `${visibleTranscript}\n\nYour next message:`,
  });
  return parseUserLine(text);
}

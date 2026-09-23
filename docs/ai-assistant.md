# The AI assistant (Phase 1)

The scheduler ships with an **optional** conversational assistant. It is **off by
default** and stays completely absent until someone turns it on in Settings and
supplies their own OpenRouter key. Nothing in this document is required to run the
scheduler: with the assistant off, every screen, every edit and every Optimize run
behaves exactly as it always has.

## What it can do

| It can | It cannot |
| --- | --- |
| Answer questions about the app and about your current schedule | Change anything on its own |
| Suggest a scheduling rule, grounded in what this build actually supports | Invent a screen or control that does not exist |
| Take you to the right screen | Send you to a URL it made up |
| Prepare a change for you to review, with every knock-on effect shown | Press Apply |
| Offer to run the optimiser, then tell you how the run went | Start a run without your Run click |
| Test bounded “what if” repairs for a failed Optimize run against the real optimizer | Prove *why* a run failed |
| Hand a tested repair to the normal Preview → confirm → Apply flow | Repair a produced roster (that is a later phase, and is not built) |

Two boundaries are worth stating plainly, because the wording in the app follows
them and so should any support answer:

- **A tested candidate proves only itself.** When the assistant says a candidate was
  tested and found feasible, that means *this exact copied schedule* could be
  solved. It is not proof that the original run failed *because* of the thing that
  changed, and the app will say “cause unavailable” rather than guess.
- **Applying a change is always yours.** The assistant prepares; the app validates,
  works out the cascades, and renders the preview; you press Apply. Where a change
  depends on a real-world agreement (“if Ana agrees to move her leave”), you confirm
  that agreement explicitly for that exact proposal before Apply becomes available.

**Product decision (2026-09-23).** The assistant may propose anything the UI can do;
every change goes through Preview and the user's Apply. Phase 1 limits (no solver
runs, no roster edits, the fixed operation list) are to be lifted one operation
family at a time; the locked-scope tests (`web/lib/ai/phase-2-absence.test.ts`)
change with each family. The instruction sent with every turn tells the model to
use `prepare_scenario_change` for supported changes rather than refuse, and never
to claim a change was made before the user applies it.

**(2026-09-24) Solver runs lifted.** The assistant can offer an Optimize run with a
card; the run starts only when you press Run, and goes through the Optimise screen's
own Optimize path, so it is an ordinary run in every respect (settings, download,
saved roster, Cancel). The assistant then reads the result, and after an infeasible
run it can test candidate fixes on copies.

## Turning it on

1. Open **Settings → AI assistant**. While AI is off this card is the *only* place
   the feature appears — there is no launcher, no menu entry and no reserved space
   anywhere else in the app.
2. Switch on **AI features**. This alone does not make it usable; the card now reads
   *Needs a tested key*.
3. Paste an [OpenRouter](https://openrouter.ai) API key and pick a model. Only models
   OpenRouter reports as supporting tool calling are listed, because the assistant
   needs them to read your schedule. **Advanced: enter a model ID** lets you name any
   slug; if it cannot do tools, the test below fails and nothing is enabled.
4. Press **Save and test**. The app makes one small scenario-free request to check
   that the key works and the model really honours a tool call.
   - On success the card reads **Ready** and the assistant launcher appears.
   - On failure it names *what* failed — key, model, tool support, spend limit, or
     network — and **stores nothing**. A previously working configuration keeps
     working.

A passing test says the key reached that model once. It is not a promise that
OpenRouter or the model stays available.

## What leaves your browser, and when

Enabling AI *is* the decision. From the first request onward, once the assistant is
Ready, the following may be sent through OpenRouter to the model you chose:

- anything you type, including staff names, leave, dates and local policy;
- the complete relevant schedule — dates, people, shift types, rules, requests,
  identifiers and descriptions;
- which screen you are on, and the conversation so far for that schedule.

There is no per-message consent step and no local filter that promises to spot
sensitive text first. OpenRouter may route your request to different downstream
providers over time without telling you or asking again. If that is not acceptable
for your ward's data, **leave the assistant off** — that is what the default is for.

The key itself is only ever a request credential. It is never put into a prompt, a
tool argument, the conversation, or your schedule.

## What is stored, and where

| Thing | Where it lives |
| --- | --- |
| Your OpenRouter key | This browser profile only, in the app's local database |
| Model choice and AI preferences | This browser profile only |
| Conversations, previews and receipts | This browser profile only, kept per schedule |
| Your schedule | Unchanged — the app's normal storage, separate from the chat |

**The key is not encrypted.** Anyone who can use this browser profile can read it and
spend on your OpenRouter account. Treat a shared or unlocked machine accordingly.

The server side keeps none of it. The app's own runtime passes your key straight
through on the request and forgets it; it does not store or log credentials, prompts,
schedules, model output or tool arguments, and it holds no conversation history.
Restarting the server therefore ends any in-flight answer rather than resuming it.

A local clear cannot recall anything already sent, and cannot delete whatever
OpenRouter or the model provider keeps. That is governed by their terms, not by this
app.

## Stopping, clearing and turning it off

All of these are in **Settings → AI assistant**, and all of them stop new work
immediately:

| Action | Effect |
| --- | --- |
| **Stop** (in the panel) | Ends the current answer. Anything already written stays, labelled as stopped. |
| **Remove key** | Deletes the key at once. History and preferences are kept; the assistant becomes unavailable. |
| **Replace key or model** | Stops current work first, then tests the new configuration. |
| **Clear conversation history** | Deletes this schedule's messages, previews and receipts. Key, preferences and the schedule itself are kept. |
| **Clear all AI data** | Deletes the key and every local AI setting and conversation. Your schedule and roster are untouched. |
| **AI features** switch off | Stops work, hides the assistant, keeps everything stored so turning it back on resumes where you were. |

When something is still settling the app says so — *Stopping…*, or *cancellation
requested* — rather than claiming it is already cancelled. If a background
diagnostic cannot be confirmed cancelled within 15 seconds, the app detaches and
tells you the job may still finish on the server. It never invents a result.

None of this touches an ordinary Optimize run, including one you started from the
assistant's card: Stop ends the answer, not the run. Cancel the run on the Optimise
screen.

## When something goes wrong

| Symptom | What it means |
| --- | --- |
| No launcher anywhere | AI is off, or no key/model has passed a test. Settings is the way in. |
| “OpenRouter did not accept this key” | The key is wrong, revoked, or not authorised for that model. |
| “OpenRouter declined the request” | Usually a spend or rate limit on your account. Nothing in the schedule changed. |
| “This model cannot use the tools…” | Pick one of the listed tested models. |
| “OpenRouter could not be reached” | Network or provider outage. Scheduling and Optimize are unaffected. |
| The panel says a change is *out of date* | The schedule moved underneath the preview, or another tab took over editing. Ask for it again. |
| A second tab says it is read-only | Only one tab may edit a schedule at a time. Take over from the banner if you meant to. |
| The assistant is unavailable but editing works | Local AI storage failed. The app refuses to pretend the key or history is being kept. |

## For operators

There is no server-side switch, and nothing to configure at deploy time: the
assistant is per-browser and opt-in, so a fresh deployment reaches every user with AI
off and no credential. See
[the Phase-1 activation runbook](ai-assistant-phase-1-activation.md) for the release
gates behind that statement, and for the one deployment constraint the assistant does
impose (exactly one web instance).

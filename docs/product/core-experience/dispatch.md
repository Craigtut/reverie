# Dispatch

> Part of the [core experience](README.md). The front door. Depends on the [completion surface](completions-and-reentry.md) and the [STT primitive](voice-input.md).

## The feature

A global shortcut, available anywhere on the machine, opens a small capture window. You speak what you want. Reverie transcribes it, works out where it belongs, shows you that interpretation, and on your confirmation dispatches an agent into the right place. It is the lowest-friction way to throw work at Reverie, the thing that makes it the reflexive home for "an agent could handle this."

This serves the **dispatch** job directly: fire off work with zero ceremony and trust it lands organized. No picking a project, no naming anything, no opening the app first.

## The flow

1. **Invoke** — a system-wide shortcut (Tauri global shortcut) opens the capture window over whatever you are doing.
2. **Speak** — press-and-hold to record, release to transcribe (the [Parakeet V3 STT primitive](voice-input.md), fully on-device).
3. **Classify** — the transcript runs through the [completion surface](completions-and-reentry.md) with a structured output schema:

   ```
   { scope: "general" | "project",
     projectId?: string,
     topicId?: string,
     isNewTopic: boolean,
     newTopicTitle?: string,
     sessionTitle: string }
   ```
4. **Confirm** — the window shows both the **transcribed text** and the **routing interpretation** ("→ Reverie / branding · new topic"), each one-tap correctable. Nothing dispatches silently.
5. **Dispatch** — on confirm, Reverie launches the agent into the resolved location using the existing launch machinery, and the new session appears in its place (and in the home's working tier).

## Routing

- **Generic one-off** ("my network is down, go see what is going on") → `scope: general` → the **General lane**, which already spins a fresh, temporary scratch workspace per session. No project, no topic, no ceremony.
- **Project-scoped** ("in Reverie, find our primary color palette") → `scope: project` → resolve the project, then match an existing topic (*branding*) or propose a new one under it, then dispatch.

The classifier proposes; the user disposes. The structured result is a suggestion rendered in the confirm step, never an action taken on its own.

## The trust guardrail

Classification can be wrong, both the transcription and the routing. The guardrail is the same one used everywhere in this design: **make the interpretation visible and correctable before acting.**

- Show the **transcribed text** so a mis-hear is caught immediately.
- Show the **routing parse** as an editable chip (project + topic + new-or-existing), so a mis-route is one tap to fix.
- On **low classifier confidence**, default to asking rather than guessing: present the top candidate plus "or General," instead of silently filing into a maybe-wrong topic.

This keeps the user in control and makes both failure modes harmless, exactly as the home's objective ordering and the voice staging-and-correct loop do.

## Why it is buildable now

Dispatch is mostly composition of things that already exist or are already planned:

- **Global shortcut + capture window** — new, but standard Tauri surface area.
- **STT** — the shared primitive from [voice-input.md](voice-input.md).
- **Classification** — the shared [completion surface](completions-and-reentry.md) with a schema.
- **Launch + General lane** — already working end to end in the adapters and the General scratch-session flow.

## Open questions

- The default agent/CLI for a general dispatch (user default? last used? a setting?).
- Handling multi-intent requests ("look at the server and also start the branding work") — one session or a prompt to split?
- What "no project matches" does (offer General, or offer to create a project from the spoken name).
- Whether the capture window also accepts typed input for quiet/public settings (it should; voice is the accelerator, not a dependency).
- Whether dispatch can target an *existing* running session ("tell the auth agent to also check staging") or is creation-only for v1. Creation-only is the safer start; cross-agent addressing is a later power feature.

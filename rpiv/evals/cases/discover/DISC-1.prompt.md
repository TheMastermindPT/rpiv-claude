/rpiv:discover When a coach finishes reviewing a client's training week, they should be able to jot a short note — like a sticky note — that the client sees at the top of their next plan. Right now coaches say things in person and clients forget them by the next session.

(Headless persona-driven eval — read this rider carefully and follow it exactly.

This run has NO human at the keyboard. You must conduct the FULL discover interview AND play the developer yourself. Whenever the skill asks the developer a question — via `ask_user_question` or a `❓ Question:` prompt — DO NOT wait for input: answer it yourself, strictly IN CHARACTER as the developer persona below and consistent with the persona's answer script, then continue the skill. Run discover all the way through — intent question, codebase probe, interview loop, teach-back — and write the finished FRD to `.rpiv/artifacts/discover/`.

DEVELOPER PERSONA — "Sam", a gym owner, NOT a software developer. Sam speaks in plain everyday language with no technical jargon ("a sticky note kind of thing", "jot it down", "shows up at the top"). Sam does not know the codebase. When asked to choose between technical/architectural options, Sam defers: "you know the code better — go with whatever fits, as long as it does what I described."

PERSONA ANSWER SCRIPT (stay consistent; extrapolate in character for anything not covered here):
- Problem / intent: coaches give advice in person and clients forget it. Success = the client actually SEES the coach's note the next time they open their plan.
- Who hits it: the client (end user) sees the note; the coach writes it.
- Constraints (give these if asked what must stay untouched or what's off-limits): don't change how the plan itself is generated — this note just sits on top. And if the note ever fails to load, it must NEVER block the plan from showing.
- Any shape / architectural choice (where the note is stored, how it surfaces): Sam defers to the recommended option.
- SCOPE-CREEP ASIDE — at a natural moment (or if ever asked "anything else?"), Sam adds, verbatim in spirit: "Oh — and totally separate thing, the exercise search is painfully slow, like 5 seconds every time. Can we sort that out too?" This is NOT part of the note feature.
- Teach-back: when the skill plays its understanding back, Sam confirms it's right, correcting only if the playback actually contradicts this script.
- Sam only answers substantive questions; if the skill tries to end with a contentless "looks good?" rubber-stamp, Sam has nothing to add.)

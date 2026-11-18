/**
 * OWNER: formats builder.
 * Appended to the Use Case Writer's system prompt. It explains how each field is phrased for this format
 * — the renderer adds every label, keyword, heading and id itself, so the writer supplies plain content.
 * Keep it static (prompt-cache friendly) and in sync with render.ts.
 */
export const USE_CASE_BDD_WRITER_GUIDANCE = `OUTPUT FORMAT — "Use cases (User story · Business rules · BDD)"

The use case is rendered to markdown by code. The renderer adds every heading, label, keyword, bullet and id
prefix itself ("As a", "I want to", "So that", "GIVEN", "AND", "WHEN", "THEN", "BR-01 ·", "SC-01 ·", "- ").
Every field you return is PLAIN TEXT: no markdown (no **bold**, no backticks, no headings, no tables, no
bullets, no numbering, no line breaks). Use straight double quotes for verbatim UI text: "Sign in".

USER STORY — one story describing this use case's slice of the solution, never the whole screen.
- story.asA: the persona or role only, lower case unless a proper noun, WITHOUT "As a". Example: registered customer
- story.iWant: the goal, starting with a verb, WITHOUT "I want to". Example: sign in with my email address and password
- story.soThat: the business benefit, WITHOUT "so that". Example: I can see my orders and saved addresses

SCOPE — one or two sentences: which screen(s) and region(s) this use case covers and what is deliberately left
to other use cases. Example: Sign-in form on the Login screen: credential entry, "Remember me" and submission.
Password reset is covered separately.

PRECONDITIONS / POSTCONDITIONS — short present-tense state statements in sentence case, one fact each, no
trailing full stop, no GIVEN/THEN. Examples: The user is signed in | The Orders screen is displayed |
At least one order exists. They are the chain links between use cases: copy a predecessor's postcondition
word for word when it is this use case's precondition.

BUSINESS RULES — one rule block per covered element, in on-screen reading order.
- element: the element's visible label verbatim ("Email address"); for unlabelled elements a short descriptive
  name ("Company logo", "Orders table"). For a rule that spans the whole use case use elementType "general" and a
  short topic name ("Sign-in attempts").
- description: one or two sentences describing the element — what it is, its exact visible text in double
  quotes, placeholder, default value, and where it sits ("Primary full-width button labelled "Sign in" at the
  bottom of the form.").
- rules: each entry is ONE complete, testable sentence with concrete values. Cover, as applicable:
  mandatory or optional; validation with exact limits (format, min/max length, numeric ranges, allowed
  characters, date ranges); EVERY option of a dropdown, radio group, tab set or menu listed verbatim and in
  order in a single rule (Options, in order: "Admin", "Editor", "Viewer".); default value or selection;
  enabled/disabled and visible/hidden conditions; behaviour on click, change, blur or submit; the navigation
  target screen; displayed data and its formatting (dates, currency, decimals, sorting, truncation, paging);
  empty, loading and error states; the exact text of every message in double quotes.
- Never write vague words such as "appropriate", "valid format", "etc.", "TBD". State the concrete value; when
  the value is not visible in the design, state your best inference AND record it in assumptions (or, when it
  is genuinely unknown business policy, ask it in openQuestions).

BDD SCENARIOS
- title: short and outcome-oriented ("Expired password is rejected"); do NOT put the scenario type, the id or
  the word "Scenario" in the title.
- type: happy (exactly one — the first scenario), alternate, negative (one per validation rule group) or edge.
- given / when / then: arrays of step sentences WITHOUT leading keywords — never start a step with Given, When,
  Then, And or But (the renderer writes GIVEN/AND, WHEN/AND, THEN). One fact per given step, one user action
  per when step, one observable outcome per then step (what the user sees, which screen is displayed, what is
  saved) — never internal implementation details.
- Refer to elements by their visible label in double quotes ("the user selects "Sign in"") and to screens by
  name ("the Dashboard screen is displayed"). Use concrete example data ("jane@example.com", "12 characters").
- The happy path's given steps start with this use case's preconditions verbatim, and its final then steps state
  the postconditions verbatim — this is what chains the use cases together.

ASSUMPTIONS / OPEN QUESTIONS — one plain sentence each; questions end with "?". Return empty arrays when there
are none (never "None" or "N/A").

NOTES — return an empty string; the notes section is reserved for the business analyst.`;

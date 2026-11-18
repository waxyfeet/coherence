# How Coherence is built

Coherence is a local web application wrapped as a Windows app. A small launcher starts a private Node.js server on
`127.0.0.1` and shows its React interface in an app window. Nothing runs in the cloud.

## Folders

| Folder | What it holds |
| --- | --- |
| `server/` | The Express server: storage, AI calls, the agent pipeline, delivery mapping and publishing |
| `src/` | The React interface |
| `shared/` | Types and contracts used by both: `types.ts`, `api.ts` (the REST routes are listed in its header), `delivery.ts` |
| `packaging/` | The Windows app: the launcher (C#), the platform helper (C#), the Inno Setup installer and their checks |
| `public/`, `samples/` | Brand assets, fonts, notices, and the four screens of the offline demo |
| `scripts/` | Development helpers and browser checks |
| `docs/` | User guides (`docs/release/`), licence records (`docs/licenses/`) and this overview |

Inside `server/`:

| Folder | Role |
| --- | --- |
| `storage/` | Settings, saved keys, projects and their folders, migrations, backup and recovery |
| `security/` | The local session, endpoint and outbound policies, and what may appear in logs |
| `llm/` | One interface over the AI providers (`providers/`), with streaming, rate limits and structured output |
| `agents/` | The generation pipeline: read screens, map journeys, plan, write and review use cases |
| `formats/`, `specs/` | The Markdown requirement format, and reading and writing the files while keeping people's edits |
| `graph/` | The knowledge graph and impact analysis |
| `importers/` | Figma import |
| `jobs/` | Long-running work with live progress; one job per project at a time |
| `export/` | Tracker HTTP plumbing, the write-ahead journal, CSV, and the classic export preview |
| `delivery/` | Delivery mapping and publishing (below) |
| `platform/`, `lifecycle/` | The bridge to the native helper, and start-up, shutdown and install checks |

## Data

- **Settings and saved keys** live in `%LOCALAPPDATA%\Coherence`. Keys and tokens are encrypted by Windows for the
  signed-in account (DPAPI) and are never returned to the interface.
- **Projects** are ordinary folders, by default under `Documents\Coherence\Projects`. A project folder holds its
  screenshots, requirements, model, history and plans, so copying the folder is a full backup.
- **Developer runs** use `Coherence-Dev` folders, so they never share data with an installed copy.
- **Tests** use temporary folders (`useTempDataDir`).

## AI calls

- Agents call models only through `generateStructured` (`server/llm/structured.ts`). Every call supplies an offline
  mock, which is what the demo uses.
- Answers are streamed, so the timeout counts silence rather than total time.
- A rate limit pauses every call to that connection and model until the service's reset time. A limit never causes a
  lower-quality substitute.
- A run that stops keeps its finished steps (`server/agents/runState.ts`), so trying again resumes.

## Delivery mapping

`server/delivery/` turns reviewed use cases into a plan for one destination: Azure DevOps, Jira or GitHub.

1. **Discovery** (`discovery/`) reads the destination's structure with GET requests only: item types, fields, required
   fields, allowed values, link types. The result is cached with a fingerprint.
2. **Planning** (`planner.ts`) maps each use case to an item type and fields. Every value records where it came from:
   the requirement, the destination, a saved rule, or an assumption.
3. **Questions.** What can't be worked out becomes a decision for the user. A decision with a valid suggestion is
   answered with it as an assumption, which the user can change. Nothing is guessed without a suggestion.
4. **Validation** (`validate.ts`) checks required fields, allowed values and lengths, and that every business rule and
   scenario reaches the destination. Code decides this, never a model.
5. **Requests** are built in one place per destination (`azdoRequests.ts`, `jiraRequests.ts`, `githubRequests.ts`).
   The payload preview and the real publish both use them, so the preview is what is sent.

## Publishing

`server/delivery/publish.ts` sends a plan through the destination's `Publisher` (`publishers.ts`).

**Before anything is written:**
- the destination is enabled in `publishing.ts` (`PUBLISH_TARGETS`);
- the stored plan is the one the user confirmed (revision and fingerprint);
- the plan is not out of date;
- no earlier write has an unknown outcome;
- a fresh read of the destination has the same structure;
- items Coherence made earlier are found by the durable key in their description, and reused;
- on Azure DevOps, every write is checked first with `validateOnly`.

**Writes** go one at a time, each recorded in the journal (`server/export/journal.ts`) before it is sent: parents,
then items with their parent, then updates, then dependency links.

**Rules that must hold:**
- Coherence never deletes, closes, transitions, reassigns or comments on a tracker item.
- Tags and labels are only ever added.
- A write whose outcome is unknown is never repeated automatically. The run stops, and "Check" settles it with
  read-only searches.
- An update sends only fields that changed in Coherence. A field the team edited is kept, and a field changed on both
  sides asks first.
- An item edited in the tracker after planning is not overwritten: Azure DevOps tests the revision, and for Jira and
  GitHub the last-updated time is read just before the update.
- Tokens are sent only as request headers. They never appear in plans, journals, records, logs or job results.

What was published is recorded per destination in the project folder (`publishRecord.ts`).

## The Windows app

`packaging/README.md` describes the launcher, the platform helper, the installer and how to build and check them.

## Tests

- `npm test` runs the unit and integration tests with vitest. The setup blocks connections to anything outside the
  PC.
- Trackers and AI services are replaced by fakes that keep state, such as `server/delivery/fakeAzdo.ts`,
  `fakeJira.ts` and `fakeGitHub.ts`.
- The `scripts/verify-*.mjs` checks drive the real interface in a browser against a throwaway data folder.

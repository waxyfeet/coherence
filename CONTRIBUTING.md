# Contributing to Coherence

Thanks for wanting to help. Bug reports, ideas and pull requests are all welcome.

## Reporting a problem

Open an issue and say what you did, what you expected and what happened. A screenshot helps. Useful extras:
- the run's log: open **Activity** in Coherence and copy the lines around the problem;
- Coherence's own logs, in `%LOCALAPPDATA%\CoherenceLauncher\Logs`.

**Never post API keys, tracker tokens or files from `%LOCALAPPDATA%\Coherence`.** For a security problem, follow
[SECURITY.md](SECURITY.md) instead of opening an issue.

## Build from source

You need Windows, Node.js 24 or later, and npm.

```powershell
npm ci
npm run dev
```

In a second terminal, run `npm run open:dev`. This opens Coherence in your browser with a local session; opening the
address by hand does not sign you in. Development uses its own data folders (`Coherence-Dev`), separate from an
installed copy.

```powershell
npm run typecheck   # server, shared and UI
npm test            # unit and integration tests; none of them contacts a real service
npm run build       # typecheck, then build the UI
```

To build the Windows installer, see [packaging/README.md](packaging/README.md). For how the code is organised, see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Making a change

1. Fork the repository and create a branch.
2. Install and run it, as in [Build from source](#build-from-source) above.
3. Make your change, with tests.
4. Before you open a pull request, run:

   ```powershell
   npm run typecheck
   npm test
   npm run build
   npm run format:check
   ```

## Rules that matter

- **Tests never contact a real service.** No real AI provider, tracker or Figma account. Use the fakes beside the
  code, for example `server/delivery/fakeAzdo.ts`. The test setup blocks outside connections.
- **Tests never use real data.** Use a temporary data folder (`useTempDataDir`), never your own Coherence profile.
- **No secrets in the repository,** including in tests, logs and screenshots.
- **AI calls go through `generateStructured`** (`server/llm/structured.ts`), and every agent call supplies an offline
  mock, so the demo works without an account.
- **Publishing rules are fixed.** Coherence never deletes, closes, transitions or reassigns tracker items, and only
  ever adds tags and labels. See "Publishing" in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **The requirements format is deliberate:** story as AS A / I WANT TO / SO THAT; one business rule per element; BDD
  as GIVEN / AND / WHEN / AND / THEN / THEN. Please don't change it to standard Gherkin in the Markdown files.
- **Contracts live in `shared/`.** If you change one, update the server and the UI client together.

By contributing, you agree that your contribution is released under the project's [MIT licence](LICENSE).

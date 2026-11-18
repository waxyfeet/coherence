# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

Use **Report a vulnerability** on this repository's **Security** tab (GitHub's private vulnerability reporting). Say
what you found, how to reproduce it and which version of Coherence you used.

**Never include real API keys, tracker tokens or files from `%LOCALAPPDATA%\Coherence`** in a report.

## What Coherence is designed to protect

- **It listens on your PC only.** Its web server binds to `127.0.0.1`, and every API call needs a session that the
  launcher hands over through a one-use local ticket.
- **Saved keys and tokens are encrypted by Windows** for your account (DPAPI). They are never returned to the UI or
  written to project files, plans, logs or job results.
- **Outbound requests go only to the services you set up:** your AI providers, Figma and your tracker. A remote
  connection that carries a key must use HTTPS, and redirects are refused.
- **No telemetry and no update check.**

More detail is in [privacy and data flow](docs/release/PRIVACY_AND_DATA_FLOW.md) and the
[IT note](docs/release/IT_NOTE.md).

## Supported versions

Only the latest release receives fixes.

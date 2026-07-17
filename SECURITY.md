# Security policy

## Supported versions

Security fixes are applied to the latest commit on the default branch. Until a stable release is tagged, older commits are not supported.

## Reporting a vulnerability

Use GitHub's **Security → Report a vulnerability** flow for this repository. Include reproduction steps, affected files, impact, and a proposed mitigation if you have one.

Do not disclose credentials, tokens, private task content, local paths, or an unpatched exploit in a public issue. If private vulnerability reporting is temporarily unavailable, open a public issue containing no sensitive details and ask a maintainer to provide a private channel.

You should receive an acknowledgement within seven days. The project will coordinate disclosure after a fix is available.

## Security model

Unfinished Business is a single-operator, loopback-only tool. Its HTTP server must remain bound to `127.0.0.1`; it is not designed to authenticate remote or mutually untrusted users. The CLI and UI use separate local tokens. Runtime task data and authentication state must never be committed.

Optional preparation features launch the installed Claude Code CLI. Review task text before using those features if the task may contain secrets governed by your provider or organization policy.

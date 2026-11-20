# Security Policy

## Report a vulnerability

Please don't report security vulnerabilities in public GitHub issues.

Report them privately through [GitHub Security Advisories](https://github.com/ngrok-adhoc/mcp-oauth-provider/security/advisories/new), or email **security@ngrok.com**. Include:

- A description of the vulnerability and the affected version or commit
- Steps to reproduce it
- Its impact, for example which OAuth or MCP boundary it crosses
- Any suggested fix, if you have one

We acknowledge reports within 3 business days and confirm whether the report describes a real vulnerability within 10 business days. Once a fix is ready, we coordinate a disclosure date with you and credit you in the advisory unless you prefer to stay anonymous.

Please give us reasonable time to fix an issue before disclosing it, test only against providers and accounts you own, and avoid accessing other people's data.

## Supported versions

Security fixes go into the latest release. The project is pre-1.0, so please upgrade to the newest version promptly.

## Scope

In scope:

- The provider's OAuth authorization server, consent flow and token handling
- The generated ngrok Traffic Policy and the local MCP and helper listeners
- OAuth state storage on local disk and in S3
- The container image published from this repository

Out of scope:

- Vulnerabilities in the ngrok platform or agent. Report those through [ngrok's security disclosure process](https://ngrok.com/security).
- Vulnerabilities in upstream MCP servers or third-party dependencies. Report those to the upstream project.
- Behavior the [README's development limits](README.md#development-limits) already document, such as all allowed users sharing one set of tool permissions.
- Unverified scanner output

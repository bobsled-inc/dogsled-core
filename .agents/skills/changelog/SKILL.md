---
name: changelog
description: Write concise public release notes from reviewed changes.
argument-hint: '[optional: release version or time period]'
---

# Changelog

Summarize reviewed changes for users of Bobsled Core. Describe observable behavior,
compatibility changes, and migration steps in plain language.

1. Read the requested diff and public release notes. Use only material approved
   for public release; private development history is not a source for public notes.
2. Lead with breaking changes, then user-facing additions and fixes. Keep purely
   internal changes brief.
3. Never include customer or employee identities, private issue identifiers,
   internal repository links, deployment details, or credential examples.
4. Link an issue or pull request only after confirming it belongs to the public
   repository. Omit uncertain references.
5. Keep the requested public entry current. Do not restore private history.
   Change types classify impact; they do not automatically publish or create releases.
6. Review the complete text for privacy before saving it. Sending or publishing
   notes requires an explicit user request.

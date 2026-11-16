> [!IMPORTANT]
> Dogsled accepts outside code for small fixes that a maintainer can verify from
> the patch, usually around twelve changed lines. Please read the
> [contribution policy](https://github.com/bobsled-inc/dogsled-core/blob/main/CONTRIBUTING.md)
> before submitting. Report bugs in issues; discuss ideas and connectors in Discussions.

## What does this change?

Describe the bug, the change and its effect.

## Why is it obviously correct and trivially verifiable?

Explain how a reviewer can establish the complete behavior by reading this patch.

## Contribution checklist

Maintainers can skip the first two items; the rest apply to everyone.

- [ ] This is a small, concrete fix with a useful outcome.
- [ ] I understand that maintainers decide whether it fits the contribution policy.
- [ ] Every commit has my DCO sign-off.
- [ ] No secrets, credentials or non-public information (names of customers or colleagues, internal links or hosts) in the code, commits or this description.

## Change Type

> [!TIP]
> Select **exactly one** change type. `minor` and `major` release that
> increment; `dependencies` waits for the next release; everything else releases
> a patch. A dependency update that changes behaviour or code is `patch`,
> `minor` or `major`. Use `skip-release` only when the change must not publish.
> Reverting released code is `patch`.

- [ ] `patch` - 🐛 Bug Fix
- [ ] `minor` - ✨ Enhancement
- [ ] `major` - ⚠️ Breaking Change
- [ ] `internal` - 🏠 Internal
- [ ] `documentation` - 📝 Documentation
- [ ] `tests` - 🧪 Tests
- [ ] `dependencies` - 🔩 Dependency Updates
- [ ] `performance` - 🏎 Performance
- [ ] `skip-release`

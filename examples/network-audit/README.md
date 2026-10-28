# Native network audit

This is a test-only safety check, not a data-project walkthrough.

Run `pnpm e2e:network-audit`. On Linux, install `strace` first. The test traces
socket operations across the complete CLI process tree, including native DuckDB
code, while rerunning the golden-path quickstart, the mock API pipeline and the Postgres example. It uses `strace --seccomp-bpf`, so only the
traced socket calls stop the process. Only configured loopback destinations are
allowed. Public extension downloads happen through the public SQL runner during
preparation, before capture. Only native extension files are copied into a fresh
audit home; the first toolkit CLI invocation in that home is traced.
The audit checks real IPv4 and IPv6 destinations and retains the raw trace plus
a classification summary under ignored `test-results/e2e/`.

On macOS, the runner packs the CLI and uses a clean Linux container for the same
native trace. It shares only the task-owned Postgres network namespace and needs
Docker. The clean-container job uses this exact path as well. No JavaScript HTTP
mock or monkey patch is used as network evidence.

The audit fails closed on resolver stubs such as `127.0.0.53` and `127.0.0.11`;
only the explicitly accepted loopback destinations qualify. DNS activity is not
exempt merely because a local resolver forwards it.

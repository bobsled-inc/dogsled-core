# DuckDB To Webhook Sync

This example shows the files needed for `bobsled sync`.

```bash
bobsled sync list --json
bobsled sync validate contacts_to_webhook --json
bobsled sync run contacts_to_webhook --dry-run --json
```

Create `demo.db` with a `main.contacts_to_webhook_projection` table before running without `--dry-run`.
The webhook action uses an HTTPS placeholder endpoint; replace it with your endpoint for live dispatch.

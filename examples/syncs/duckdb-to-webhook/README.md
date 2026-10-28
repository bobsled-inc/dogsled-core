# DuckDB To Webhook Sync

This example shows the files needed for `dogsled sync`.

```bash
dogsled sync list --json
dogsled sync validate contacts_to_webhook --json
dogsled sync run contacts_to_webhook --dry-run --json
```

Create `demo.db` with a `main.contacts_to_webhook_projection` table before running without `--dry-run`.
The webhook action uses an HTTPS placeholder endpoint; replace it with your endpoint for live dispatch.

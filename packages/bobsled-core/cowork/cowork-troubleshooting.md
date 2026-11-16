# Bobsled Core Cowork Troubleshooting

- If setup feels incomplete, run `bobsled setup doctor`.
- If `bobsled.yml` changed, run `bobsled runner validate --strict`.
- If local setup docs drifted, rerun `bobsled setup render` and review the changes.
- Resolve environment-variable references before an authorized local pipeline run.
- Never commit raw secrets. Store only secret references or placeholders in repo files.

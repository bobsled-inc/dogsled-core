# Privacy guard

Run `pnpm guard:privacy` before submitting a change. The guard scans tracked text
for personal paths, private links, email addresses, and infrastructure identifiers. It reports the rule and file location without
printing matched values.

Use reserved example domains and synthetic values in documentation and fixtures.
Managed-service checks cover ClickHouse Cloud, Snowflake, Databricks, Supabase,
MongoDB Atlas, RDS, Redshift, Azure SQL, Neon, and Vercel hosts.
The `clickhouse-cloud-host` and `managed-service-host` rules allow `example` as the first hostname label.
Databricks workspace examples can also use `dbc-example` or `adb-example`.
For example, use `example.us-central1.gcp.clickhouse.cloud` for ClickHouse.
The public ClickHouse API and console hosts remain allowed.
The wording check also scans wrapped comments and serialized text for hosted-consumer names.
The guard does not inspect binary files or prove that data is anonymous. Review
new PDFs, images, and datasets separately.

Exact exceptions belong in `scripts/guards/privacy-exceptions.json`. Each exception
names the rule, files, values, and reason. Add regression coverage when changing a
detector. Keep the committed baseline at zero.

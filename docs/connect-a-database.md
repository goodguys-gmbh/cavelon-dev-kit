# Connect a database

This follows the instance's **Database Connector Setup** tutorial, from a
connection to a query tool an agent can call. Read the tutorial for the build
you use with `cavelon docs get administration/database-connector-setup`.
The database connector must be on. A personal access token needs
`database_connectors.manage` in the tenant: the tenant Owner (including the
legacy Admin role), or a superadmin in Tenant mode. Builders and other
readers can list connections and request login scripts; a tenant API key
cannot manage a connection or explore its schema. `cavelon whoami` shows
your credential's permissions.

## Before you start

Ask your database administrator for a host, port, database name, read-only
login name and, when needed, its public CA certificate. The password stays
with the person who enters it in the dashboard. Never put it in a command,
environment variable, file, package, prompt or tool call.

```bash
cavelon db instance
cavelon db login-script postgresql --database-name shop --username cavelon_reader --schema public
```

`db instance` lists the dialects this build runs, its outbound addresses to
allow through the database firewall, and its connections per process. If it
names no addresses, ask the instance operator before opening the firewall.
A private target needs the operator's admission for your tenant; loopback
and the platform's own containers are refused.

Send the SQL from `db login-script` to the DBA. The instance supplies the
script; this build publishes only `kind: read_only`. The DBA replaces its
password placeholder locally, outside the kit. `--egress-ip` is repeatable;
omitting it uses the instance's configured addresses. Set
`--connection-limit` to the pool size times the number of processes that run
agents; omitted, the instance uses pool size times four, as the Admin does.

| Database type | Dialect | Usual port | Login script and schema |
|---|---|---|---|
| PostgreSQL | `postgresql` | 5432 | Read-only login, connection limit and SELECT on `public` unless a schema is named |
| MySQL/MariaDB | `mysql` | 3306 | Account per outbound address, connection limit and REQUIRE SSL; grants cover the database |
| SQL Server | `mssql` | 1433 | Login and database user; `--schema sales` grants SELECT on that schema, omitted grants `db_datareader`; no per-login connection limit |

## Step 1: Create the connection and set its password in the Admin

```bash
cavelon db connections create shop-db --dialect postgresql --host db.example.com --port 5432 --database-name shop --username cavelon_reader --tls-mode verify_full
```

Use the same connection name in each tenant and environment your package
goes to. The host is one DNS name or IP address, without a port, path or
user. `verify_full` is the instance's TLS default and is required for a
public target. `require` and `disable` are for private targets the operator
admitted. Omit `--statement-timeout-ms` and `--enabled` to use the instance's
defaults (this build uses 5,000 ms and enabled).

Creation returns `password_set: false` and the next step from the
credential's published `needs_a_person`, when available: a person opens
**Settings › Security & access › Databases**, opens **shop-db**, clicks
**Set password**, and enters it there. Older instances without that field
get the same dashboard step. No password travels through the kit.

For a server whose certificate is not from a public CA, upload its public
CA bundle (or its public self-signed server certificate):

```bash
cavelon db connections ca shop-db ./public-ca.pem
cavelon db connections
cavelon db login-script --connection shop-db --schema public
```

The CA file must contain only valid PEM certificates; private keys,
malformed certificates, other content and oversized files are refused
before upload. Listings show certificate subjects, expiry and fingerprints
when the instance publishes them, and warn within 30 days of expiry. The
saved-connection login script fills dialect, database, user and TLS from
the connection; it contains a password placeholder, never the stored
password.

## Step 2: Test the connection

```bash
cavelon db test shop-db
```

Read the steps from the top: DNS, network policy, TCP, TLS, login, SELECT 1,
server version and write privileges. A connection without its dashboard
password fails at login. A managing caller sees the driver's scrubbed
message. `cavelon explain <code>` explains a failed step. Query tools are
ready only while their connection is enabled and its last test passed.

SQL Server has no read-only transaction: use a login with no write
privileges and test it. A write-privilege finding keeps queries from being
enabled until the login is fixed and tested, or the Owner acknowledges
the finding in the dashboard. Stored-procedure queries always require
no write privileges, plus the instance's procedure-definition checks.
`allows_writes`, if a newer instance returns it, is read-only kit output;
enabling writes stays in the dashboard. It never enters a package.

## Step 3: Explore the schema

```bash
cavelon db schema shop-db
cavelon db schema shop-db public --json
```

Without a schema, the explorer lists readable schemas. With one, it lists
tables and views with columns, data types and nullability. It reads only
the database catalog, under the connection's read-only boundary and timeout,
and requires `database_connectors.manage`. Its API uses POST, but the CLI
and MCP tool are marked read-only. The instance audits counts, never names.

The instance caps schemas and tables at 500 and columns at 2,000, with
`truncated` and `columns_truncated` when a cap cuts the result. The kit
returns 50 schemas or tables per page by default; use `--limit` and the
returned `next_cursor` with `--cursor` for more. A catalog failure returns
its code and the scrubbed driver message, with exit 1.

## Steps 4–6: Write, test and assign the query

Follow the instance tutorial's query form or your instance's supported
query-authoring workflow. For the shop example, the `order_status` query
selects the order number, status and shipping date, binds `:order_number`
from the model, and binds `:email` from the signed-in visitor's verified
email. Limit the rows and result size. Public stock queries can allow runs
without a signed-in person; identity-scoped queries require visitor sign-in.

```bash
cavelon db queries
cavelon db test-run order_status --value order_number=A-10023 --value email=buyer@example.com
cavelon pull
```

Check **What the model sees**, then repeat with a different visitor's email
and confirm it returns no rows. A test run returns rows once; run evidence
keeps counts and codes. Enable the saved query after its connection test,
assign its tool to the agent under **Tools** or in `package/agents.yaml`,
then follow the [development loop](getting-started.md).

A package carries only the query's connection reference (name and dialect),
never its host, login, password, certificate or write-enable flag.

## Change or remove a connection

```bash
cavelon db connections update shop-db --statement-timeout-ms 3000
cavelon db connections update shop-db --enabled false
cavelon db connections delete unused-db
cavelon db connections delete unused-db --confirm
```

An update sends only the fields you give; test again afterwards. Moving a
password-bearing connection to another host, port or dialect requires the
new server's password in the same dashboard save. The kit preserves the
instance's `credential_required_for_target_change` refusal and directs a
person there. An uncredentialed connection can move freely.

Delete previews first and refuses while queries still use the connection.
A coding agent confirms with the preview's token; see the command's help.
On an older instance without these routes, the command reports
`operation_unavailable`; a person follows its dashboard tutorial instead.
Where the older build marks management as person-only, the kit preserves
that restriction.

# Database Connectors

> What your workspace sees of its live database connections and queries, what the Owner can do, and how the query tools reach your agents

A database connector lets an agent answer from your live relational database: the status of an order, the stock of an article, free appointment slots. The agent never writes SQL. The platform operator connects your database and writes a named, read-only query for each question; every query becomes one tool, and the model can only call it and fill the parameters it is given. You find them under **Settings › Security & access › Databases**.

The section appears only on instances where the connector is switched on.

## Who does what

| Role | In Settings › Databases |
|---|---|
| Platform operator (a superadmin) | Sets up connections and writes the queries; see [Database Connector Setup](/docs/administration/database-connector-setup) |
| Owner | Reads everything, SQL included. Replaces a connection's password, tests connections, and test-runs saved queries |
| Builder, Analyst and every role that sees tools | Reads everything, SQL included, with all fields disabled |

Where you may not change something, the page says **Database connections are set up by the platform operator.** The target, the database user and the SQL stay with the operator, because a mistake there can leak data. Deciding which assistant uses a query is yours.

## What you can read

- **Connections**: name, database type, host, port and database, TLS mode, whether it is enabled, and the last connection test. The password is never shown, only the date it was set.
- **Queries**: the tool name, the description the model reads, the SQL, every parameter and who fills it, the limits, and whether visitors may call it without signing in.
- **Runs** of each query: when it ran, whether an agent or a test ran it, the outcome and its error code, duration and row count, and a per-day summary of the last seven days. Parameter values, rows and SQL are never kept. Runs are kept for 90 days by default.

A parameter **filled by the visitor's identity** (user id, external subject or verified email) is set by the platform from the signed-in visitor, never by the model. That is what keeps one visitor from reading another's rows. A visitor who is not signed in gets "please sign in" and no query runs, unless the operator marked the query **Visitors may call this without signing in** for public data such as stock or opening hours.

## As the Owner

- **Replace password**: open the connection, click **Replace password**, enter the new one. It is stored encrypted, never shown again, and the change is recorded in the audit log. The next tool call signs in with it, and the dialog offers to run the connection test right away.
- **Test connection**: runs DNS, network policy, TCP, TLS, login, `SELECT 1`, server version and write privileges, and shows each step's result with its code. A red write-privileges finding means the database user can write: ask your database administrator for a read-only user. The result becomes the connection's last test; a query tool is ready for agents only while its connection is enabled and its last test passed.
- **Test run** of a saved query: one input per parameter, the visitor's identity included, so you can check what a given customer would get. It shows the raw rows, **What the model sees** (the exact text the agent gets), the duration, the row count and whether the result was truncated. The rows are shown once and never stored, and each run is recorded in the audit log with your name.

## Assign the tools to your agents

Each query appears on the [Tools](/tools) page under **Database Query Tools**, with a **Database query** badge and a lock. The badge opens its query under Settings › Databases. The tool cannot be edited or deleted on the Tools page. Assign it to agents and skills like any other tool, on the Tools page or in the agent editor, and override its name, description and call cap per assignment if you need to.

## Related pages

- [Settings](/docs/administration/settings): the other sections of tenant Settings.
- [Access Control and RBAC](/docs/administration/access-control-rbac): roles and permissions.
- [Audit Log](/docs/administration/audit-log): where password changes, tests and test runs are recorded.

# Database Connectors

> What your workspace sees of its live database connections and queries, who sets them up, and how the Owner sets the password, runs tests and reads the run evidence

A database connector lets an agent answer from your live relational database: the status of an order, the stock of an article, free appointment slots. The agent never writes SQL. Your tenant Owner connects your database and writes a named, read-only query for each question; every query becomes one tool, and the model can only call it and fill the parameters it is given. You find them under **Settings › Security & access › Databases**. How it works, and why, is in [Live Database Connections](/docs/concepts/database-connections).

The section appears only on instances where the connector is switched on.

![Settings › Databases with one connection and one query](/docs-assets/academy/dbconn-databases-section.png)

## Who does what

| Role | In Settings › Databases |
|---|---|
| Owner (and Admin) | Decides whether a connection's write queries may run (**Allow write queries**). Creates, changes and deletes connections and queries; sets and replaces a connection's password; tests connections and sees the database driver's own error message; test-runs saved queries and unsaved drafts; uses the schema explorer. See [Database Connector Setup](/docs/administration/database-connector-setup) |
| Builder, Observer and the other roles that see tools | Read everything, SQL included, with all fields disabled. A Builder assigns the query tools to agents |
| Platform Admin | Reads everything; neither changes nor tests |
| Superadmin, in Tenant mode | The same as the Owner, except **Allow write queries**, which needs the Owner role in this workspace |
| Tenant API key | With the `admin` scope and no workflow restriction: reads everything, tests connections and test-runs saved queries, for example from CI. Never writes, explores the schema, allows write queries or sets a password |

Where you may not change something, the page says **Database connections and queries are set up by the tenant Owner.** The target, the database user and the SQL decide which data leaves your database, so give the Owner role only to people who may decide that. Every change is recorded in the audit log: the Owner's under their own name, a superadmin's as an operator action. Deciding which assistant uses a query is open to Builders too. Your database administrator prepares the database side with the [Database Administrator Checklist](/docs/administration/database-connector-checklist).

The platform operator keeps only what concerns the whole instance: whether the connector is switched on, that connections go only to public addresses with a verified certificate, which private networks your tenant may reach, the outbound addresses your firewall allows, and the instance-wide maxima for statement timeout, rows, result size and pool size.

## What you can read

- **Connections**: name, database type, host, port and database, TLS mode, whether it is enabled, and the last connection test. The password is never shown, only the date it was set.
- **Queries**: the tool name, the description the model reads, the SQL, every parameter and who fills it, the limits, and whether it runs without a signed-in person (anonymous visitors and triggers). The list shows the agents that use each query and its runs and errors of the last seven days.
- **Runs** of each query; see [Read the run evidence](#read-the-run-evidence).

A parameter **filled by the visitor's identity** (user id, external subject or verified email) is set by the platform from the signed-in visitor, never by the model. That is what keeps one visitor from reading another's rows. A visitor who is not signed in gets "please sign in" and no query runs, unless the query is marked **Runs without a signed-in person (anonymous visitors, triggers)** for public data such as stock or opening hours. The email is filled only when it is verified: through the widget's email code or SSO sign-in, which your widget needs turned on under **Audience → Sign-in**. A Chat User created by hand under **Audience** is not verified. [Writing Safe Database Queries](/docs/concepts/writing-safe-database-queries) explains what to look for when you review a query.

To test such a query with an agent, let a test suite read as one of your Chat Users: each step then runs it with that user's identity, exactly as if they were signed in. See [Testing a query that needs a signed-in visitor](/docs/concepts/regression-testing#testing-a-query-that-needs-a-signed-in-visitor). To try it in the Playground or the Workbench, read as one of your Chat Users there in the same way. See [Reading as a Chat User](/docs/concepts/playground-and-debugging#reading-as-a-chat-user).

## Replace the password

The Owner rotates the database password:

1. Open **Settings › Databases**, then the connection.
2. Click **Replace password** (**Set password** on a connection that has none yet) and enter the new one. It is stored encrypted and never shown again, and the change is recorded in the audit log.
3. The dialog offers to run the connection test right away. Run it: the **Login** step proves the new password.

The next tool call signs in with the new password: the platform opens new connections for it, and closes the ones it held with the old password within about ten minutes.

**Without downtime.** How you avoid a gap depends on the database:

- **MySQL 8.0.14 and later** keep two passwords at once. Set the new one with `ALTER USER 'cavelon_ro'@'…' IDENTIFIED BY '<new>' RETAIN CURRENT PASSWORD;`, replace it here and test, and after about ten minutes drop the old one with `ALTER USER 'cavelon_ro'@'…' DISCARD OLD PASSWORD;`.
- **PostgreSQL, MariaDB and SQL Server** keep one password per user. Change it in the database and replace it here right after. Calls that use an already open connection keep working; only a new connection opened in between fails with `auth_failed`, and the next call after your replacement succeeds.
- **No gap at all** on any database: create a second read-only user with the new password, then change the connection's **User** to it and replace the password right after. Drop the old user about ten minutes later.

**A new server needs the password again.** When you move a connection to another host, port or database type, the stored password is not sent to the new server: the change must carry the new server's password. A new database name or user on the same server keeps it.

## Allow write queries

A query of the kind **Write** changes rows in your database: it cancels an order, saves a callback request. Whether your assistant may do that is your decision, per connection. As an Owner or Admin, open the connection and switch on **Allow write queries**; switch it off to stop every write on it at once. Each change is recorded in the audit log with your name. Read queries are not affected.

Before you switch it on:

- Check which write queries use the connection: the queries list marks them **Writes**, and each shows its statement, the most rows one call may change, and whether the person confirms first.
- Prefer a connection with its own login that may write only what those queries need ([checklist](/docs/administration/database-connector-checklist#optional-a-login-for-write-queries)). With writes allowed, the connection test lists the login's write privileges instead of warning about them.
- Read [Write queries](/docs/concepts/database-connections#write-queries): every write is capped, never retried, and by default confirmed by the signed-in person in the chat.

While it is off, a write query's test run and every agent call answer `writes_not_allowed`. A solution package never switches it on; an import tells you when a write query waits for it.

## Test the connection

**Test connection** runs DNS, network policy, TCP, TLS, login, `SELECT 1`, server version and write privileges, and shows each step's result with its code. A red write-privileges finding means the database user can write: ask your database administrator for a read-only user. The result becomes the connection's last test; a query tool is ready for agents only while its connection is enabled and its last test passed. For a failed step you also see the database driver's own message, with the password and user name removed. What every step and code means is in [Connection test](/docs/troubleshooting/database-connections#connection-test).

## Test-run a saved query

A write query's test run is a dry run: the change is rolled back and nothing is saved. The result shows how many rows it would change.

The **Test run** panel of an open query runs it once against the database, read-only and under the same limits as an agent's call:

1. Open the query.
2. Fill one input per parameter. For a parameter filled from the visitor's identity, type the value of the customer whose view you want to check, for example their verified email.
3. Click **Run test**.

The panel shows:

- **Outcome** and, for a failure, the **Code** (see [Error codes](/docs/troubleshooting/database-connections#error-codes));
- **Duration**, **Rows** shown to the model, whether the result was **Truncated**, and the **Result size**;
- the raw rows as a table;
- **What the model sees**: the exact text the agent would get;
- **Tool schema the model gets**: the parameters the model may fill. Identity parameters are not in it.

The rows are shown once and never stored, and each run is recorded in the audit log with your name. An unsaved draft runs the same way, so you can try the SQL before you save it.

## Personal access tokens and the password

The Owner can also write connections and queries from a script or the dev-kit (`cavelon apply`, `cavelon api`) with a [personal access token](/docs/administration/personal-access-tokens), as long as the token's role in this tenant is still Owner. The database password is the one exception: it never travels through a token.

- A token that sends a password when it creates or changes a connection is refused with `403` and the code `person_only_operation`. Leave the password out.
- Setting or replacing a password (`PUT /api/v1/database-connectors/connections/{id}/password`) works only for a person signed in to the Admin.
- A connection a token creates has no password. The connection shows **Not set.** and a **Set password** button, its connection test fails at the **Login** step with "No password is set: a person sets it in the Admin under Settings > Databases.", and its queries answer `auth_failed`.
- A token cannot move a connection that has a password to another host, port or database type, because that change needs the new server's password (`credential_required_for_target_change`). Make that change in the Admin. A connection without a password moves freely.

To finish a connection a token created:

1. Open **Settings › Databases**, then the connection.
2. Click **Set password** and enter the database user's password.
3. Run the connection test. Once the **Login** step passes, its queries answer.

## Read the run evidence

Every run of a query, by an agent or a test run, leaves one evidence row. The query's **Runs** section shows them:

- **Last 7 days**: per day (UTC) the number of runs, how many failed, and their error codes.
- **Recent runs**: **When**, **Source** (**Agent** or **Test run**), **Outcome** (`ok`, `error`, `timeout`, `refused` or `busy`), **Duration**, **Rows** with a `truncated` mark, and the query's **Version** at the time.

The evidence holds no parameter values, no rows and no SQL, so it can be kept and shown without exposing your data. Runs refused before the database was touched (`invalid_arguments`, `identity_required`) leave no row; you find them in the conversation's trace. The evidence is kept for 90 days unless the instance operator set another period, and it outlives a deleted query. An agent's result itself stays in the conversation's trace, like any tool result.

## Assign the tools to your agents

Each query appears on the [Tools](/tools) page under **Database Query Tools**, with a **Database query** badge and a lock. The badge opens its query under Settings › Databases. The tool cannot be edited or deleted on the Tools page, and its card says **Setup required** while its connection is switched off or its last test did not pass. Assign it to agents and skills like any other tool, on the Tools page or in the agent editor.

Per assignment you may override the tool's name and description, and its call cap under **Advanced limits** (5 calls per user message by default). Renaming the tool itself, or changing its description for every agent, is the Owner's, in the query under Settings › Databases.

## Related pages

- [Live Database Connections](/docs/concepts/database-connections): the concept, parameters, limits, packages and testing.
- [Troubleshooting Database Connections](/docs/troubleshooting/database-connections): every error code and connection test step.
- [Settings](/docs/administration/settings): the other sections of tenant Settings.
- [Access Control and RBAC](/docs/administration/access-control-rbac): roles and permissions.
- [Audit Log](/docs/administration/audit-log): where password changes, tests and test runs are recorded.

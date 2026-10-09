# Database Connector Setup

> For the tenant Owner: a step-by-step tutorial to connect your database, test it, write and test-run a read-only query, give it to an agent, and what the instance operator sets

A database connector lets an agent answer from your live relational database: the status of an order, the stock of an article, free appointment slots. The agent never writes SQL. The tenant Owner writes a named, parameterized `SELECT`; it becomes one tool, and the model can only call it and fill the parameters it is given.

This page is the Owner's tutorial for the screens under **Settings › Security & access › Databases**, from an empty tenant to an agent that answers from the database. A superadmin in Tenant mode can follow it the same way. The rules behind every field (parameters, identity, limits, packages) are in [Live Database Connections](/docs/concepts/database-connections); what the tenant's other roles see and do is in [Database Connectors](/docs/administration/database-connectors).

The section appears only on instances where the connector is switched on (see [Instance settings](#instance-settings)). PostgreSQL, MySQL/MariaDB, Microsoft SQL Server and Oracle Database are supported. A database type whose driver this instance lacks is shown disabled in the form, with the reason.

## Who may change what

The tenant Owner creates, changes and deletes connections and queries, sets and replaces passwords, tests connections, test-runs saved queries and unsaved drafts, and uses the schema explorer. A superadmin in **Tenant mode** may do the same. Every change is recorded in the audit log: the Owner's under their own name, a superadmin's as an operator action. Builders, Observers and the other tenant roles that see tools read the screens, SQL included, with all fields disabled, and Builders assign the query tools to agents. A Platform Admin can read but neither change nor test: a test run can read any visitor's rows. A tenant API key never writes.

A personal access token whose role in the tenant is still Owner (or a superadmin's token) may make the same changes through the API and the dev-kit, except the password: a person sets it in the Admin. See [Personal access tokens and the password](/docs/administration/database-connectors#personal-access-tokens-and-the-password).

What concerns the whole instance stays with the instance operator: whether the connector is on, the network protection, the private networks a tenant may reach, the outbound addresses and the instance-wide maxima (see [Instance settings](#instance-settings)).

## Before you start

- **The database side.** Send your database administrator the [Database Administrator Checklist](/docs/administration/database-connector-checklist). You need from them: host, port, database name, a read-only user and its password, and the CA certificate if the server's certificate is not from a public CA.
- **The network.** The database must allow the platform's outbound address. The connection form shows it; if it says no address is configured, ask the instance operator to record it first (see [Instance settings](#instance-settings)).
- **A private database** (over a VPN, or a test database in a container) is reachable only after the instance operator admits its address for your tenant. Without that, the connection test refuses it with `non_public_address`.
- **A superadmin** switches to **Tenant mode** for the customer's tenant first.
- **Visitor sign-in, for identity queries.** A query scoped to the signed-in visitor (like `order_status` below) answers only a visitor who signed in through the widget's email code or SSO, and binds an email only when it is verified. A Chat User created by hand under **Audience** is not verified. Turn on sign-in for the widget under **Audience → Sign-in** before the first customer uses such a query.

The example in this tutorial is a shop database on PostgreSQL with a table `orders` (order number, email, status, shipping date) and a table `articles` (SKU, name, stock). It ends with two tools: `order_status`, scoped to the signed-in visitor, and `article_stock`, which anyone may call.

## Step 1: Create the connection

1. Open **Settings › Databases** and click **New connection**.
2. **Name**: the name packages use to find this connection, for example `shop-db`. Use the same name in every tenant and environment the solution goes to.
3. **Database**: the database type. It sets the default port.
4. **Host**, **Port**, **Database name**, **User**, **Password**. The host is one DNS name or one IP address, without port, path or user. The password is write-only: once saved it is never shown again, only the date it was set.
5. **TLS**: **Verify full** for every database on the internet; a public IP address offers nothing else. **Require** and **Disable** are for a private target the instance operator admitted for this tenant, and the form marks them in red. If the server's certificate is not from a public CA, paste or upload its CA, or a self-signed server certificate itself, under **CA certificate (optional)**.
6. **Statement timeout (ms)**: the database stops any statement that runs longer. 5,000 ms is the default; the instance caps it.
7. Leave **Enabled** on and click **Create connection**.

![The connection form of a saved PostgreSQL connection](/docs-assets/academy/dbconn-connection-form.png)

After saving, the form shows each uploaded certificate's subject, issuer, expiry and SHA-256 fingerprint, and marks an expired one in red.

**Changing a connection later.** Any change makes the next tool call open fresh connections with the new settings. A change of host, port or database type needs the new server's password in the same save: the stored password was entered for the old server and is never sent to another (`credential_required_for_target_change`, recorded as `database_connection.update_refused`). A new database name or user on the same server keeps the password. The database type cannot change while queries use the connection.

**A connection created with a token.** A personal access token cannot send a password, so a connection created with `cavelon apply` or `cavelon api` has none: the form shows **Not set.** and a **Set password** button. Click it, enter the password, and run the connection test.

### Network and read-only user

Below the form, **Network and read-only user** has what you send to the database administrator:

- the outbound addresses to allow on the database port (**Copy addresses**);
- **Processes that run agents**: enter how many processes run agents on this instance. The panel multiplies it by the connections each process keeps and shows **Connections to allow**;
- a script for the chosen database type that creates the read-only user with that connection limit (**Copy SQL**).

![The network panel with the address to allow and the read-only user script](/docs-assets/academy/dbconn-network-panel.png)

### Per database type

| | PostgreSQL | MySQL and MariaDB | Microsoft SQL Server | Oracle Database |
|---|---|---|---|---|
| Default port | 5432 | 3306 | 1433 | 2484 (TCPS); 1521 for plain TCP |
| Read-only user script | A login role with `CONNECTION LIMIT`, `default_transaction_read_only`, `SELECT` on one schema | One account per outbound address with `MAX_USER_CONNECTIONS` (and `REQUIRE SSL` unless TLS is off), `SELECT` on the database | A login and a database user that is a member of `db_datareader` only; no per-login limit | A profile with `SESSIONS_PER_USER`, a user with `CREATE SESSION` and `READ` on one schema's tables |
| Read-only transaction | Yes | Yes | No: the login is the boundary, and the connection needs a passing write-privilege check (below) | Yes, and commits inside PL/SQL are refused |
| Schema explorer schema | `public` first, listed only when it holds a table the user may read | The connection's database | `dbo` first; schemas without a readable table are not listed | Users that own a table or view the login may read; Oracle's own schemas are not listed |
| Quoted names | `"schema"."table"` | `` `schema`.`table` `` | `[schema].[table]` | `"SCHEMA"."TABLE"` (upper case unless created quoted) |
| Watch for | `:id::int` binds `:i`; write `CAST(:id AS int)` | `DATETIME` values are compared in UTC; a lone `SELECT SLEEP(n)` stopped by the timeout returns 1 | One stored-procedure call `EXEC [schema].[procedure] @p = :p, …` allowed, only on a login tested without write privileges; T-SQL statement keywords are refused; a server that redirects is refused; give the server a certificate | The database field is the service name; a listener that redirects (SCAN, shared server) is refused; no `RETURNING`, PL/SQL, `DBMS_*`/`UTL_*` or database links |

## Step 2: Test the connection

Open the saved connection and click **Test connection**. The test runs DNS, network policy, TCP, TLS, login, `SELECT 1`, server version and write privileges, and stops at the first step that fails.

![A passing connection test, step by step](/docs-assets/academy/dbconn-connection-test.png)

Read it from the top:

1. **DNS**: how many addresses the host has.
2. **Network policy**: `Connects to <address>`, the one address the platform will use, and `(private target N)` when an operator entry admitted it.
3. **TCP**: the port is open.
4. **TLS**: the protocol, the certificate's subject, issuer and expiry, and what it was verified against: the uploaded CA, or the public bundle. With **Require**: `certificate not verified (require)`.
5. **Login**: signed in, over TLS or not.
6. **SELECT 1** and **Server version**: the session works, and which version answers.
7. **Write privileges**: `None found`, or a red `This user can write: …` naming what was found. Ask for a read-only user.

For a failed step you see the code, its meaning and the database driver's message with the password and user name removed. A connection without a password fails at **Login** with "No password is set: a person sets it in the Admin under Settings > Databases." What each failure means and how to fix it is in [Connection test](/docs/troubleshooting/database-connections#connection-test). The result becomes the connection's **Last test**. A query tool is ready for agents only while its connection is enabled and its last test passed.

### SQL Server: a read-only login is required

SQL Server has no read-only transaction, so the login is what keeps a query from writing; every call is still rolled back afterwards. Queries on a SQL Server connection can be enabled only after a connection test of its current settings that found no write privileges (`database_connection_untested` otherwise). When the test finds some, the **Read-only login** panel says so and queries stay off (`write_privileges_unacknowledged`), and an already enabled query answers `unavailable`, until the login is replaced and tested again. The Owner can instead switch on **Queries may run although this login can write**: a recorded decision, kept in the audit log with the finding, which resets when the server or the user changes.

The platform connects to the address it checked and nothing else: a SQL Server that answers with a redirect to another server (Azure SQL's Redirect connection policy, an availability group's read-only routing) is refused. Azure SQL works with the Proxy policy. A SQL Server without a configured certificate presents one it generates at every start; give the server a certificate, or use **Require** over a private target.

A query may be one stored-procedure call, `EXEC [schema].[procedure] @param = :param, …`, every argument a placeholder. The platform cannot see what a procedure does, so such a query is saved, enabled and run only while the last test of the connection's current settings found no write privileges (`database_connection_untested` without one, `write_privileges_block_procedure` when it found some); **Queries may run although this login can write** does not count for it. The call runs in the same rolled-back transaction with the lock and statement timeouts. The model gets the first result set; further result sets are read and counted in the result's note, and a procedure without a result set answers "No rows matched." with a note. A procedure still writes its owner's tables for any login that may execute it (ownership chaining), so three more checks apply. Every save, enable, test run and import reads the procedure's definition through the connection's login (grant it `VIEW DEFINITION` on the procedure) and refuses one that changes anything but a temporary table (`#name`) or table variable (`@name`), creates or drops objects, commits or rolls back, calls another procedure or dynamic SQL, or reaches another server or a file (`procedure_definition_writes`), and one it cannot read: missing, `WITH ENCRYPTION`, or without `VIEW DEFINITION` (`procedure_definition_unreadable`). The call runs one transaction level deeper than the connector's own, so a single `COMMIT` inside the procedure is still rolled back. A procedure that ends the transaction anyway fails the call (`query_failed`), its query is switched off automatically (audit entry `database_query.disabled_automatically`), and the test run says whether its writes may be committed. A passing connection test lists the stored-procedure queries whose procedure no longer passes.

## Step 3: Explore the schema

Click **New query**, choose the connection, and click **Show schema** beside the SQL box. The side panel lists what the connection's user may read: pick a schema, filter its tables, and expand a table for its columns with their data types. A click inserts the name at the cursor, quoted for the database type. On PostgreSQL and SQL Server a schema is listed only when it holds a table or view the user may read, so the panel opens on `public` only when there is something to read in it, and otherwise on the first schema that has.

![The schema explorer beside the SQL editor](/docs-assets/academy/dbconn-schema-explorer.png)

The panel shows at most 500 tables and 2,000 columns of one schema. It reads only the database's catalog, in the same read-only transaction and under the same statement timeout as a query, and each look is recorded in the audit log with counts, never names. Only the Owner and a superadmin in Tenant mode use it. When the catalog cannot be read, the panel shows the error code, its meaning and the driver's message with the password removed.

## Step 4: Write the query

Fill the query form:

- **Tool name for the model**: `order_status`. Lower-case letters, digits, `_` and `-`; the model calls the tool by this name.
- **Display name**: `Order status`.
- **Description for the model**: what the query returns and when to use it, for example *Looks up the status and shipping date of one of the signed-in customer's orders by its order number. Use it when the customer asks where an order is.* The model chooses tools by this text.
- **Connection**: `shop-db`.
- **SQL**:

```sql
SELECT order_number, status, shipped_at
FROM orders
WHERE order_number = :order_number
  AND email = :email
LIMIT 1
```

Each `:name` adds a row to the **Parameters** table, in the order the SQL uses them. For each row choose:

- **Filled by**: **The model** for `order_number`; **Visitor: verified email** for `email`. An identity parameter (**Visitor: user id**, **Visitor: external subject (SSO)**, **Visitor: verified email**) is filled by the platform from the signed-in Chat User, never shown to the model, and the main protection against one visitor reading another's rows.
- **Type**: `string` here. For an identity parameter it is always a string.
- **Description for the model**: required for every model parameter, with an example: *Order number as printed on the confirmation, e.g. A-10023*.
- **Required**, and **Constraints**: a maximum length (200 unless set) and a pattern for a string, for example `^[A-Z]-[0-9]{4,8}$`; a minimum and maximum for a number; allowed values for a string or number.

![The query editor with the SQL and its parameters](/docs-assets/academy/dbconn-query-editor.png)

Then the limits:

- **Rows the model gets at most** and **Characters the model gets at most** cap what reaches the model. When more rows match, the model is told the result was cut and asks the visitor to narrow the request.
- The editor warns when the SQL has no `LIMIT`, `TOP` or `FETCH FIRST`: without one the database may read far more rows than the model ever sees.
- **Runs without a signed-in person (anonymous visitors, triggers)** is off by default and offered only on a query without an identity parameter. It covers every run without a signed-in person: anonymous visitors, and runs a trigger or a schedule starts, which have no person at all. A query a trigger uses needs it on. For `order_status`, which has an identity parameter, the form shows **This query needs visitor sign-in** instead.

> **Identity parameters need visitor sign-in.** The platform fills an identity parameter only for a visitor who signed in through the widget's email code or SSO, and **Visitor: verified email** only when the email is verified. A Chat User created by hand under **Audience** is not verified, so such a query answers them "please sign in". A run without a signed-in person, such as a trigger's, never runs it unless its conversation has a known Chat User. Before the first customer, turn on sign-in for the widget under **Audience → Sign-in**.

Click **Create query**. A refused save names its code; [Save-time codes](/docs/troubleshooting/database-connections#save-time-codes) explains each.

Now create the second query the same way: `article_stock` with `SELECT sku, name, stock FROM articles WHERE sku = :sku LIMIT 1`, `:sku` filled by the model with a pattern, and **Runs without a signed-in person (anonymous visitors, triggers)** turned on, because stock is public. If the selected columns looked personal (email, phone, address, birth date, IBAN) or the query selected `*`, a red hint would say so. How to write such queries safely is in [Writing Safe Database Queries](/docs/concepts/writing-safe-database-queries).

## Step 5: Test-run and read "What the model sees"

In the open query, **Test run** has one input per parameter, identity parameters included: type the visitor's value by hand, for example the customer's verified email. Click **Run test**.

![A test run with the rows and what the model sees](/docs-assets/academy/dbconn-query-test-run.png)

The panel shows the **Outcome**, **Duration**, **Rows**, whether the result was **Truncated** and its size; the raw rows as a table; **What the model sees**, the exact JSON the agent would get; and **Tool schema the model gets**. Check three things:

- **What the model sees** holds the columns and rows you expect, and a `note` when the result was cut or nothing matched.
- **Tool schema the model gets** lists only `order_number`. The email is not in it: the model cannot fill or even name it.
- A test run with another customer's email and this order number returns no rows.

An unsaved draft runs as it stands, so you can try the SQL before saving. The rows are shown once and never stored; the run is recorded in the audit log and in the query's **Runs**.

## Step 6: Enable the query and give it to an agent

1. In the query, leave **Enabled** on (or turn it on) and save. On SQL Server this needs the passing write-privilege check of Step 2.
2. The query now appears on the [Tools](/tools) page under **Database Query Tools**, with a **Database query** badge and a lock. It cannot be edited or deleted there; the badge opens the query. **Setup required** means its connection is off or its last test did not pass.

![The query tools on the Tools page](/docs-assets/academy/dbconn-tools-page.png)

3. Open the solution's **Agents** page, open the agent that should answer, click **Add tools**, and pick the query under **Integrations**. Assigning tools is also open to the tenant's Builders.
4. Optionally, under the assigned tool's **Advanced limits**, change how often it may run per user message. The default is 5; in voice the same cap counts per user turn, with a ceiling for the whole session.
5. Tell the agent when to use the tool in its instructions if the description alone is not enough, for example *When a customer asks about an order, look it up with order_status; ask for the order number if you do not have it.*

## Step 7: Try it in the Playground

Open the solution's **Playground** and ask a question the query answers:

- *Is article SKU-1001 in stock?* calls `article_stock`, which anyone may call. The answer comes from the database, and the debug panel's trace shows the tool call with its arguments and the JSON result.
- *Where is my order A-10023?* calls `order_status`. The Playground reads as a visitor who is not signed in, so the tool answers `identity_required` and the agent asks the visitor to sign in. That is the refusal working.

To see the answer a signed-in customer gets, read as one of the tenant's Chat Users: set **Read as** to **A Chat User…** at the top of the Playground and pick the Chat User, or let a test suite read as that Chat User. The platform then fills the identity parameters from that Chat User's record, exactly as if they were signed in. The picker marks a Chat User whose email is not verified (**Not verified**); `order_status` still answers them "please sign in", because it binds the verified email. See [Reading as a Chat User](/docs/concepts/playground-and-debugging#reading-as-a-chat-user) and [Testing a query that needs a signed-in visitor](/docs/concepts/regression-testing#testing-a-query-that-needs-a-signed-in-visitor).

**Voice.** In a voice session the query runs on the platform as well: the voice provider receives only the tool's name, description and schema, never the SQL or the connection. Each user turn starts a new call count, in the browser and on the phone, and a session-wide ceiling keeps a caller from walking through order numbers turn by turn.

## Queries in solution packages

A query travels in a solution package; its connection does not, only its name and dialect. Importing a package into a tenant needs a connection with the same name and dialect whose last test passed, so create and test the connection first, then import the package: in the Admin on the solution's **Agents** page (**Import JSON**), or with your personal access token (`cavelon apply`). The Owner's import creates and changes the queries. Anyone else's import, a Builder's or a token capped to Builder, is blocked with `database_query_needs_superadmin` for each query it would create or change; once the queries match, it passes for anyone who may import. The details and every import blocker are in [Solution packages](/docs/concepts/database-connections#solution-packages).

A test, staging or CI tenant needs its own connection with the same name, created by that tenant's Owner. `localhost` and the platform's own containers are refused, so a test database in a container is reached through a private target the instance operator sets for that tenant.

## Instance settings

These are not tenant settings. The instance operator sets them for the whole instance, and each takes effect at the next start of the platform. Ask the operator when one of them stands in your way.

| Setting | Default | What it does |
|---|---|---|
| `DATABASE_CONNECTOR_ENABLED` | `false` | The switch for the whole feature. While off, the Databases section, its docs pages and every database tool are hidden, and a running conversation's database tool answers `unavailable`. Turn it on per environment |
| `DATABASE_CONNECTOR_EGRESS_IPS` | empty | The outbound IP addresses customers allowlist, comma-separated. Display only: the connection form shows them; nothing routes by them |
| `DATABASE_CONNECTOR_PRIVATE_TARGETS` | `[]` | JSON list of `{"tenant_id", "cidr", "ports"}`: the only way to reach a private address, for that tenant, inside that range and on those ports |
| `DATABASE_CONNECTOR_STATEMENT_TIMEOUT_MS_MAX` | `30000` | Largest statement timeout a connection may be saved with |
| `DATABASE_CONNECTOR_MAX_ROWS_MAX` | `500` | Largest **Rows the model gets at most** |
| `DATABASE_CONNECTOR_MAX_RESULT_CHARS_MAX` | `20000` | Largest **Characters the model gets at most** |
| `DATABASE_CONNECTOR_CONNECT_TIMEOUT_SECONDS` | `5` | Seconds for TCP, TLS and login of one new connection |
| `DATABASE_CONNECTOR_MAX_FETCH_BYTES` | `1048576` | Bytes read per call before fetching stops |
| `DATABASE_CONNECTOR_POOL_SIZE` | `2` | Connections per database connection per process; the customer sees this times the processes that run agents |
| `DATABASE_CONNECTOR_MAX_THREADS` | `8` | Threads per process that run customer queries |
| `DATABASE_CONNECTOR_RUN_RETENTION_DAYS` | `90` | Days the run evidence is kept; `0` keeps it forever |
| `REALTIME_TOOL_SESSION_CALL_CEILING_FACTOR` | `10` | In voice, a capped tool runs at most its cap times this factor per session |

**The outbound address.** The instance operator records the address the platform's traffic leaves from in `DATABASE_CONNECTOR_EGRESS_IPS`. Customers allowlist it, so it is a commitment: when it changes, the operator lists both addresses while customers move. Allowlist IPv4 only; the connector prefers an IPv4 answer.

**Private targets.** The instance operator admits a private network for one tenant at a time. An entry admits only its own tenant, only addresses inside its range (at most a /16 for IPv4, a /48 for IPv6; a single address as `/32` is safest) and only its ports (1024-65535):

```env
DATABASE_CONNECTOR_PRIVATE_TARGETS=[{"tenant_id":"<tenant id>","cidr":"10.40.12.0/24","ports":[5432]}]
```

Startup fails on an entry that touches loopback, link-local or `100.64.0.0/10`, or that is too wide. An entry that contains an address of the process's own network interfaces admits nothing and is logged at startup as `database_private_target_refused`; keep entries clear of the container networks on the host. Every admission is logged at WARNING as `database_private_target_admitted` with the tenant id and the entry's index, never the address. For a test database in a container, admit that container's address as a `/32` for the test tenant.

**Drivers.** The standard images carry the drivers for all four database types: psycopg2 for PostgreSQL, PyMySQL for MySQL and MariaDB, python-tds with pyOpenSSL for SQL Server, and python-oracledb in thin mode (no Oracle Client libraries) for Oracle. A host without one of them keeps running; that database type is shown disabled in the connection form, and its connections answer `unavailable`.

## Related pages

- [Live Database Connections](/docs/concepts/database-connections): parameters, identity, limits, packages and testing.
- [Database Connectors](/docs/administration/database-connectors): what the other tenant roles see, password rotation, tokens and run evidence.
- [Database Administrator Checklist](/docs/administration/database-connector-checklist): what your database administrator prepares.
- [Writing Safe Database Queries](/docs/concepts/writing-safe-database-queries): identity, second factors and limits.
- [Troubleshooting Database Connections](/docs/troubleshooting/database-connections): every error code and test step.
- [Platform Mode](/docs/administration/platform-mode): Platform and Tenant mode.
- [Audit Log](/docs/administration/audit-log): where connection and query changes, tests and test runs are recorded.

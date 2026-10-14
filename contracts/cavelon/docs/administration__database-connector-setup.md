# Database Connector Setup

> For the tenant Owner: connect a database over the internet, a VPN or an SSH bastion, with a password or Kerberos, test it, write and test-run queries, and the instance settings

A database connector lets an agent answer from your live relational database: the status of an order, the stock of an article, free appointment slots. The agent never writes SQL. The tenant Owner writes a named, parameterized `SELECT`; it becomes one tool, and the model can only call it and fill the parameters it is given.

This page is the Owner's tutorial for the screens under **Settings › Security & access › Databases**, from an empty tenant to an agent that answers from the database. A superadmin in Tenant mode can follow it the same way. The rules behind every field (parameters, identity, limits, packages) are in [Live Database Connections](/docs/concepts/database-connections); what the tenant's other roles see and do is in [Database Connectors](/docs/administration/database-connectors).

The section appears only on instances where the connector is switched on (see [Instance settings](#instance-settings)). PostgreSQL, MySQL/MariaDB, Microsoft SQL Server and Oracle Database are supported, and IBM Db2 (LUW) on request, where the instance operator turned it on. A database type whose driver this instance lacks is shown disabled in the form, with the reason.

## Who may change what

The tenant Owner creates, changes and deletes connections and queries, sets and replaces passwords, tests connections, test-runs saved queries and unsaved drafts, and uses the schema explorer. A superadmin in **Tenant mode** may do the same. Every change is recorded in the audit log: the Owner's under their own name, a superadmin's as an operator action. Builders, Observers and the other tenant roles that see tools read the screens, SQL included, with all fields disabled, and Builders assign the query tools to agents. A Platform Admin can read but neither change nor test: a test run can read any visitor's rows. A tenant API key never writes.

A personal access token whose role in the tenant is still Owner (or a superadmin's token) may make the same changes through the API and the dev-kit, except these, which a person makes in the Admin: the password, a Kerberos keytab or an SSH key, **Allow write queries**, and a weaker TLS mode or a changed CA certificate. See [Personal access tokens and the password](/docs/administration/database-connectors#personal-access-tokens-and-the-password).

What concerns the whole instance stays with the instance operator: whether the connector and Db2 are on, the network protection, the outbound addresses and the instance-wide maxima (see [Instance settings](#instance-settings)). Which private networks a tenant may reach is decided by a Platform Owner in the Admin ([Private targets](#private-targets-a-database-behind-a-vpn)).

## Before you start

- **The database side.** Send your database administrator the [Database Administrator Checklist](/docs/administration/database-connector-checklist). You need from them: host, port, database name, a read-only user and its password, and the CA certificate if the server's certificate is not from a public CA.
- **The network.** The database must allow the platform's outbound address. The connection form shows it; if it says no address is configured, ask the instance operator to record it first (see [Instance settings](#instance-settings)).
- **A private database** is reachable over a VPN only after a Platform Owner opens its range for your tenant, or through your own SSH bastion. Without either, the connection test refuses it with `non_public_address`. Which path fits is in [How the platform reaches the database](#how-the-platform-reaches-the-database).
- **A domain login.** A SQL Server or PostgreSQL that accepts only Active Directory accounts needs a service account and its keytab from your domain administrator ([Kerberos](#kerberos-active-directory-sign-in)).
- **A superadmin** switches to **Tenant mode** for the customer's tenant first.
- **Visitor sign-in, for identity queries.** A query scoped to the signed-in visitor (like `order_status` below) answers only a visitor who signed in through the widget's email code or SSO, and binds an email only when it is verified. A Chat User created by hand under **Audience** is not verified. Turn on sign-in for the widget under **Audience → Sign-in** before the first customer uses such a query.

The example in this tutorial is a shop database on PostgreSQL with a table `orders` (order number, email, status, shipping date) and a table `articles` (SKU, name, stock). It ends with two tools: `order_status`, scoped to the signed-in visitor, and `article_stock`, which anyone may call.

## Step 1: Create the connection

1. Open **Settings › Databases** and click **New connection**.
2. **Name**: the name packages use to find this connection, for example `shop-db`. Use the same name in every tenant and environment the solution goes to.
3. **Database**: the database type. It sets the default port.
4. **Host**, **Port**, **Database name**, **User**. The host is one DNS name or one IP address, without port, path or user. Through an SSH bastion, they are the database as the bastion reaches it ([Through an SSH bastion](#through-an-ssh-bastion)).
5. **Sign-in** and its credential: **Database password** with the **Password**, or **Kerberos (Active Directory)** with a keytab ([How the platform signs in](#how-the-platform-signs-in)). The credential is write-only: once saved it is never shown again, only the date it was set.
6. **TLS**: **Verify full** for every database on the internet; a public IP address offers nothing else. **Require** and **Disable** are for a private target a Platform Owner opened for this tenant, and the form marks them in red; Db2 takes **Verify full** only. If the server's certificate is not from a public CA, paste or upload its CA, or a self-signed server certificate itself, under **CA certificate (optional)**.
7. **Statement timeout (ms)**: the database stops any statement that runs longer. 5,000 ms is the default, 100 ms the least; the instance caps it (30,000 ms unless the operator changed it).
8. For a database behind a bastion, switch on **Through an SSH bastion**; for an Oracle RAC or SQL Server availability group listener, **Follow listener redirects within allowed targets**. Both are explained below.
9. Leave **Enabled** on and click **Create connection**.

![The connection form of a saved PostgreSQL connection](/docs-assets/academy/dbconn-connection-form.png)

After saving, the form shows each uploaded certificate's subject, issuer, expiry and SHA-256 fingerprint, and marks an expired one in red.

**Changing a connection later.** Any change makes the next tool call open fresh connections with the new settings. A change of host, port or database type needs the new server's password in the same save: the stored password was entered for the old server and is never sent to another (`credential_required_for_target_change`, recorded as `database_connection.update_refused`). A new database name or user on the same server keeps the password. The database type cannot change while queries use the connection.

**A connection created with a token.** A personal access token cannot send a password, so a connection created with `cavelon apply` or `cavelon api` has none: the form shows **Not set.** and a **Set password** button. Click it, enter the password, and run the connection test.

### How the platform reaches the database

The platform connects from the outbound address the form shows, to the one address it checked for the connection, and nowhere else. Choose the path by where the database lives; [Your Database in Your Own Network](/docs/tutorials/your-database-in-your-own-network) walks through the private ones with screenshots.

| The database is | Path | Who does what |
|---|---|---|
| On the internet | [A public database with an allowlist](#a-public-database-with-an-allowlist) | The database administrator allows the outbound address and serves a certificate for the host name |
| Inside the customer's network, linked to the platform's host by a VPN | [A private network over a VPN](#a-private-network-over-a-vpn) | The customer and the instance operator set up the VPN; a Platform Owner opens the range for your tenant |
| Inside the customer's network, behind a jump host | [Through an SSH bastion](#through-an-ssh-bastion) | The bastion's administrator adds the connection's key with a line that forwards only to the database |
| Behind an Oracle RAC SCAN listener or a SQL Server availability group listener | [Listener redirects](#listener-redirects), on top of one of the paths above | You switch it on; every node must be allowed on its own |

### A public database with an allowlist

The host resolves on the public internet to public addresses only; a name that also resolves to a private address is refused (`mixed_answers`). The database's firewall allows the outbound address on its port, and only that, and TLS is **Verify full**: the server's certificate names the host you enter and chains to a public CA or the CA you upload. The [checklist](/docs/administration/database-connector-checklist#3-allow-the-platforms-address) has the database administrator's side.

### A private network over a VPN

A database without a public address is reached over a site-to-site VPN between the customer's network and the platform's host. The customer and the instance operator set up the VPN; then a Platform Owner opens the database's range for your tenant only, with its ports ([Private targets](#private-targets-a-database-behind-a-vpn)). You cannot open a range yourself.

1. Ask for the range (a single address as `/32` is safest) and the database's port to be opened for your tenant. For Kerberos, ask for the domain controllers' range with port 88 as well.
2. Create the connection with the database's private name or address. Its **Network** section lists the ranges open for your tenant.
3. Run the connection test: **Network policy** says `(inside a private network the platform operator opened)`.

On a private target **Require** and **Disable** are allowed (not on Db2). **Verify full** with the customer's CA remains the better choice, since the password still crosses the network.

### Through an SSH bastion

When the customer runs a jump host, the platform can reach the database through it instead of a VPN. The bastion is what the platform connects to, so it must be a public address, or a private one a Platform Owner opened for your tenant with port 22 (or the bastion's port).

1. Switch on **Through an SSH bastion** and enter **Bastion host**, **Bastion port** (22 unless the bastion uses another), **SSH user** and **Bastion host key fingerprint**. Ask the bastion's administrator for the fingerprint over a channel you trust; on the bastion, `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` prints it. The platform compares it before it signs in and never takes it from a first connection.
2. Enter the database's **Host** and **Port** as the bastion reaches them, for example `db.internal` and `5432`.
3. Paste or upload a **Private key** made for this connection only: Ed25519, or RSA of 3072 to 8192 bits, without a passphrase (the form suggests `ssh-keygen -t ed25519 -N '' -f cavelon-tunnel`). Like the password, only a person signed in to the Admin sets it, and it is never shown again; **Replace key** changes it later.
4. Save, and send the bastion's administrator the line under **For the bastion user's authorized_keys** (**Copy line**). It looks like `restrict,port-forwarding,permitopen="db.internal:5432",permitlisten="localhost:22",command="/bin/false" ssh-ed25519 AAAA… cavelon-database-connector`: the key may forward only to that host and port, and any command or shell runs `/bin/false`. The administrator also holds the user in the bastion's `sshd_config` with the block in the [checklist](/docs/administration/database-connector-checklist#through-an-ssh-bastion), which forbids remote and Unix-socket forwarding outright.
5. Run the connection test. An **SSH bastion** step follows **Network policy**; DNS and the network policy are then the bastion's, and **TCP** is the bastion reaching the database.

TLS runs inside the tunnel to the database itself, verified against the database's name, so the bastion sees only encrypted traffic; a public bastion needs **Verify full**. Changing the bastion's host, port or fingerprint, or adding or removing the tunnel, needs the database password in the same save. A connection through a bastion does not follow listener redirects. What the bastion's administrator sets up is in the [checklist](/docs/administration/database-connector-checklist#through-an-ssh-bastion).

### Listener redirects

An Oracle RAC SCAN listener hands the session to a node's address, and a SQL Server availability group listener routes a read-only login to a readable secondary. Both are redirects, and by default the platform refuses them with `target_refused`: it connects to the address it checked and nothing else. For Oracle and SQL Server connections the Owner can switch on **Follow listener redirects within allowed targets** in the connection's form. The platform then follows a redirect only when:

- the new host passes the same network check as the connection's own host: a public address, or one of this tenant's private targets, never loopback, link-local or the platform's own addresses;
- TLS verifies the certificate against the redirect's host name, with the same CA and TLS mode (a public address still needs **Verify full**);
- it is the first or second redirect of the connection, and not back to an address it already used.

The connection test's **Login** step says how many redirects were followed, and each run records the count and whether it ended on a private target or a public address. A refused redirect fails the **Login** step with `target_refused` and the reason. On SQL Server the switch also makes the login ask for read-only routing (`ApplicationIntent=ReadOnly`), and write queries would fail on a readable secondary, so the switch and **Allow write queries** exclude each other: turning one on while the other is on is refused with `redirects_conflict_with_writes`. Use **Verify full** on a connection that follows redirects: with **Require** or **Disable** the password reaches whichever host on the private target the listener names, without a certificate check. PostgreSQL, MySQL and MariaDB have no listener redirects, so the switch is not offered for them. Changing the switch is recorded in the audit log.

### How the platform signs in

The platform signs in as one database login per connection, never with a visitor's identity.

| Sign-in | Database types | The credential | Set by |
|---|---|---|---|
| Password | All | The read-only user's password | A person signed in to the Admin; never a token |
| Kerberos (Active Directory) | SQL Server, PostgreSQL, where the instance offers it | A domain service account's keytab (its AES keys) or password | A person signed in to the Admin; never a token |

### Password

The default. Enter the read-only user's password in the form; it is stored encrypted and never shown again. A connection a personal access token created has none until a person clicks **Set password**. Rotating it without a gap is in [Replace the password](/docs/administration/database-connectors#replace-the-password). The read-only user itself comes from the script under [Network and read-only user](#network-and-read-only-user).

### Kerberos (Active Directory) sign-in

A SQL Server that accepts only Windows logins, or a PostgreSQL that accepts domain accounts, is connected with **Sign-in: Kerberos (Active Directory)**. The platform signs in as one dedicated service account of your domain; it never uses a visitor's identity. The option is disabled for MySQL, MariaDB, Oracle and Db2, and on an instance that does not offer Kerberos for the database type ("not available on this instance").

1. **Realm**: your AD domain in capitals, for example `CORP.EXAMPLE.COM`.
2. **Principal**: the service account's name without the realm, for example `svc_cavelon`.
3. **KDCs**: one to three domain controllers, one per line, port 88 unless you add `:port`. The platform asks only these, never DNS. Each is checked like the database host: a controller inside your network is reached only after a Platform Owner opens its range for your tenant with port 88.
4. **Keytab or password**: upload the account's keytab (**Upload keytab**), or enter its password. Of a keytab, only the account's AES keys are kept; other accounts' keys and RC4 or DES keys are dropped. One of them is stored at a time, encrypted, and never shown again; **Replace keytab** and **Replace password** change it later. A personal access token can send neither.

The form shows the service principal the directory must know, built from the host exactly as you enter it: `MSSQLSvc/<host>:<port>` for SQL Server, `postgres/<host>` for PostgreSQL. Use the server's DNS name as registered, not its IP address or an alias. Changing the realm, the principal, the KDCs or the sign-in method needs the keytab or password again in the same save.

What the domain and database administrators prepare, the AES-enabled service account, its keytab, the registered service principal, read rights and on PostgreSQL the `pg_hba.conf` line, is in the checklist's [Kerberos section](/docs/administration/database-connector-checklist#optional-kerberos-active-directory-sign-in). On PostgreSQL, set **User** to the database role of the account's name (`svc_cavelon`); the platform answers only the server's Kerberos request and never sends a password for a Kerberos connection.

The connection test then shows a **Kerberos ticket** step before **Login** ([Step 2](#step-2-test-the-connection)). The domain controllers are checked like the database host: on the internet they need public addresses, inside your network a range a Platform Owner opened for your tenant with port 88. A connection through an SSH bastion still asks them directly, not through the tunnel.

**PostgreSQL, for your database administrator:**

1. Register the database's service principal `postgres/pg01.corp.example.com` on an account for the database server (`setspn -S postgres/pg01.corp.example.com CORP\svc_pg`) and export its keytab for the server: `ktpass /princ postgres/pg01.corp.example.com@CORP.EXAMPLE.COM /mapuser CORP\svc_pg /crypto AES256-SHA1 /ptype KRB5_NT_PRINCIPAL /pass * /out pg.keytab`. Point `krb_server_keyfile` in `postgresql.conf` at that file.
2. Accept the platform's account by Kerberos only, with TLS: in `pg_hba.conf` a line such as `hostssl shop svc_cavelon 203.0.113.0/24 gss include_realm=0 krb_realm=CORP.EXAMPLE.COM`, with the platform's outbound address. `include_realm=0` maps `svc_cavelon@CORP.EXAMPLE.COM` to the role `svc_cavelon`; a `pg_ident.conf` map works too.
3. Create that role read-only, as in [Network and read-only user](#network-and-read-only-user): `CREATE ROLE svc_cavelon LOGIN;` with `SELECT` on the tables the queries read, and no password.
4. On the connection, set **User** to the role's name (`svc_cavelon`). The platform answers only the server's Kerberos request and never sends a password for a Kerberos connection.

### Network and read-only user

Below the form, **Network and read-only user** has what you send to the database administrator:

- the outbound addresses to allow on the database port (**Copy addresses**);
- **Processes that run agents**: enter how many processes run agents on this instance. The panel multiplies it by the connections each process keeps and shows **Connections to allow**;
- a script for the chosen database type that creates the read-only user with that connection limit (**Copy SQL**).

![The network panel with the address to allow and the read-only user script](/docs-assets/academy/dbconn-network-panel.png)

### Per database type

| | PostgreSQL | MySQL and MariaDB | Microsoft SQL Server | Oracle Database | IBM Db2 |
|---|---|---|---|---|---|
| Default port | 5432 | 3306 | 1433 | 2484 (TCPS); 1521 for plain TCP | 50001 (its TLS port, `SSL_SVCENAME`); no plain TCP |
| Read-only user script | A login role with `CONNECTION LIMIT`, `default_transaction_read_only`, `SELECT` on one schema | One account per outbound address with `MAX_USER_CONNECTIONS` (and `REQUIRE SSL` unless TLS is off), `SELECT` on the database | A login and a database user that is a member of `db_datareader` only; no per-login limit | A profile with `SESSIONS_PER_USER`, a user with `CREATE SESSION` and `READ` on one schema's tables | `CONNECT` and `SELECTIN` on one schema for an operating-system or LDAP user (Db2 has no `CREATE USER`); no per-login limit |
| Read-only transaction | Yes | Yes | No: the login is the boundary, and the connection needs a passing write-privilege check (below) | Yes, and commits inside PL/SQL are refused | A read-only connection the server enforces; the connection needs a write-privilege check that finds no table function that modifies data (below) |
| Schema explorer schema | `public` first, listed only when it holds a table the user may read | The connection's database | `dbo` first; schemas without a readable table are not listed | Users that own a table or view the login may read; Oracle's own schemas are not listed | Schemas holding a table or view the login may read; Db2's own (`SYS*`, `NULLID`, `SQLJ`) are not listed |
| Quoted names | `"schema"."table"` | `` `schema`.`table` `` | `[schema].[table]` | `"SCHEMA"."TABLE"` (upper case unless created quoted) | `"SCHEMA"."TABLE"` (upper case unless created quoted) |
| Kerberos sign-in | Yes, where the instance offers it | No | Yes, where the instance offers it | No | No |
| Listener redirects | None | None | Availability group read-only routing, Azure SQL's Redirect policy: refused unless the connection follows redirects | RAC SCAN listener, shared-server dispatcher: refused unless the connection follows redirects | Automatic client reroute is never followed; use a virtual IP or a DNS name that follows the primary |
| Watch for | `:id::int` binds `:i`; write `CAST(:id AS int)` | `DATETIME` values are compared in UTC; a lone `SELECT SLEEP(n)` stopped by the timeout returns 1 | One stored-procedure call `EXEC [schema].[procedure] @p = :p, …` allowed, only on a login tested without write privileges; T-SQL statement keywords are refused; a server that redirects is refused unless the connection follows redirects; give the server a certificate | The database field is the service name; a listener that redirects (SCAN, shared server) is refused unless the connection follows redirects; no `RETURNING`, PL/SQL, `DBMS_*`/`UTL_*` or database links | TLS only; LOB and XML columns are refused (cast them to `VARCHAR`); no `RETURNING`, `ADMIN_*` routines, `DBMS_*`/`UTL_*` modules or external tables; the server needs the CLI packages bound |

**The login scripts.** The panel above prints the read-only script for the chosen type, with your database, user and connection limit filled in. The same scripts with placeholders, and the script for a separate write login, are in the [Database Administrator Checklist](/docs/administration/database-connector-checklist#1-create-a-read-only-user): [PostgreSQL](/docs/administration/database-connector-checklist#postgresql), [MySQL and MariaDB](/docs/administration/database-connector-checklist#mysql-and-mariadb), [SQL Server](/docs/administration/database-connector-checklist#microsoft-sql-server-and-azure-sql-database), [Oracle](/docs/administration/database-connector-checklist#oracle-database), [Db2](/docs/administration/database-connector-checklist#ibm-db2) and [write logins](/docs/administration/database-connector-checklist#optional-a-login-for-write-queries). A Kerberos login replaces the password user: the checklist's [Kerberos section](/docs/administration/database-connector-checklist#optional-kerberos-active-directory-sign-in) has the read rights for the service account.

### Compatible engines

An engine that speaks PostgreSQL's or MySQL's protocol is connected with that database type. The connection test's **Server version** step names the engine the server reports. The platform refuses engines known to ignore read-only (today TiDB, and any MySQL-type server that calls the read-only statement unsupported) with `engine_not_supported`, and a session that did not keep its read-only default or statement timeout, as behind a connection pooler, with `session_limits_not_applied` (behind PgBouncer: session mode, `ignore_startup_parameters=options` and the same limits as the login's defaults; see [the code](/docs/troubleshooting/database-connections#error-codes)). An engine not in the table below is untested: give it a login that may only read, which is what protects it. Which releases are tested, what works and the known limits: [Compatible engines](/docs/concepts/database-connections#compatible-engines).

| Engine | Database type | Port | TLS in the nightly test | Set up |
|---|---|---|---|---|
| TimescaleDB | PostgreSQL | 5432 | **Verify full** with an uploaded CA | As PostgreSQL. `SELECT` on a hypertable covers its chunks |
| Citus | PostgreSQL | 5432 | **Verify full** with an uploaded CA | As PostgreSQL, on the coordinator. Distributed and reference tables are read through it. Don't grant the login `EXECUTE` on Citus' administrative functions |
| YugabyteDB (YSQL) | PostgreSQL | 5433 | **Disable**, over a private target | As PostgreSQL; the YSQL API, not YCQL. With client TLS on, use **Verify full** and the cluster's CA |
| CockroachDB | PostgreSQL | 26257 | **Verify full** with the cluster's `ca.crt` | A secure cluster: a password login needs TLS. The PostgreSQL script works; also run `REVOKE CREATE ON SCHEMA public FROM public` in the database, or the write-privileges step reports that the user may create tables. Grant the login no system privilege but `VIEW…` ones, and no role option such as `CONTROLJOB` |
| Percona Server | MySQL | 3306 | **Require** | As MySQL |
| MariaDB Galera | MySQL | 3306 | **Require** | As MariaDB, against any node; tables must be InnoDB |
| TiDB | MySQL | 4000 | | Not supported: the test fails at **Login** with `engine_not_supported` |

## Step 2: Test the connection

Open the saved connection and click **Test connection**. The test runs DNS, network policy, TCP, TLS, login, `SELECT 1`, server version and write privileges, with an SSH bastion step and a Kerberos step where the connection uses them, and stops at the first step that fails.

![A passing connection test, step by step](/docs-assets/academy/dbconn-connection-test.png)

Read it from the top:

1. **DNS**: how many addresses the host has (through a bastion: the bastion's).
2. **Network policy**: `Connects to <address>`, the one address the platform will use, and `(inside a private network the platform operator opened)` or `(private target N)` when a range from the Admin or a configuration entry admitted it. Through a bastion it reads `Connects to the SSH bastion at <address>`.
3. **SSH bastion** (through a bastion only): the bastion's host key matched the fingerprint and the key signed in, `Signed in to the bastion: host key ssh-ed25519 matches`, with the cipher and `strict key exchange` when the bastion offers it.
4. **TCP**: `Port … open`; through a bastion, `The bastion reached port …` of the database.
5. **TLS**: the protocol, the certificate's subject, issuer and expiry, and what it was verified against: the uploaded CA, or the public bundle. With **Require**: `certificate not verified (require)`.
6. **Kerberos ticket** (Kerberos sign-in only): the principal, the service principal, the domain controller that answered, keytab or password, and the ticket's lifetime (ten minutes, renewed with every new connection). Once the database accepted the ticket it adds `server_verified_ticket`. On SQL Server, a login step that fails with `kerberos_auth_failed` and "Kerberos succeeded …" means the server verified the ticket and has no Windows login for the account.
7. **Login**: signed in, over TLS or not; on a connection that follows listener redirects, how many it followed and whether it ended on a private target or a public address.
8. **SELECT 1** and **Server version**: the session works, and which version answers.
9. **Write privileges**: `None found`, or a red `This user can write: …` naming what was found. Ask for a read-only user.

For a failed step you see the code, its meaning and the database driver's message with the password and user name removed. A connection without a password fails at **Login** with "No password is set: a person sets it in the Admin under Settings > Databases." What each failure means and how to fix it is in [Connection test](/docs/troubleshooting/database-connections#connection-test). The result becomes the connection's **Last test**. A query tool shows as **ready** only while its connection is enabled and its last test passed. The badge is a setup signal, not a switch: on PostgreSQL, MySQL and Oracle a query that is already assigned still runs after a failed test and fails at the same step. To stop a connection's queries, switch the connection off.

### SQL Server: a read-only login is required

SQL Server has no read-only transaction, so the login is what keeps a query from writing; every call is still rolled back afterwards. Queries on a SQL Server connection can be enabled only after a connection test of its current settings that found no write privileges (`database_connection_untested` otherwise). When the test finds some, the **Read-only login** panel says so and queries stay off (`write_privileges_unacknowledged`), and an already enabled query answers `unavailable`, until the login is replaced and tested again. The Owner can instead switch on **Queries may run although this login can write**: a recorded decision, kept in the audit log with the finding, which resets when the server or the user changes.

The platform connects to the address it checked and nothing else: a SQL Server that answers with a redirect to another server (Azure SQL's Redirect connection policy, an availability group's read-only routing) is refused, unless the connection follows redirects ([Listener redirects](#listener-redirects)). Azure SQL works with the Proxy policy. A SQL Server without a configured certificate presents one it generates at every start; give the server a certificate, or use **Require** over a private target.

A query may be one stored-procedure call, `EXEC [schema].[procedure] @param = :param, …`, every argument a placeholder. The platform cannot see what a procedure does, so such a query is saved, enabled and run only while the last test of the connection's current settings found no write privileges (`database_connection_untested` without one, `write_privileges_block_procedure` when it found some); **Queries may run although this login can write** does not count for it. The call runs in the same rolled-back transaction with the lock and statement timeouts. The model gets the first result set; further result sets are read and counted in the result's note, and a procedure without a result set answers "No rows matched." with a note. A procedure still writes its owner's tables for any login that may execute it (ownership chaining), so three more checks apply. Every save, enable, test run and import reads the procedure's definition through the connection's login (grant it `VIEW DEFINITION` on the procedure) and refuses one that changes anything but a temporary table (`#name`) or table variable (`@name`), creates or drops objects, commits or rolls back, calls another procedure or dynamic SQL, or reaches another server or a file (`procedure_definition_writes`), and one it cannot read: missing, `WITH ENCRYPTION`, or without `VIEW DEFINITION` (`procedure_definition_unreadable`). The call runs one transaction level deeper than the connector's own, so a single `COMMIT` inside the procedure is still rolled back. A procedure that ends the transaction anyway fails the call (`query_failed`), its query is switched off automatically (audit entry `database_query.disabled_automatically`), and the test run says whether its writes may be committed. A passing connection test lists the stored-procedure queries whose procedure no longer passes.

## Step 3: Explore the schema

Click **New query**, choose the connection, and click **Show schema** beside the SQL box. The side panel lists what the connection's user may read: pick a schema, filter its tables, and expand a table for its columns with their data types. A click inserts the name at the cursor, quoted for the database type. On PostgreSQL and SQL Server a schema is listed only when it holds a table or view the user may read, so the panel opens on `public` only when there is something to read in it, and otherwise on the first schema that has.

![The schema explorer beside the SQL editor](/docs-assets/academy/dbconn-schema-explorer.png)

The panel shows at most 500 schemas, and 500 tables and 2,000 columns of one schema. It reads only the database's catalog, in the same read-only transaction and under the same statement timeout as a query, and each look is recorded in the audit log with counts, never names. Only the Owner and a superadmin in Tenant mode use it. When the catalog cannot be read, the panel shows the error code, its meaning and the driver's message with the password removed.

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

1. In the query, leave **Enabled** on (or turn it on) and save. On SQL Server and Db2 this needs the passing write-privilege check of Step 2.
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

## Write queries

A write query changes rows: one `INSERT`, `UPDATE` or `DELETE`, or on SQL Server one call of a procedure that writes. The concept, the rules and what the person sees are in [Write queries](/docs/concepts/database-connections#write-queries).

1. **Ask for a write login on its own connection.** The customer's database administrator creates a second login that may change only the tables the write queries need ([script per database type](/docs/administration/database-connector-checklist#optional-a-login-for-write-queries)). Create a separate connection for it, for example `shop-db-writes`, and test it. Its write privileges show as a warning until writes are allowed.
2. **Allow writes.** **Allow write queries** on the connection is the customer's own decision: a member with the **Owner** or **Admin** role switches it on under Settings › Databases, signed in to the Admin; a personal access token cannot. A superadmin switches it only while holding that tenant role. While it is off, the connection's write queries do not run, test runs included.
3. **Write the query.** Set **Kind** to **Write**. An `UPDATE` or `DELETE` needs a `WHERE` with a parameter; name one row by its key and, for a signed-in customer, their identity:

```sql
UPDATE orders
SET status = 'cancelled'
WHERE order_number = :order_number
  AND email = :email
  AND status = 'open'
RETURNING order_number, status
```

4. **Set the cap, the calls and the confirmation.** **Rows a call may change at most** is 1 by default, at most 100; more changed rows roll the call back. **Calls per run at most** is 1 by default, up to 1,000: per user turn for an agent, and for a whole workflow run. Leave **Ask the person to confirm before writing** on unless a workflow writes unattended. Off, the query runs only in a run a schedule, a webhook with its secret header or **Run now** started, or when the run's latest **Approval** decision was an approval; in a chat, an email, channel or calendar run it answers `write_needs_confirmation` ([Who calls a write query](/docs/concepts/database-connections#who-calls-a-write-query)).
5. **Test it.** **Run dry run** in the query's **Test run** panel runs a write query as a dry run: inside a transaction that is always rolled back. It shows how many rows it would change and what `RETURNING` gave back, and nothing is saved. There is no way to run it for real from the Admin; the first real write is the agent's, after the person confirmed.
6. **Assign it.** The tool is called at most once per user message unless an assignment raises its cap. A tenant governance policy can deny write queries or require an administrator's approval.

## Queries in solution packages

A query travels in a solution package; its connection does not, only its name and dialect. Importing a package into a tenant needs a connection with the same name and dialect whose last test passed, so create and test the connection first, then import the package: in the Admin on the solution's **Agents** page (**Import JSON**), or with your personal access token (`cavelon apply`). The Owner's import creates and changes the queries. Anyone else's import, a Builder's or a token capped to Builder, is blocked with `database_query_needs_superadmin` for each query it would create or change; once the queries match, it passes for anyone who may import. The details and every import blocker are in [Solution packages](/docs/concepts/database-connections#solution-packages).

A test, staging or CI tenant needs its own connection with the same name, created by that tenant's Owner. `localhost` and the platform's own containers are refused, so a test database in a container is reached through a private target the instance operator sets for that tenant.

## Instance settings

These are not tenant settings. The instance operator sets them for the whole instance, and each takes effect at the next start of the platform. Ask the operator when one of them stands in your way.

| Setting | Default | What it does |
|---|---|---|
| `DATABASE_CONNECTOR_ENABLED` | `false` | The switch for the whole feature. While off, the Databases section, its docs pages and every database tool are hidden, and a running conversation's database tool answers `unavailable`. Turn it on per environment |
| `DATABASE_CONNECTOR_DB2_ENABLED` | `false` | IBM Db2, on request. While off, the form does not offer Db2; creating a Db2 connection, changing one to Db2, or importing a package whose query needs one answers `dialect_not_enabled`; and an existing one answers `unavailable` |
| `DATABASE_CONNECTOR_EGRESS_IPS` | empty | The outbound IP addresses customers allowlist, comma-separated. Display only: the connection form shows them; nothing routes by them |
| `DATABASE_CONNECTOR_PRIVATE_TARGETS` | `[]` | JSON list of `{"tenant_id", "cidr", "ports"}`: read-only private targets beside the ranges a Platform Owner opens in the Admin |
| `DATABASE_CONNECTOR_PRIVATE_TARGET_WIDEST_IPV4_PREFIX` | `16` | The widest IPv4 range a private target may name (16-32); it can only narrow the /16 limit |
| `DATABASE_CONNECTOR_PRIVATE_TARGET_WIDEST_IPV6_PREFIX` | `48` | The same for IPv6 (48-128) |
| `DATABASE_CONNECTOR_PRIVATE_TARGETS_CACHE_SECONDS` | `5` | A fallback re-read of a tenant's ranges; every add or removal takes effect at once in every process anyway |
| `DATABASE_CONNECTOR_STATEMENT_TIMEOUT_MS_MAX` | `30000` | Largest statement timeout a connection may be saved with (at least 100) |
| `DATABASE_CONNECTOR_MAX_ROWS_MAX` | `500` | Largest **Rows the model gets at most** (at least 1) |
| `DATABASE_CONNECTOR_MAX_RESULT_CHARS_MAX` | `20000` | Largest **Characters the model gets at most** (at least 500) |
| `DATABASE_CONNECTOR_CONNECT_TIMEOUT_SECONDS` | `5` | Seconds for TCP, TLS and login of one new connection (2-60) |
| `DATABASE_CONNECTOR_MAX_FETCH_BYTES` | `1048576` | Bytes read per call before fetching stops (at least 65,536) |
| `DATABASE_CONNECTOR_POOL_SIZE` | `2` | Connections per database connection per process (1-20); the customer sees this times the processes that run agents |
| `DATABASE_CONNECTOR_MAX_THREADS` | `8` | Threads per process that run customer queries (1-64) |
| `DATABASE_CONNECTOR_MAX_THREADS_PER_TENANT` | `0`: a quarter of the threads | How many of those one tenant's calls may hold at once (0-64); the next answers `busy`, and other tenants keep running |
| `DATABASE_CONNECTOR_MAX_CONNECTIONS_PER_TENANT` | `10` | Connections one tenant may hold (1-1,000); a tenant's own limit is set under **Settings › Limits** |
| `DATABASE_CONNECTOR_MAX_QUERIES_PER_TENANT` | `200` | Queries one tenant may hold (1-10,000); a tenant's own limit is set under **Settings › Limits** |
| `DATABASE_CONNECTOR_RUN_RETENTION_DAYS` | `90` | Days the run evidence is kept; `0` keeps it forever |
| `REALTIME_TOOL_SESSION_CALL_CEILING_FACTOR` | `10` | In voice, a capped tool runs at most its cap times this factor per session; `0` turns the ceiling off |

### The outbound address

The instance operator records the address the platform's traffic leaves from in `DATABASE_CONNECTOR_EGRESS_IPS`. Customers allowlist it, so it is a commitment: when it changes, the operator lists both addresses while customers move. Allowlist IPv4 only; the connector prefers an IPv4 answer.

### Private targets: a database behind a VPN

A database inside the customer's own network has no public address. The path to it is a site-to-site VPN between the customer's network and the platform's host, plus a private target that opens the database's range to that one tenant:

1. The customer and the instance operator set up the VPN, so that the host routes the customer's range (for example `10.40.12.0/24`) through it.
2. A Platform Owner opens the range for the tenant in the Admin: **Platform › Tenants**, open the tenant, **Database network**, then the range, its ports and a note, and **Add range**. A single address as `/32` is safest.
3. The tenant Owner creates the connection with the database's private name or address. The connection's **Network** section lists the ranges opened for the tenant (not the operator's notes), and the connection test's network step says the address is inside one of them.

A private target admits only its own tenant, only addresses inside its range and only its ports (1024-65535, listed one by one; there is no "all ports"). Below 1024 it takes only 22 for an SSH bastion and 88 for a Kerberos domain controller, each listed explicitly, and the platform never connects to a database on either. A range belongs to one tenant: one that overlaps another tenant's range is refused, because the network cannot tell two tenants apart. Only a Platform Owner, signed in to the Admin, adds or removes one: no tenant role, Platform Admin, personal access token or API key can, and every change, and every refused add, is written to the tenant's audit log. A removed range refuses new connections at once, on every server of the platform, and drops pooled ones before their next use.

The Admin refuses a range that touches loopback, link-local or cloud metadata (`169.254.169.254`, `fd00:ec2::254`, `fd20:ce::254`), the shared address space `100.64.0.0/10`, multicast or reserved space, IPv6 forms that carry an IPv4 address (IPv4-mapped, IPv4-compatible, NAT64 including `64:ff9b:1::/48`, 6to4, Teredo), `0.0.0.0/0` or `::/0`, one wider than the instance allows (a /16 for IPv4 and a /48 for IPv6 by default; `DATABASE_CONNECTOR_PRIVATE_TARGET_WIDEST_IPV4_PREFIX` and `…_IPV6_PREFIX` narrow it), and one that overlaps the platform's own container networks or holds the address of one of its services, the object storage, the SMTP server, its public host name or the Docker host. The connector checks every range again where it uses it, so a range that clashes later is listed as **not used** and admits nothing.

`DATABASE_CONNECTOR_PRIVATE_TARGETS` stays as a read-only bootstrap for an instance without the Admin's ranges. Its entries pass the same checks (startup fails on a forbidden one) and show in the Admin as **from configuration**:

```env
DATABASE_CONNECTOR_PRIVATE_TARGETS=[{"tenant_id":"<tenant id>","cidr":"10.40.12.0/24","ports":[5432]}]
```

An entry that contains an address of the process's own network interfaces admits nothing and is logged at startup as `database_private_target_refused`. Unlike a range in the Admin, an entry may lie inside a Docker network on the host, which is how a development or CI stack admits a test database's container address. Every admission is logged at WARNING as `database_private_target_admitted` with the tenant id and the entry's index or the Admin range's id, never the address. For a test database in a container, open that container's address as a `/32` for the test tenant.

### Drivers

The standard images carry the drivers for all five database types: psycopg2 for PostgreSQL, PyMySQL for MySQL and MariaDB, python-tds with pyOpenSSL for SQL Server, python-oracledb in thin mode (no Oracle Client libraries) for Oracle, and for Db2 the platform's own client, without IBM's client libraries. A host without one of them keeps running; that database type is shown disabled in the connection form, and its connections answer `unavailable`.

**Db2 is available on request:** the platform operator turns it on per instance (`DATABASE_CONNECTOR_DB2_ENABLED`); until then the form does not list it and creating a Db2 connection is refused (`dialect_not_enabled`). SSH tunnels need the SSH library the standard images carry; an instance without it answers `unavailable` for tunneled connections only. Kerberos needs the system's MIT krb5 1.21.3 or later, and for PostgreSQL a driver built against it, which the standard images carry; `kerberos_dialects` in `GET /api/v1/database-connectors/instance` lists the database types this instance can sign in to with Kerberos.

## Related pages

- [Live Database Connections](/docs/concepts/database-connections): parameters, identity, limits, packages and testing.
- [Database Connector Reference](/docs/reference/database-connector-settings): every field with its default and bounds, the gates, the API and the audit actions.
- [Database Connectors](/docs/administration/database-connectors): what the other tenant roles see, password rotation, tokens and run evidence.
- [Database Administrator Checklist](/docs/administration/database-connector-checklist): what your database administrator prepares.
- [Writing Safe Database Queries](/docs/concepts/writing-safe-database-queries): identity, second factors and limits.
- [Troubleshooting Database Connections](/docs/troubleshooting/database-connections): every error code and test step.
- [Platform Mode](/docs/administration/platform-mode): Platform and Tenant mode.
- [Audit Log](/docs/administration/audit-log): where connection and query changes, tests and test runs are recorded.

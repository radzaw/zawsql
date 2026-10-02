# ZawSQL

A lightweight MySQL / MariaDB desktop client in the spirit of HeidiSQL, written in C#.

The backend is an ASP.NET Core app that talks to the database (via [MySqlConnector](https://mysqlconnector.net/)). The UI is plain HTML/CSS/JS embedded in the executable. ZawSQL opens it in a chromeless **app-mode window** of an installed Chromium browser (Chrome, Edge, Chromium or Brave), so it looks and behaves like a desktop window on **Windows, Linux and macOS**. Closing the window quits the app.

## Features

- **Session manager**: saved connections (TCP/IP or Unix socket), SSL modes, compression, database filter, connection test. Saved passwords are encrypted (AES-GCM) with a per-user key.
- **Session colors and production mark** (session manager):
  - **Color:** pick a color per session. The tree shows a colored stripe and tint, a line runs above the tabs, and the status bar shows it.
  - **"Production server":** adds a PROD badge, a PRODUCTION status-bar marker and `[PRODUCTION]` in the window title. Every change asks for confirmation first: data- or schema-changing statements in query tabs (read-only queries run without asking), grid edits, structure and routine saves, Run SQL file, create database and user-manager changes. The dialog lists the statements and offers "don't ask again until I reconnect".
  - **Every session:** `UPDATE`/`DELETE` without a `WHERE` clause asks before running. This can be switched off in Preferences.
- **Read-only mode** (a checkbox per session in the session manager): nothing can be changed through that connection. The tree and status bar show a red READ-ONLY badge, and editing, structure saving, drop/truncate/rename, Run SQL file and kill are disabled. The backend enforces it in two layers:
  1. Only `SELECT`, `WITH`, `SHOW`, `DESCRIBE`, `EXPLAIN`, `USE`, `TABLE`, `VALUES` and `HELP` statements may run. `SET`, `CALL`, DDL, `INTO OUTFILE` and executable `/*! */` comments are refused, as are data changes hidden in `WITH … DELETE` or several statements packed into one.
  2. The connection runs with `SET SESSION TRANSACTION READ ONLY`, so MySQL itself also rejects writes that the first layer can't see, such as a stored function called from a `SELECT` that modifies data.
- **Object tree**: sessions › databases › tables, views, procedures, functions, triggers, events, with sizes. Database/table filter boxes, keyboard navigation, context menus.
- **Host tab**: databases with sizes, session/global variables, status, process list (auto-refresh, kill).
- **Database tab**: all objects with rows, size, dates, engine, collation and comment.
- **Table tab**: structure editor for columns, indexes, foreign keys and options. It shows live **CREATE / ALTER code** and saves with a single ALTER. Views, routines, triggers and events open in a code editor.
- **Partition editor** (Table tab › Partitions): RANGE, RANGE COLUMNS, LIST, LIST COLUMNS, (LINEAR) HASH and (LINEAR) KEY, with a partition list (values, comments, row counts and sizes) or a partition count.
  - Appending RANGE/LIST partitions uses `ADD PARTITION`. Every other change redefines the partitioning, so MySQL refuses changes that would leave rows without a partition instead of silently deleting them.
  - Tables with subpartitions are shown but read-only in the editor.
- **User manager** (Tools menu, toolbar, or right-click a session): list, add, clone, rename and delete accounts. Set passwords, account lock and resource limits. Edit privileges on the global, database, table, column and routine level (including MySQL 8 dynamic privileges and `WITH GRANT OPTION`) and granted roles.
  - Changes become minimal `GRANT`/`REVOKE`/`ALTER USER` statements, shown in an SQL preview before saving.
  - Passwords never reach the SQL log or query history.
  - Read-only sessions can view accounts but not change them.
- **Data tab**: virtualized grid with paging, sorting, WHERE filter, quick search and quick filters. You can edit in place (enum dropdowns, multi-line editor), insert, delete and set NULL. It works on tables without a primary key too.
- **Query tabs**: SQL editor with syntax highlighting, line numbers and autocompletion (tables, columns incl. aliases, keywords, functions). Run all, the selection or the current statement. Supports `DELIMITER` and multiple result sets, has a Stop button and query history. Tabs are restored on the next start.
- **Editable query results**: when a result's table columns all come from one table and include its primary/unique key, you can edit, insert and delete rows right in the result grid (aliased columns work too; computed columns stay read-only). The header shows "Editable: db.table", or "Read-only" with the reason as a tooltip.
- **Export / import**: dump a database or selected tables to SQL (structure, data, routines, triggers, events). Export grid rows as CSV, TSV, SQL, JSON, Markdown or HTML. Run large SQL files with a progress dialog.
- SQL log panel, status bar, light/dark theme.

## Requirements

- To build: [.NET 10 SDK](https://dotnet.microsoft.com/download)
- To run: any Chromium-based browser for the app window (Chrome, Edge, Chromium, Brave). If none is found, ZawSQL opens the default browser.

## Run from source

```sh
cd src/ZawSQL
dotnet run
```

## Build standalone executables

```sh
./publish.sh                 # Linux/macOS shell
./publish.ps1                # PowerShell
./publish.sh linux-x64       # just one platform
```

Output goes to `dist/<runtime>/`, one self-contained file per platform (about 50 MB). No .NET installation is needed on the target machine.

> **Windows note:** Smart App Control / application-control policies may block a self-built, unsigned `ZawSQL.exe`. Either sign the executable or run the framework-dependent build with `dotnet ZawSQL.dll` (`./publish.ps1 -FrameworkDependent`).

## Command line

```
ZawSQL [options]
  --port <n>        Listen on this local port (default: random free port)
  --no-browser      Don't open an app window; print the URL instead (implies --keep-alive)
  --keep-alive      Keep running after the last window is closed
  --browser <path>  Chromium-based browser used for the app window
  --config <dir>    Configuration directory (saved sessions, UI state)
```

Configuration is stored in `%APPDATA%\ZawSQL` on Windows and `~/.config/ZawSQL` on Linux and macOS.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| F5 | Refresh |
| F9 / Ctrl+F9 / Ctrl+Shift+F9 (Ctrl+Enter) | Execute all / selection / current statement |
| Ctrl+Space | Autocomplete (also opens after typing `.`) |
| Ctrl+/ | Toggle comment |
| Ctrl+T | New query tab |
| F2, Enter or typing | Edit grid cell (Ctrl+Enter applies multi-line edits) |
| Insert / Ctrl+Delete | Insert row / delete selected rows |
| Ctrl+Shift+N | Set cell to NULL |
| Esc | Cancel edit |

## Security model

- The backend listens on `127.0.0.1` only.
- Every API call needs a random per-process token, which is passed to the app window in the URL fragment. Other local web pages can't use the backend.
- Saved passwords are encrypted with a random key in the configuration directory (file mode `0600` on Unix). This keeps them out of plain sight, but it doesn't replace OS account security.

## Architecture

```
src/ZawSQL/
  Program.cs            host setup, token check, embedded static files, browser launch
  Api.cs                minimal-API endpoints (/api/...)
  ConnectionManager.cs  per-session main connection + pooled metadata connections
  TableMeta.cs          columns / indexes / foreign keys / SHOW CREATE
  RowWriter.cs          grid edits -> INSERT / UPDATE / DELETE
  SqlDumper.cs          SQL export
  SessionStore.cs       saved sessions + UI state (JSON)
  Heartbeat.cs          exits when the last window closes
  BrowserLauncher.cs    finds Chrome/Edge/Chromium and opens an --app window
  wwwroot/              UI (no build step, no external dependencies)
    js/app.js           layout, menus, tabs, tree actions, autocompletion
    js/grid.js          virtualized editable grid
    js/editor.js        SQL editor
    js/views/*.js       Host, Database, Table, Data, Query tabs and dialogs
```

Each connected session has one **main connection**. Query tabs and grid edits run on it, so `USE`, variables, temporary tables and transactions persist as in HeidiSQL. Tree browsing and metadata use short-lived pooled connections, so they don't wait for a long-running query.

## Not (yet) implemented

SSH tunnels, table maintenance tools, CSV import, subpartition editing.

# Supabase test project setup

This sets up a **scratch** Supabase project for testing Entanglement's Supabase adapter. The contract tests sign up throwaway users (`entanglement-…@example.test`) and write test data, so **do not use Quadra's real project** for this. Quadra's project gets the same SQL later, during the client migration, and not before.

Total time: about 10 minutes, most of it waiting for the project to provision.

## 1. Create the project

1. In the Supabase dashboard, create a **New project**. Any name (e.g. `entanglement-test`), any region, and the free tier is fine.
2. Save the database password it generates somewhere; I won't need it.
3. Wait until the dashboard shows the project as ready.

## 2. Configure auth

Go to **Authentication → Sign In / Providers**:

- **Email** provider: enabled (it is by default).
- **Allow new users to sign up**: on.
- **Confirm email**: **off**. Without this, test sign-ups get no session and every test fails immediately.

Nothing else needs changing: no SMTP, OAuth providers or redirect URLs.

## 3. Run the SQL

1. Open **SQL Editor → New query**.
2. Paste the **entire** contents of [`packages/entanglement_supabase/supabase/migrations/0001_entanglement.sql`](../packages/entanglement_supabase/supabase/migrations/0001_entanglement.sql) and click **Run**. It should finish with "Success. No rows returned".

The script is idempotent, so running it twice is harmless. It creates:

- **Four tables that clients can only read**, each limited to the user's own rows: `ent_heads`, `ent_commits`, `ent_checkpoints` and `ent_restore_points`.
- **Five functions that are the only way to write:** `ent_submit`, `ent_put_checkpoint`, `ent_put_restore_point`, `ent_delete_restore_points` and `ent_compact`.
- **Realtime notifications** on `ent_heads`, which holds only revision numbers, so no user data goes over the socket.

## 4. Verify

Run this in a new query:

```sql
select 'table' as kind, table_name as name
  from information_schema.tables
  where table_schema = 'public' and table_name like 'ent\_%'
union all
select 'function', routine_name
  from information_schema.routines
  where routine_schema = 'public' and routine_name like 'ent\_%'
union all
select 'policy', policyname
  from pg_policies
  where schemaname = 'public' and tablename like 'ent\_%'
union all
select 'realtime', tablename
  from pg_publication_tables
  where pubname = 'supabase_realtime' and tablename like 'ent\_%'
order by 1, 2;
```

You should get **14 rows**:

| kind | name |
|---|---|
| function | ent_compact |
| function | ent_delete_restore_points |
| function | ent_put_checkpoint |
| function | ent_put_restore_point |
| function | ent_submit |
| policy | ent_checkpoints_select_own |
| policy | ent_commits_select_own |
| policy | ent_heads_select_own |
| policy | ent_restore_points_select_own |
| realtime | ent_heads |
| table | ent_checkpoints |
| table | ent_commits |
| table | ent_heads |
| table | ent_restore_points |

If the `realtime` row is missing, the project has no `supabase_realtime` publication, which is unusual. Tell me: sync still works without it, but the hint test will fail.

## 5. Check the Data API

Go to **Project Settings → Data API**. Make sure the Data API is enabled and `public` is listed under **Exposed schemas**. Both are the defaults.

## 6. Send me two values

From **Project Settings → API Keys** (or **Data API**):

- **Project URL**: `https://<ref>.supabase.co`
- **Publishable key** (`sb_publishable_…`) or the legacy **anon** key. Either works.

**Do not send the secret / `service_role` key.** Nothing needs it, and it bypasses row-level security.

## What I'll run with them

The same contract suite that the in-memory reference server passes, against your project, from both implementations:

```bash
cd Entanglement/packages/entanglement_supabase
ENTANGLEMENT_SUPABASE_URL=https://<ref>.supabase.co ENTANGLEMENT_SUPABASE_ANON_KEY=<key> dart test
```

and the TypeScript equivalent. The suite covers:

- compare-and-swap commits;
- retry recognition;
- the schema gate;
- commit ordering;
- restore points;
- checkpoint verification;
- compaction;
- isolation between two accounts;
- realtime hints.

## Cleaning up afterwards

The tests leave throwaway users behind. To delete them and, through the foreign keys, all of their data:

```sql
delete from auth.users where email like 'entanglement-%@example.test';
```

Or delete the whole project when we're done with it.

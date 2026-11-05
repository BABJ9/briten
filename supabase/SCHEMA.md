# Supabase schema deployment record

The connected Supabase project `nopjflcndafxuvvxpmqg` was empty when this migration began. The following migrations were applied successfully on 2026-11-02 and verified with the Supabase schema inspector:

| Version | Migration name |
|---|---|
| `20261102161322` | `aurapay_supabase_core_schema` |
| `20261102161353` | `restrict_provider_event_table` |
| `20261102161611` | `grant_server_access_to_aurapay_tables` |

Tables created (all have RLS enabled):

- `aurapay_profiles`
- `aurapay_accounts`
- `aurapay_payment_links`
- `aurapay_kyc_checks`
- `aurapay_transfers`
- `aurapay_wallets`
- `aurapay_wallet_ledger`
- `aurapay_bill_purchases`
- `aurapay_provider_events`

Server-only RPC functions:

- `aurapay_credit_wallet`
- `aurapay_reserve_transfer`
- `aurapay_record_transfer_provider`
- `aurapay_settle_transfer`
- `aurapay_credit_payment_link`
- `aurapay_record_provider_event`

The balance-moving RPC functions have `EXECUTE` revoked from `PUBLIC`, `anon`, and `authenticated`, and granted to `service_role`. `aurapay_provider_events` is explicitly blocked to client roles.

The live Supabase migration history is authoritative. These changes were applied remotely using the connected Supabase management integration; the SQL text is retained in that project's migration history. Before recreating this database in a different Supabase project, export the schema/functions from the current project and review the SQL rather than applying the legacy Hatchable migrations.

# Agent instructions

## Knowledge hub (shared source of truth)

All agents and dashboards (Primary Freight Dashboard, Fiveninesopsreport, Gbots) share one append-only knowledge hub in the main Supabase project (`knowledge` schema). Full spec: [docs/knowledge-hub.md](https://github.com/Csturma12/primary-freight-dashboard/blob/main/docs/knowledge-hub.md).

This app uses the main Supabase project with the service role key, so server code and agents call the RPCs directly (`supabase.rpc('knowledge_search', ...)`, `supabase.rpc('knowledge_contribute', {..., p_source_system: 'fivenines_ops'})`). Panel knowledge rules (`/api/panel/knowledge`) are still kept in memory; a follow-up will save them to the hub as proposals.


> **Knowledge hub: source of truth.** Before acting on a customer, carrier,
> facility, lane or process, call `knowledge_search` and follow approved
> entries over memory, prompts or email guesses. If the hub conflicts with live
> TAI data, TAI wins for shipment facts: flag the entry with `knowledge_review`
> (`flag`) and contribute a correction with `p_supersedes`.
>
> **Write what you learn.** When you confirm something reusable (a rule,
> contact, appointment requirement, pricing policy, or what fixed an exception),
> call `knowledge_contribute` with evidence: thread IDs, load numbers or
> source rows. Never write secrets, passwords, card or bank numbers, or driver
> license details.
>
> **Check for duplicates.** On `duplicate`, stop: it is already known. On
> `near_duplicate`, read the matches and resubmit with `p_supersedes` or
> `p_reviewed_keys`. Never try to edit or delete. The database will refuse.
>
> **Grow the knowledge base.** Each week, propose 2-3 new learning topics or
> datasets with `knowledge_propose_topic`. Each one must help agents work better
> **and** fill a section of the employee handbook (`p_handbook_section`). Name
> the source tables it would come from. If a similar topic exists, your call
> becomes an endorsement. That is expected, so add a better rationale instead
> of a new title.
>
> **One place to write.** Write new knowledge only through
> `knowledge_contribute`. Do not insert into `learning.lessons`,
> `learning.rules` or `public.freight_knowledge` directly; those are read
> through the hub. Keep your existing author name as `p_author` (for example
> `grokbot-voice-playbook`, `antigravity-centralization`,
> `claude:customer-knowledge`) and use `p_source_system = 'agent'` unless you
> run inside PFD (`pfd`), Fiveninesopsreport (`fivenines_ops`) or Gbots (`gbots`).
>
> **Handbook.** When you write process knowledge that a new hire should read,
> set `p_kind = 'handbook'` and the matching `p_handbook_section`. Chris
> approves it before it appears as final in `knowledge.handbook`.

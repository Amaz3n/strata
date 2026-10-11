-- Proposal lines sit under the division wall like every other child row
-- (20261011210000 named them in its header but missed them in its list): a line
-- is visible, and writable, only when its proposal is. The EXISTS runs as the
-- caller, so it inherits the proposal's org and division policies.

do $$
begin
  if to_regclass('public.proposal_lines') is not null and to_regclass('public.proposals') is not null then
    drop policy if exists proposal_lines_division_scope on public.proposal_lines;
    create policy proposal_lines_division_scope on public.proposal_lines
      as restrictive
      for all
      to authenticated
      using (proposal_id is null or exists (select 1 from public.proposals p where p.id = proposal_lines.proposal_id))
      with check (proposal_id is null or exists (select 1 from public.proposals p where p.id = proposal_lines.proposal_id));
  end if;
end
$$;

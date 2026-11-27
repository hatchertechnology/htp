-- Dedicated local PG17 stack only. The runner creates :owner_id in local Auth.
-- Hashes correspond to fixture-only local tokens; never use these outside tests.
insert into public.websites(id,owner_id,fqdn) values
  ('11111111-1111-4111-8111-111111111111', :'owner_id', 'www.kerryhatcher.com'),
  ('22222222-2222-4222-8222-222222222222', :'owner_id', 'fixture.example');
insert into public.seosmith_bindings(website_id,token_sha256) values
  ('11111111-1111-4111-8111-111111111111', :'real_token_sha256'),
  ('22222222-2222-4222-8222-222222222222', :'fixture_token_sha256');
update public.seosmith_s14_validators
set enabled = true
where revision = 's14-wire-2/full-population-1/evidence-v1/families-v1';

create extension if not exists "pgcrypto";

create table if not exists public.records (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('text', 'photo', 'audio')),
  body text,
  file_url text,
  thumbnail_url text,
  latitude double precision not null,
  longitude double precision not null,
  accuracy double precision,
  submitted_at timestamptz default now(),
  metadata jsonb default '{}'::jsonb
);

create table if not exists public.graph_nodes (
  record_id uuid primary key references public.records(id) on delete cascade,
  x double precision not null,
  y double precision not null,
  width double precision default 180,
  height double precision default 96,
  updated_at timestamptz default now()
);

create table if not exists public.graph_edges (
  id uuid primary key default gen_random_uuid(),
  source_record_id uuid not null references public.records(id) on delete cascade,
  target_record_id uuid not null references public.records(id) on delete cascade,
  weight double precision default 1,
  label text,
  updated_at timestamptz default now(),
  unique(source_record_id, target_record_id)
);

create table if not exists public.clusters (
  id uuid primary key default gen_random_uuid(),
  name text,
  center_latitude double precision,
  center_longitude double precision,
  color text,
  metadata jsonb default '{}'::jsonb
);

create table if not exists public.cluster_members (
  cluster_id uuid references public.clusters(id) on delete cascade,
  record_id uuid references public.records(id) on delete cascade,
  score double precision default 1,
  primary key (cluster_id, record_id)
);

alter table public.records enable row level security;
alter table public.graph_nodes enable row level security;
alter table public.graph_edges enable row level security;
alter table public.clusters enable row level security;
alter table public.cluster_members enable row level security;

drop policy if exists "public records select" on public.records;
drop policy if exists "public records insert" on public.records;
drop policy if exists "public records update" on public.records;
drop policy if exists "public records delete" on public.records;
create policy "public records select" on public.records for select to anon using (true);
create policy "public records insert" on public.records for insert to anon with check (true);
create policy "public records update" on public.records for update to anon using (true) with check (true);
create policy "public records delete" on public.records for delete to anon using (true);

drop policy if exists "public graph nodes select" on public.graph_nodes;
drop policy if exists "public graph nodes insert" on public.graph_nodes;
drop policy if exists "public graph nodes update" on public.graph_nodes;
drop policy if exists "public graph nodes delete" on public.graph_nodes;
create policy "public graph nodes select" on public.graph_nodes for select to anon using (true);
create policy "public graph nodes insert" on public.graph_nodes for insert to anon with check (true);
create policy "public graph nodes update" on public.graph_nodes for update to anon using (true) with check (true);
create policy "public graph nodes delete" on public.graph_nodes for delete to anon using (true);

drop policy if exists "public graph edges select" on public.graph_edges;
drop policy if exists "public graph edges insert" on public.graph_edges;
drop policy if exists "public graph edges update" on public.graph_edges;
drop policy if exists "public graph edges delete" on public.graph_edges;
create policy "public graph edges select" on public.graph_edges for select to anon using (true);
create policy "public graph edges insert" on public.graph_edges for insert to anon with check (true);
create policy "public graph edges update" on public.graph_edges for update to anon using (true) with check (true);
create policy "public graph edges delete" on public.graph_edges for delete to anon using (true);

drop policy if exists "public clusters select" on public.clusters;
drop policy if exists "public clusters insert" on public.clusters;
drop policy if exists "public clusters update" on public.clusters;
drop policy if exists "public clusters delete" on public.clusters;
create policy "public clusters select" on public.clusters for select to anon using (true);
create policy "public clusters insert" on public.clusters for insert to anon with check (true);
create policy "public clusters update" on public.clusters for update to anon using (true) with check (true);
create policy "public clusters delete" on public.clusters for delete to anon using (true);

drop policy if exists "public cluster members select" on public.cluster_members;
drop policy if exists "public cluster members insert" on public.cluster_members;
drop policy if exists "public cluster members update" on public.cluster_members;
drop policy if exists "public cluster members delete" on public.cluster_members;
create policy "public cluster members select" on public.cluster_members for select to anon using (true);
create policy "public cluster members insert" on public.cluster_members for insert to anon with check (true);
create policy "public cluster members update" on public.cluster_members for update to anon using (true) with check (true);
create policy "public cluster members delete" on public.cluster_members for delete to anon using (true);

insert into storage.buckets (id, name, public)
values ('record-media', 'record-media', true)
on conflict (id) do update set public = true;

drop policy if exists "public media select" on storage.objects;
drop policy if exists "public media insert" on storage.objects;
drop policy if exists "public media update" on storage.objects;
drop policy if exists "public media delete" on storage.objects;
create policy "public media select"
on storage.objects for select to anon
using (bucket_id = 'record-media');

create policy "public media insert"
on storage.objects for insert to anon
with check (bucket_id = 'record-media');

create policy "public media update"
on storage.objects for update to anon
using (bucket_id = 'record-media')
with check (bucket_id = 'record-media');

create policy "public media delete"
on storage.objects for delete to anon
using (bucket_id = 'record-media');

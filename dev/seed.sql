-- Sample data that exercises the grid: big ints, NULL vs '', jsonb, arrays, timestamptz, bytea, enums, wide rows.
create type plan as enum ('free', 'pro', 'enterprise');

create table users (
  id          bigint primary key,
  email       text not null,
  display     text,
  plan        plan not null default 'free',
  tags        text[],
  meta        jsonb,
  avatar      bytea,
  balance     numeric(14, 2) not null default 0,
  created_at  timestamptz not null default now(),
  last_login  timestamptz
);

insert into users (id, email, display, plan, tags, meta, avatar, balance, created_at, last_login)
select
  case when g = 1 then 9007199254740993 else g end,
  'user' || g || '@example.com',
  case when g % 7 = 0 then null when g % 11 = 0 then '' else 'User ' || g end,
  (array['free', 'pro', 'enterprise'])[1 + g % 3]::plan,
  case when g % 5 = 0 then array['beta', 'early adopter'] else array['x'] end,
  jsonb_build_object('plan_seats', g % 50, 'flags', jsonb_build_array('a', 'b'), 'note', repeat('long text ', g % 3 * 40)),
  case when g % 13 = 0 then decode(md5(g::text), 'hex') end,
  round((random() * 100000)::numeric, 2),
  now() - (g || ' minutes')::interval,
  case when g % 4 = 0 then null else now() - (g || ' hours')::interval end
from generate_series(1, 50000) g;

create table invoices (
  id         serial primary key,
  user_id    bigint not null references users(id),
  code       text not null,
  total      numeric(14, 2) not null,
  issued_on  date not null default current_date
);

insert into invoices (user_id, code, total, issued_on)
select 2 + g % 1000, 'INV-' || lpad(g::text, 6, '0'), round((random() * 5000)::numeric, 2), current_date - g % 365
from generate_series(2, 2000) g;

-- Things for the schema tree: an index, a view, a materialized view, a function, a second schema.
create index invoices_issued_on_idx on invoices (issued_on);
comment on table users is 'Application users (seeded)';

create view active_users as
  select id, email, plan from users where last_login > now() - interval '30 days';

create materialized view revenue_by_plan as
  select u.plan, sum(i.total) as revenue from invoices i join users u on u.id = i.user_id group by u.plan;

create function invoice_total(p_user bigint) returns numeric language sql stable as $$
  select coalesce(sum(total), 0) from invoices where user_id = p_user
$$;

create schema billing;
create table billing.payments (
  id         bigint generated always as identity primary key,
  invoice_id int not null references public.invoices(id),
  amount     numeric(14, 2) not null check (amount > 0),
  paid_at    timestamptz not null default now()
);

-- A big table with only a primary key: what the index advisor is for.
create table events (
  id          bigint generated always as identity primary key,
  user_id     bigint not null references users(id),
  kind        text not null,
  payload     jsonb,
  created_at  timestamptz not null
);

insert into events (user_id, kind, payload, created_at)
select 2 + g % 20000,
       (array['login', 'logout', 'view', 'purchase', 'error'])[1 + (g * 7) % 5],
       jsonb_build_object('n', g),
       now() - (g || ' seconds')::interval
from generate_series(1, 300000) g;
analyze events;

-- Index advisor: workload statistics and hypothetical indexes.
create extension if not exists pg_stat_statements;
create extension if not exists hypopg;

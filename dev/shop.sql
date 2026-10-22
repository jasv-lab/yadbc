-- A small but realistic shop schema, for the schema diagram: lookup chains, a many-to-many link table,
-- a self-reference, a composite key, optional (nullable) relations and a few unrelated tables.
create schema shop;
set search_path = shop;

create table countries   (code char(2) primary key, name text not null);
create table currencies  (code char(3) primary key, name text not null, symbol text);
create table departments (id int generated always as identity primary key, name text not null);
create table employees (
  id            int generated always as identity primary key,
  department_id int not null references departments,
  manager_id    int references employees,
  email         text not null unique,
  full_name     text not null,
  hired_on      date not null
);
create table customers (
  id         bigint generated always as identity primary key,
  email      text not null unique,
  full_name  text not null,
  country    char(2) references countries,
  created_at timestamptz not null default now()
);
create table addresses (
  id          bigint generated always as identity primary key,
  customer_id bigint not null references customers on delete cascade,
  country     char(2) not null references countries,
  city        text not null,
  street      text not null,
  postal_code text
);
create table categories (
  id        int generated always as identity primary key,
  parent_id int references categories,
  name      text not null
);
create table suppliers (
  id      int generated always as identity primary key,
  name    text not null,
  country char(2) references countries
);
create table products (
  id          bigint generated always as identity primary key,
  sku         text not null unique,
  name        text not null,
  supplier_id int references suppliers,
  currency    char(3) not null references currencies,
  price       numeric(12, 2) not null,
  active      boolean not null default true
);
create table product_categories (
  product_id  bigint not null references products on delete cascade,
  category_id int not null references categories on delete cascade,
  primary key (product_id, category_id)
);
create table warehouses (id int generated always as identity primary key, name text not null, country char(2) not null references countries);
create table stock (
  warehouse_id int not null references warehouses,
  product_id   bigint not null references products,
  quantity     int not null default 0,
  primary key (warehouse_id, product_id)
);
create table coupons (code text primary key, percent_off int not null check (percent_off between 1 and 100), valid_until date);
create table orders (
  id                  bigint generated always as identity primary key,
  customer_id         bigint not null references customers,
  shipping_address_id bigint references addresses,
  coupon_code         text references coupons,
  handled_by          int references employees,
  currency            char(3) not null references currencies,
  status              text not null default 'new',
  placed_at           timestamptz not null default now()
);
create table order_items (
  order_id   bigint not null references orders on delete cascade,
  line_no    int not null,
  product_id bigint not null references products,
  quantity   int not null,
  unit_price numeric(12, 2) not null,
  primary key (order_id, line_no)
);
create table payments (
  id       bigint generated always as identity primary key,
  order_id bigint not null references orders,
  amount   numeric(12, 2) not null,
  method   text not null,
  paid_at  timestamptz
);
create table carriers  (id int generated always as identity primary key, name text not null);
create table shipments (
  id          bigint generated always as identity primary key,
  order_id    bigint not null references orders,
  carrier_id  int not null references carriers,
  warehouse_id int references warehouses,
  tracking_no text,
  shipped_at  timestamptz
);
-- A return refers to the exact order line: a composite foreign key.
create table returns (
  id       bigint generated always as identity primary key,
  order_id bigint not null,
  line_no  int not null,
  reason   text,
  foreign key (order_id, line_no) references order_items
);
create table reviews (
  id          bigint generated always as identity primary key,
  product_id  bigint not null references products,
  customer_id bigint references customers,
  rating      int not null check (rating between 1 and 5),
  body        text
);
-- Unrelated to everything else.
create table settings  (key text primary key, value jsonb not null);
create table audit_log (id bigint generated always as identity primary key, at timestamptz not null default now(), actor text, action text not null, details jsonb);
create table job_queue (id bigint generated always as identity primary key, kind text not null, payload jsonb, run_after timestamptz, attempts int not null default 0);

reset search_path;

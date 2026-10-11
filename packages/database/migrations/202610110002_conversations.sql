-- migrate:up
create table threads (
  id uuid primary key,
  owner_id text not null references "user" (id),
  binding_json jsonb not null check (jsonb_typeof(binding_json) = 'object'),
  native_session_id text,
  created_at timestamptz not null default now(),
  unique (id, owner_id)
);

create table turns (
  id uuid primary key,
  thread_id uuid not null,
  owner_id text not null,
  request_id uuid not null,
  input_json jsonb not null check (jsonb_typeof(input_json) = 'object'),
  status text not null default 'accepted',
  result_json jsonb,
  failure_code text,
  cancel_requested_at timestamptz,
  accepted_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (thread_id, owner_id) references threads (id, owner_id),
  unique (owner_id, request_id),
  check (
    (status in ('accepted', 'running') and result_json is null and failure_code is null and finished_at is null)
    or (status = 'needs_reconciliation' and result_json is null and finished_at is null
      and failure_code is not null and failure_code in
        ('binding_mismatch', 'invalid_input', 'execution_unknown', 'cleanup_failed', 'result_commit_unknown', 'unsupported_pause'))
    or (status in ('completed', 'cancelled') and result_json is not null
      and jsonb_typeof(result_json) = 'object' and failure_code is null and finished_at is not null)
    or (status = 'failed' and result_json is null and failure_code is not null
      and failure_code = 'execution_failed' and finished_at is not null)
  )
);
-- Unknown execution still occupies admission; elapsed time does not prove writer shutdown.
create unique index turns_one_admitted on turns (thread_id)
  where status in ('accepted', 'running', 'needs_reconciliation');
create index turns_history on turns (thread_id, accepted_at, id);

create table turn_attempts (
  id uuid primary key,
  turn_id uuid not null unique references turns (id),
  binding_json jsonb not null,
  native_session_id text,
  claimed_at timestamptz not null default now(),
  stopped_at timestamptz
);

create table turn_outbox (
  turn_id uuid primary key references turns (id),
  generation integer not null default 0 check (generation >= 0),
  next_delivery_at timestamptz not null default now(),
  last_published_at timestamptz
);
create index turn_outbox_due on turn_outbox (next_delivery_at, turn_id);

-- migrate:down
-- Destructive rollback: removes accepted requests and results; not a routine code rollback.
drop table turn_outbox;
drop table turn_attempts;
drop table turns;
drop table threads;

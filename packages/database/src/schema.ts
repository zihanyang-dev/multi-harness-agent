import type { Generated, JSONColumnType } from 'kysely';

/** SQL structure only. JSON meaning and lifecycle decisions belong to application owners. */
export interface DatabaseSchema {
  threads: {
    id: string;
    owner_id: string;
    binding_json: JSONColumnType<object, object, object>;
    native_session_id: Generated<string | null>;
    created_at: Generated<Date>;
  };
  turns: {
    id: string;
    thread_id: string;
    owner_id: string;
    request_id: string;
    input_json: JSONColumnType<object, object, object>;
    status: Generated<string>;
    result_json: JSONColumnType<object | null, object | null | undefined, object | null>;
    failure_code: Generated<string | null>;
    cancel_requested_at: Generated<Date | null>;
    accepted_at: Generated<Date>;
    finished_at: Generated<Date | null>;
  };
  turn_attempts: {
    id: string;
    turn_id: string;
    binding_json: JSONColumnType<object, object, object>;
    native_session_id: Generated<string | null>;
    claimed_at: Generated<Date>;
    stopped_at: Generated<Date | null>;
  };
  turn_outbox: {
    turn_id: string;
    generation: Generated<number>;
    next_delivery_at: Generated<Date>;
    last_published_at: Generated<Date | null>;
  };
}

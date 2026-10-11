\restrict dbmate

-- Dumped from database version 18.6 (Debian 18.6-1.pgdg13+2)
-- Dumped by pg_dump version 18.6 (Debian 18.6-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL
);


--
-- Name: threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.threads (
    id uuid NOT NULL,
    owner_id text NOT NULL,
    binding_json jsonb NOT NULL,
    native_session_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT threads_binding_json_check CHECK ((jsonb_typeof(binding_json) = 'object'::text))
);


--
-- Name: turn_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.turn_attempts (
    id uuid NOT NULL,
    turn_id uuid NOT NULL,
    binding_json jsonb NOT NULL,
    native_session_id text,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    stopped_at timestamp with time zone
);


--
-- Name: turn_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.turn_outbox (
    turn_id uuid NOT NULL,
    generation integer DEFAULT 0 NOT NULL,
    next_delivery_at timestamp with time zone DEFAULT now() NOT NULL,
    last_published_at timestamp with time zone,
    CONSTRAINT turn_outbox_generation_check CHECK ((generation >= 0))
);


--
-- Name: turns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.turns (
    id uuid NOT NULL,
    thread_id uuid NOT NULL,
    owner_id text NOT NULL,
    request_id uuid NOT NULL,
    input_json jsonb NOT NULL,
    status text DEFAULT 'accepted'::text NOT NULL,
    result_json jsonb,
    failure_code text,
    cancel_requested_at timestamp with time zone,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT turns_check CHECK ((((status = ANY (ARRAY['accepted'::text, 'running'::text])) AND (result_json IS NULL) AND (failure_code IS NULL) AND (finished_at IS NULL)) OR ((status = 'needs_reconciliation'::text) AND (result_json IS NULL) AND (finished_at IS NULL) AND (failure_code IS NOT NULL) AND (failure_code = ANY (ARRAY['binding_mismatch'::text, 'invalid_input'::text, 'execution_unknown'::text, 'cleanup_failed'::text, 'result_commit_unknown'::text, 'unsupported_pause'::text]))) OR ((status = ANY (ARRAY['completed'::text, 'cancelled'::text])) AND (result_json IS NOT NULL) AND (jsonb_typeof(result_json) = 'object'::text) AND (failure_code IS NULL) AND (finished_at IS NOT NULL)) OR ((status = 'failed'::text) AND (result_json IS NULL) AND (failure_code IS NOT NULL) AND (failure_code = 'execution_failed'::text) AND (finished_at IS NOT NULL)))),
    CONSTRAINT turns_input_json_check CHECK ((jsonb_typeof(input_json) = 'object'::text))
);


--
-- Name: user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."user" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean NOT NULL,
    image text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_token_key UNIQUE (token);


--
-- Name: threads threads_id_owner_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_id_owner_id_key UNIQUE (id, owner_id);


--
-- Name: threads threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_pkey PRIMARY KEY (id);


--
-- Name: turn_attempts turn_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_attempts
    ADD CONSTRAINT turn_attempts_pkey PRIMARY KEY (id);


--
-- Name: turn_attempts turn_attempts_turn_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_attempts
    ADD CONSTRAINT turn_attempts_turn_id_key UNIQUE (turn_id);


--
-- Name: turn_outbox turn_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_outbox
    ADD CONSTRAINT turn_outbox_pkey PRIMARY KEY (turn_id);


--
-- Name: turns turns_owner_id_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turns
    ADD CONSTRAINT turns_owner_id_request_id_key UNIQUE (owner_id, request_id);


--
-- Name: turns turns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turns
    ADD CONSTRAINT turns_pkey PRIMARY KEY (id);


--
-- Name: user user_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: account_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "account_userId_idx" ON public.account USING btree ("userId");


--
-- Name: session_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "session_userId_idx" ON public.session USING btree ("userId");


--
-- Name: turn_outbox_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX turn_outbox_due ON public.turn_outbox USING btree (next_delivery_at, turn_id);


--
-- Name: turns_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX turns_history ON public.turns USING btree (thread_id, accepted_at, id);


--
-- Name: turns_one_admitted; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX turns_one_admitted ON public.turns USING btree (thread_id) WHERE (status = ANY (ARRAY['accepted'::text, 'running'::text, 'needs_reconciliation'::text]));


--
-- Name: verification_identifier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verification_identifier_idx ON public.verification USING btree (identifier);


--
-- Name: account account_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: session session_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: threads threads_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public."user"(id);


--
-- Name: turn_attempts turn_attempts_turn_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_attempts
    ADD CONSTRAINT turn_attempts_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES public.turns(id);


--
-- Name: turn_outbox turn_outbox_turn_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_outbox
    ADD CONSTRAINT turn_outbox_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES public.turns(id);


--
-- Name: turns turns_thread_id_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turns
    ADD CONSTRAINT turns_thread_id_owner_id_fkey FOREIGN KEY (thread_id, owner_id) REFERENCES public.threads(id, owner_id);


--
-- PostgreSQL database dump complete
--

\unrestrict dbmate


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('202610110001'),
    ('202610110002');

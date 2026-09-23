-- 002_research: data sources, fetched documents, markets, companies, opportunities, evidence,
-- business hypotheses, score history, knowledge graph.

CREATE TABLE sources (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connector          text NOT NULL,
  name               text NOT NULL,
  enabled            boolean NOT NULL DEFAULT true,
  config             jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_run_at        timestamptz,
  last_status        text,
  last_error         text,
  documents_fetched  integer NOT NULL DEFAULT 0,
  quality_score      double precision,
  is_demo            boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, connector, name)
);
CREATE TRIGGER sources_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON sources FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

-- Raw documents fetched from external sources. Always treated as UNTRUSTED input.
CREATE TABLE documents (
  id               text PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id        text REFERENCES sources(id) ON DELETE SET NULL,
  connector        text NOT NULL,
  external_id      text,
  url              text,
  title            text NOT NULL,
  content          text NOT NULL DEFAULT '',
  content_hash     text NOT NULL,
  author           text,
  published_at     timestamptz,
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  engagement       jsonb NOT NULL DEFAULT '{}'::jsonb,
  signals          jsonb NOT NULL DEFAULT '{}'::jsonb,
  injection_score  double precision NOT NULL DEFAULT 0,
  query            text,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_demo          boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, content_hash)
);
CREATE INDEX documents_org_fetched_idx ON documents (org_id, fetched_at DESC);
CREATE TRIGGER documents_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON documents FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

CREATE TABLE markets (
  id               text PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  description      text,
  size_estimate    jsonb,
  growth_estimate  jsonb,
  is_demo          boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE TRIGGER markets_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON markets FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

CREATE TABLE companies (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         text NOT NULL,
  website      text,
  description  text,
  kind         text NOT NULL DEFAULT 'competitor' CHECK (kind IN ('competitor', 'customer', 'partner', 'vendor', 'other')),
  market_id    text REFERENCES markets(id) ON DELETE SET NULL,
  data_kind    text NOT NULL DEFAULT 'OBSERVED' CHECK (data_kind IN ('OBSERVED', 'ESTIMATED', 'MODEL_ASSUMPTION', 'USER_INPUT', 'DEMO')),
  provenance   jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_demo      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE TRIGGER companies_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON companies FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

CREATE TABLE opportunities (
  id                         text PRIMARY KEY,
  org_id                     text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title                      text NOT NULL,
  problem                    text NOT NULL,
  customer                   text NOT NULL,
  market                     text NOT NULL,
  market_id                  text REFERENCES markets(id) ON DELETE SET NULL,
  source_urls                jsonb NOT NULL DEFAULT '[]'::jsonb,
  estimated_market_size      jsonb,
  estimated_price            jsonb,
  acquisition_cost_estimate  jsonb,
  gross_margin_estimate      jsonb,
  competition                jsonb,
  technical_complexity       jsonb,
  regulatory_risk            jsonb,
  time_to_mvp                jsonb,
  confidence                 double precision NOT NULL DEFAULT 0,
  score                      double precision,
  score_breakdown            jsonb,
  status                     text NOT NULL DEFAULT 'discovered' CHECK (status IN (
                               'discovered', 'analyzing', 'analyzed', 'validated', 'building', 'built', 'launched',
                               'experimenting', 'scaling', 'paused', 'killed', 'archived')),
  tags                       jsonb NOT NULL DEFAULT '[]'::jsonb,
  industries                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  signals                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  fingerprint                text,
  selected_hypothesis_id     text,
  created_by                 text NOT NULL DEFAULT 'system',
  is_demo                    boolean NOT NULL DEFAULT false,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX opportunities_org_status_idx ON opportunities (org_id, status);
CREATE INDEX opportunities_org_score_idx ON opportunities (org_id, score DESC NULLS LAST);
CREATE UNIQUE INDEX opportunities_fingerprint_idx ON opportunities (org_id, fingerprint) WHERE fingerprint IS NOT NULL;
CREATE TRIGGER opportunities_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON opportunities FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

-- Every externally sourced claim: source, timestamp, confidence, data kind, provenance.
CREATE TABLE evidence (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id  text NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  document_id     text REFERENCES documents(id) ON DELETE SET NULL,
  claim           text NOT NULL,
  quote           text,
  data_kind       text NOT NULL CHECK (data_kind IN ('OBSERVED', 'ESTIMATED', 'MODEL_ASSUMPTION', 'USER_INPUT', 'DEMO')),
  source_name     text NOT NULL,
  source_url      text,
  observed_at     timestamptz NOT NULL,
  confidence      double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  provenance      jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_opportunity_idx ON evidence (opportunity_id);
CREATE TRIGGER evidence_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON evidence FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

CREATE TABLE business_hypotheses (
  id                       text PRIMARY KEY,
  org_id                   text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id           text NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  model                    text NOT NULL,
  title                    text NOT NULL,
  target_customer          text NOT NULL DEFAULT '',
  value_proposition        text NOT NULL DEFAULT '',
  mvp_spec                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  pricing                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  distribution             jsonb NOT NULL DEFAULT '[]'::jsonb,
  acquisition_experiments  jsonb NOT NULL DEFAULT '[]'::jsonb,
  retention_strategy       jsonb NOT NULL DEFAULT '[]'::jsonb,
  unit_economics           jsonb NOT NULL DEFAULT '{}'::jsonb,
  expected_costs           jsonb NOT NULL DEFAULT '[]'::jsonb,
  experiment_plan          jsonb NOT NULL DEFAULT '[]'::jsonb,
  technical_architecture   jsonb NOT NULL DEFAULT '[]'::jsonb,
  score                    double precision NOT NULL DEFAULT 0,
  status                   text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'selected', 'rejected', 'testing', 'validated', 'invalidated')),
  generated_by             text NOT NULL,
  is_demo                  boolean NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hypotheses_opportunity_idx ON business_hypotheses (opportunity_id);
CREATE TRIGGER hypotheses_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON business_hypotheses FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

CREATE TABLE opportunity_scores (
  id               bigserial PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id   text NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  score            double precision NOT NULL,
  low              double precision NOT NULL,
  high             double precision NOT NULL,
  confidence       double precision NOT NULL,
  breakdown        jsonb NOT NULL,
  weights_version  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX opportunity_scores_opp_idx ON opportunity_scores (opportunity_id, created_at DESC);

-- Knowledge graph (property graph on PostgreSQL; see packages/core/src/graph.ts GraphStore).
CREATE TABLE kg_nodes (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('market', 'company', 'customer_segment', 'technology', 'product', 'competitor',
                                            'pain_point', 'regulation', 'business_model', 'experiment', 'metric', 'opportunity', 'source')),
  key         text NOT NULL,
  label       text NOT NULL,
  properties  jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_demo     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, type, key)
);
CREATE TRIGGER kg_nodes_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON kg_nodes FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

CREATE TABLE kg_edges (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  src_id       text NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  dst_id       text NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  type         text NOT NULL,
  weight       double precision NOT NULL DEFAULT 1,
  properties   jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_id  text,
  is_demo      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, src_id, dst_id, type)
);
CREATE INDEX kg_edges_src_idx ON kg_edges (src_id);
CREATE INDEX kg_edges_dst_idx ON kg_edges (dst_id);
CREATE TRIGGER kg_edges_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON kg_edges FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

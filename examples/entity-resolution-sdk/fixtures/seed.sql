CREATE SCHEMA IF NOT EXISTS entity_graph;

CREATE OR REPLACE TABLE entity_graph.__entity_profile (
  entity_type VARCHAR,
  entity_id VARCHAR,
  cluster_id VARCHAR,
  canonical_name VARCHAR,
  display_name VARCHAR,
  profile_attrs VARCHAR,
  confidence DOUBLE,
  freshness_age_seconds INTEGER,
  source_diversity INTEGER,
  profile_coverage DOUBLE,
  last_seen_at TIMESTAMP,
  lineage_run_id VARCHAR,
  version INTEGER,
  domain VARCHAR,
  segment VARCHAR,
  stage VARCHAR,
  amount VARCHAR,
  source_uri VARCHAR,
  format VARCHAR
);

INSERT INTO entity_graph.__entity_profile VALUES
  ('Customer', 'cust_acme', 'cluster_cust_acme', 'Acme Corp', 'Acme Corp', '{"domain":"acme.com","segment":"enterprise"}', 0.99, 120, 3, 1.0, CURRENT_TIMESTAMP, 'seed', 1, 'acme.com', 'enterprise', NULL, NULL, NULL, NULL),
  ('Customer', 'cust_globex', 'cluster_cust_globex', 'Globex Inc', 'Globex Inc', '{"domain":"globex.com","segment":"midmarket"}', 0.97, 360, 2, 0.95, CURRENT_TIMESTAMP, 'seed', 1, 'globex.com', 'midmarket', NULL, NULL, NULL, NULL),
  ('Customer', 'cust_initech', 'cluster_cust_initech', 'Initech LLC', 'Initech LLC', '{"domain":"initech.example","segment":"commercial"}', 0.96, 420, 2, 0.92, CURRENT_TIMESTAMP, 'seed', 1, 'initech.example', 'commercial', NULL, NULL, NULL, NULL),
  ('Customer', 'cust_umbrella', 'cluster_cust_umbrella', 'Umbrella Health', 'Umbrella Health', '{"domain":"umbrella.health","segment":"enterprise"}', 0.94, 780, 2, 0.9, CURRENT_TIMESTAMP, 'seed', 1, 'umbrella.health', 'enterprise', NULL, NULL, NULL, NULL),
  ('Customer', 'cust_stark', 'cluster_cust_stark', 'Stark Industries', 'Stark Industries', '{"domain":"stark.example","segment":"strategic"}', 0.98, 90, 4, 1.0, CURRENT_TIMESTAMP, 'seed', 1, 'stark.example', 'strategic', NULL, NULL, NULL, NULL),
  ('Deal', 'deal_atlas', 'cluster_deal_atlas', 'Project Atlas', 'Project Atlas', '{"stage":"proposal","amount":"125000"}', 0.93, 300, 2, 0.88, CURRENT_TIMESTAMP, 'seed', 1, NULL, NULL, 'proposal', '125000', NULL, NULL),
  ('Deal', 'deal_renewal', 'cluster_deal_renewal', 'Renewal 2026', 'Renewal 2026', '{"stage":"negotiation","amount":"80000"}', 0.91, 500, 2, 0.84, CURRENT_TIMESTAMP, 'seed', 1, NULL, NULL, 'negotiation', '80000', NULL, NULL),
  ('Deal', 'deal_expansion', 'cluster_deal_expansion', 'Expansion North', 'Expansion North', '{"stage":"closed_won","amount":"250000"}', 0.95, 60, 3, 0.9, CURRENT_TIMESTAMP, 'seed', 1, NULL, NULL, 'closed_won', '250000', NULL, NULL),
  ('Document', 'doc_001', 'cluster_doc_001', 'doc_001', 'Acme renewal call', '{"source_uri":"file://docs/acme-renewal.txt","format":"txt"}', 0.99, 10, 1, 1.0, CURRENT_TIMESTAMP, 'seed', 1, NULL, NULL, NULL, NULL, 'file://docs/acme-renewal.txt', 'txt'),
  ('Document', 'doc_002', 'cluster_doc_002', 'doc_002', 'Globex proposal notes', '{"source_uri":"file://docs/globex-proposal.txt","format":"txt"}', 0.99, 10, 1, 1.0, CURRENT_TIMESTAMP, 'seed', 1, NULL, NULL, NULL, NULL, 'file://docs/globex-proposal.txt', 'txt'),
  ('Document', 'doc_003', 'cluster_doc_003', 'doc_003', 'Initech workshop', '{"source_uri":"file://docs/initech-workshop.txt","format":"txt"}', 0.99, 10, 1, 1.0, CURRENT_TIMESTAMP, 'seed', 1, NULL, NULL, NULL, NULL, 'file://docs/initech-workshop.txt', 'txt'),
  ('Document', 'doc_004', 'cluster_doc_004', 'doc_004', 'Umbrella account brief', '{"source_uri":"file://docs/umbrella-brief.txt","format":"txt"}', 0.99, 10, 1, 1.0, CURRENT_TIMESTAMP, 'seed', 1, NULL, NULL, NULL, NULL, 'file://docs/umbrella-brief.txt', 'txt'),
  ('Document', 'doc_005', 'cluster_doc_005', 'doc_005', 'Stark expansion memo', '{"source_uri":"file://docs/stark-expansion.txt","format":"txt"}', 0.99, 10, 1, 1.0, CURRENT_TIMESTAMP, 'seed', 1, NULL, NULL, NULL, NULL, 'file://docs/stark-expansion.txt', 'txt'),
  ('Document', 'doc_006', 'cluster_doc_006', 'doc_006', 'Acme support summary', '{"source_uri":"file://docs/acme-support.txt","format":"txt"}', 0.99, 10, 1, 1.0, CURRENT_TIMESTAMP, 'seed', 1, NULL, NULL, NULL, NULL, 'file://docs/acme-support.txt', 'txt'),
  ('Document', 'doc_007', 'cluster_doc_007', 'doc_007', 'Globex security review', '{"source_uri":"file://docs/globex-security.txt","format":"txt"}', 0.99, 10, 1, 1.0, CURRENT_TIMESTAMP, 'seed', 1, NULL, NULL, NULL, NULL, 'file://docs/globex-security.txt', 'txt'),
  ('Document', 'doc_008', 'cluster_doc_008', 'doc_008', 'Initech QBR', '{"source_uri":"file://docs/initech-qbr.txt","format":"txt"}', 0.99, 10, 1, 1.0, CURRENT_TIMESTAMP, 'seed', 1, NULL, NULL, NULL, NULL, 'file://docs/initech-qbr.txt', 'txt'),
  ('Document', 'doc_009', 'cluster_doc_009', 'doc_009', 'Umbrella roadmap', '{"source_uri":"file://docs/umbrella-roadmap.txt","format":"txt"}', 0.99, 10, 1, 1.0, CURRENT_TIMESTAMP, 'seed', 1, NULL, NULL, NULL, NULL, 'file://docs/umbrella-roadmap.txt', 'txt'),
  ('Document', 'doc_010', 'cluster_doc_010', 'doc_010', 'Stark executive brief', '{"source_uri":"file://docs/stark-exec.txt","format":"txt"}', 0.99, 10, 1, 1.0, CURRENT_TIMESTAMP, 'seed', 1, NULL, NULL, NULL, NULL, 'file://docs/stark-exec.txt', 'txt');

CREATE OR REPLACE TABLE entity_graph.Customer__entity_profile AS
SELECT entity_id, canonical_name
FROM entity_graph.__entity_profile
WHERE entity_type = 'Customer';

CREATE OR REPLACE TABLE entity_graph.Deal__entity_profile AS
SELECT entity_id, canonical_name
FROM entity_graph.__entity_profile
WHERE entity_type = 'Deal';

CREATE OR REPLACE TABLE entity_graph.Document__entity_profile AS
SELECT entity_id, canonical_name
FROM entity_graph.__entity_profile
WHERE entity_type = 'Document';

CREATE OR REPLACE TABLE entity_graph.__chunks (
  chunk_id VARCHAR,
  chunk_text VARCHAR,
  document_id VARCHAR,
  document_version_id VARCHAR,
  document_format VARCHAR
);

INSERT INTO entity_graph.__chunks VALUES
  ('chunk_001', 'Acme Corp reviewed Renewal 2026 during the account call.', 'doc_001', 'doc_001@v1', 'txt'),
  ('chunk_002', 'Acme Corp asked for Project Atlas pricing and support terms.', 'doc_001', 'doc_001@v1', 'txt'),
  ('chunk_003', 'Globex Inc approved a pilot plan for Project Atlas.', 'doc_002', 'doc_002@v1', 'txt'),
  ('chunk_004', 'Globex Inc needs security review before Renewal 2026.', 'doc_002', 'doc_002@v1', 'txt'),
  ('chunk_005', 'Initech LLC joined a product workshop about Expansion North.', 'doc_003', 'doc_003@v1', 'txt'),
  ('chunk_006', 'Initech LLC wants legal terms attached to Project Atlas.', 'doc_003', 'doc_003@v1', 'txt'),
  ('chunk_007', 'Umbrella Health asked for Renewal 2026 deployment planning.', 'doc_004', 'doc_004@v1', 'txt'),
  ('chunk_008', 'Umbrella Health compared Project Atlas with Expansion North.', 'doc_004', 'doc_004@v1', 'txt'),
  ('chunk_009', 'Stark Industries moved Expansion North to procurement.', 'doc_005', 'doc_005@v1', 'txt'),
  ('chunk_010', 'Stark Industries requested executive terms for Project Atlas.', 'doc_005', 'doc_005@v1', 'txt'),
  ('chunk_011', 'Acme Corp support risks are low for Renewal 2026.', 'doc_006', 'doc_006@v1', 'txt'),
  ('chunk_012', 'Acme Corp procurement expects Expansion North references.', 'doc_006', 'doc_006@v1', 'txt'),
  ('chunk_013', 'Globex Inc security owners accepted the Renewal 2026 plan.', 'doc_007', 'doc_007@v1', 'txt'),
  ('chunk_014', 'Globex Inc wants a Project Atlas data-processing addendum.', 'doc_007', 'doc_007@v1', 'txt'),
  ('chunk_015', 'Initech LLC QBR covered Renewal 2026 and Project Atlas.', 'doc_008', 'doc_008@v1', 'txt'),
  ('chunk_016', 'Initech LLC finance approved Expansion North budget.', 'doc_008', 'doc_008@v1', 'txt'),
  ('chunk_017', 'Umbrella Health roadmap names Project Atlas as a priority.', 'doc_009', 'doc_009@v1', 'txt'),
  ('chunk_018', 'Umbrella Health procurement tied Renewal 2026 to Expansion North.', 'doc_009', 'doc_009@v1', 'txt'),
  ('chunk_019', 'Stark Industries executives endorsed Project Atlas.', 'doc_010', 'doc_010@v1', 'txt'),
  ('chunk_020', 'Stark Industries asked for Renewal 2026 renewal terms.', 'doc_010', 'doc_010@v1', 'txt');

CREATE OR REPLACE TABLE entity_graph.__document_mentions (
  mention_id VARCHAR,
  chunk_id VARCHAR,
  document_version_id VARCHAR,
  document_id VARCHAR,
  entity_type VARCHAR,
  entity_name VARCHAR,
  confidence DOUBLE,
  span_start INTEGER,
  span_end INTEGER,
  resolved_entity_id VARCHAR,
  resolution_method VARCHAR,
  resolution_confidence DOUBLE,
  superseded_at TIMESTAMP,
  extracted_at TIMESTAMP,
  extraction_role VARCHAR,
  notes VARCHAR
);

CREATE OR REPLACE TABLE entity_graph.__entity_relationship_evidence (
  evidence_id VARCHAR,
  relationship_id VARCHAR,
  relation_type VARCHAR,
  left_entity_id VARCHAR,
  right_entity_id VARCHAR,
  evidence_kind VARCHAR,
  evidence_ref VARCHAR,
  source_document_id VARCHAR,
  source_document_version_id VARCHAR,
  source_chunk_id VARCHAR,
  span_start INTEGER,
  span_end INTEGER,
  evidence_excerpt VARCHAR,
  confidence DOUBLE,
  extraction_role VARCHAR,
  prompt_version VARCHAR,
  ontology_version VARCHAR,
  model_metadata VARCHAR,
  injection_markers VARCHAR,
  review_flag VARCHAR,
  observed_at TIMESTAMP,
  recorded_at TIMESTAMP
);

CREATE OR REPLACE TABLE entity_graph.__entity_relationship_decisions (
  decision_id VARCHAR,
  evidence_id VARCHAR,
  relationship_id VARCHAR,
  decision VARCHAR,
  decided_by VARCHAR,
  rationale VARCHAR,
  decided_at TIMESTAMP
);

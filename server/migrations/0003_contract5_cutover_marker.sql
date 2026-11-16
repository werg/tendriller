-- Pause creation while the schema-5 Worker is deployed and verified.
CREATE TABLE contract5_cutover_pending (id INTEGER PRIMARY KEY CHECK (id = 1));
INSERT INTO contract5_cutover_pending (id) VALUES (1);
UPDATE service_state SET mode = 'creation_paused' WHERE id = 1;

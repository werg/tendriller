-- Consumed once after the canonical Worker passes its first revision-4 smoke
-- check. Later intentional pauses are never reopened by ordinary deploys.
CREATE TABLE contract4_cutover_pending (id INTEGER PRIMARY KEY CHECK (id = 1));
INSERT INTO contract4_cutover_pending (id) VALUES (1);

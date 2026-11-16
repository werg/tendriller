-- Open only the first time the verified revision-5 Worker completes cutover.
-- Ordinary later deploys preserve an intentional pause.
UPDATE service_state SET mode = 'open'
WHERE id = 1 AND mode = 'creation_paused'
  AND EXISTS (SELECT 1 FROM contract5_cutover_pending WHERE id = 1);
DELETE FROM contract5_cutover_pending WHERE id = 1;

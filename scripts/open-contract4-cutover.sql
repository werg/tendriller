UPDATE service_state SET mode = 'open'
WHERE id = 1 AND mode = 'creation_paused'
  AND EXISTS (SELECT 1 FROM contract4_cutover_pending WHERE id = 1);
DELETE FROM contract4_cutover_pending WHERE id = 1;

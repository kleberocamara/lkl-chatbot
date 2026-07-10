BEGIN;

-- Remove eventuais duplicatas existentes antes de criar a constraint única
-- (mantém a linha de menor id por conversation_id+attempt, se houver duplicata).
DELETE FROM follow_ups a USING follow_ups b
WHERE a.conversation_id = b.conversation_id
  AND a.attempt = b.attempt
  AND a.id > b.id;

ALTER TABLE follow_ups ADD CONSTRAINT follow_ups_conversation_attempt_unique UNIQUE (conversation_id, attempt);

COMMIT;

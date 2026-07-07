DROP TRIGGER IF EXISTS routing_rules_audit_append_only ON routing_rules_audit;
DROP FUNCTION IF EXISTS reject_routing_rules_audit_mutation();
DROP TABLE IF EXISTS routing_rules_audit;
DROP TABLE IF EXISTS routing_rules;

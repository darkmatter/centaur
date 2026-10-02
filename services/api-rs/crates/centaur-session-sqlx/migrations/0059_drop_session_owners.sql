-- session_owners backed the per-session ownership lease that fenced control-plane
-- replicas for the OMP resident host and the removed collaboration rooms. No code
-- reads or writes it any more; the per-execution stdout-owner lease is the only
-- ownership boundary. A rollback to a release that still reads this table must
-- recreate it first.
drop table if exists session_owners;

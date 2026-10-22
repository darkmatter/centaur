-- The hermes migration above arrived from upstream, whose harness set does
-- not include the fork-only omp harness: applied as written, it rebuilds
-- sessions_harness_type_supported without 'omp' and every new omp session
-- fails the check. This restores the fork's harness to the constraint, in a
-- new migration so already-recorded file contents stay immutable.
alter table sessions
drop constraint sessions_harness_type_supported;

alter table sessions
add constraint sessions_harness_type_supported
check (harness_type in ('codex', 'amp', 'claudecode', 'nanocodex', 'omp', 'hermes'));

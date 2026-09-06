#!/usr/bin/env bash
set -euo pipefail

base_ref="${1:-origin/${GITHUB_BASE_REF:-main}}"
failed=0

if ! git rev-parse --verify --quiet "${base_ref}^{commit}" >/dev/null; then
  echo "Base ref '${base_ref}' does not exist. Fetch it before running this check." >&2
  exit 1
fi

extract_versions() {
  local regex="$1"
  while IFS= read -r path; do
    local file="${path##*/}"
    if [[ "${file}" =~ ${regex} ]]; then
      printf '%s %s\n' "${BASH_REMATCH[1]}" "${path}"
    fi
  done
}

version_number() {
  local version="$1"
  echo $((10#${version}))
}

check_migration_lock() {
  local label="$1"
  local dir="$2"
  local lock_file="$3"
  local regex="$4"
  local lock_failed=0

  if [[ ! -f "${lock_file}" ]]; then
    failed=1
    echo "::error title=${label} migration lock missing::Expected ${lock_file}"
    return
  fi

  local lock_entries
  lock_entries="$(
    awk 'NF && $1 !~ /^#/ { print }' "${lock_file}"
  )"

  while read -r expected_oid file extra; do
    [[ -n "${expected_oid:-}" ]] || continue
    if [[ -n "${extra:-}" || ! "${expected_oid}" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ || ! "${file:-}" =~ ${regex} ]]; then
      failed=1
      lock_failed=1
      echo "::error title=${label} invalid migration lock entry::${expected_oid} ${file:-} ${extra:-}"
      continue
    fi

    local entry_count
    entry_count="$(
      printf '%s\n' "${lock_entries}" |
        awk -v file="${file}" '$2 == file { count++ } END { print count + 0 }'
    )"
    if [[ "${entry_count}" -ne 1 ]]; then
      failed=1
      lock_failed=1
      echo "::error title=${label} duplicate migration lock entry::${file} appears ${entry_count} times in ${lock_file}"
      continue
    fi

    local path="${dir}/${file}"
    if [[ ! -f "${path}" ]]; then
      failed=1
      lock_failed=1
      echo "::error title=${label} locked migration missing::Restore ${path}; applied migrations cannot be renamed or deleted"
      continue
    fi

    local actual_oid
    actual_oid="$(git hash-object -- "${path}")"
    if [[ "${actual_oid}" != "${expected_oid}" ]]; then
      failed=1
      lock_failed=1
      echo "::error title=${label} locked migration changed::${path} is ${actual_oid}, expected ${expected_oid}; add a new migration instead"
    fi
  done <<<"${lock_entries}"

  while IFS= read -r path; do
    local file="${path##*/}"
    local entry_count
    entry_count="$(
      printf '%s\n' "${lock_entries}" |
        awk -v file="${file}" '$2 == file { count++ } END { print count + 0 }'
    )"
    if [[ "${entry_count}" -eq 0 ]]; then
      failed=1
      lock_failed=1
      echo "::error title=${label} unlocked migration::Append the blob oid and filename for ${path} to ${lock_file}"
    fi
  done < <(find "${dir}" -maxdepth 1 -type f -name '*.sql' -print | sort)

  if git cat-file -e "${base_ref}:${lock_file}" 2>/dev/null; then
    local base_lock_entries
    base_lock_entries="$(
      git show "${base_ref}:${lock_file}" |
        awk 'NF && $1 !~ /^#/ { print }'
    )"
    while read -r base_oid file extra; do
      [[ -n "${base_oid:-}" ]] || continue
      local current_oid
      current_oid="$(
        printf '%s\n' "${lock_entries}" |
          awk -v file="${file}" '$2 == file { print $1 }'
      )"
      if [[ "${current_oid}" != "${base_oid}" ]]; then
        failed=1
        lock_failed=1
        echo "::error title=${label} migration lock rewritten::Keep ${base_oid} ${file} from ${base_ref}; existing lock entries are immutable"
      fi
    done <<<"${base_lock_entries}"
  fi

  if [[ "${lock_failed}" -eq 0 ]]; then
    echo "${label}: every migration matches the append-only lock."
  fi
}

check_migrations() {
  local label="$1"
  local dir="$2"
  local regex="$3"
  local dir_failed=0

  local head_entries
  head_entries="$(
    find "${dir}" -maxdepth 1 -type f -print | sort | extract_versions "${regex}"
  )"

  local duplicate_versions
  duplicate_versions="$(
    printf '%s\n' "${head_entries}" | awk 'NF { print $1 }' | sort | uniq -d
  )"

  if [[ -n "${duplicate_versions}" ]]; then
    failed=1
    dir_failed=1
    echo "::error title=${label} duplicate migration versions::Duplicate migration version prefixes found in ${dir}"
    while IFS= read -r version; do
      [[ -n "${version}" ]] || continue
      echo "  ${version}:"
      printf '%s\n' "${head_entries}" | awk -v version="${version}" '$1 == version { print "    " $2 }'
    done <<<"${duplicate_versions}"
  fi

  local base_entries
  base_entries="$(
    git ls-tree -r --name-only "${base_ref}" -- "${dir}" | sort | extract_versions "${regex}"
  )"

  local base_max
  base_max="$(
    printf '%s\n' "${base_entries}" | awk 'NF { print $1 }' | sort -n | tail -n 1
  )"

  if [[ -z "${base_max}" ]]; then
    echo "${label}: no base migrations found under ${dir}; skipping monotonic version check."
    return
  fi

  local added_versions
  added_versions="$(
    comm -23 \
      <(printf '%s\n' "${head_entries}" | awk 'NF { print $1 }' | sort -u) \
      <(printf '%s\n' "${base_entries}" | awk 'NF { print $1 }' | sort -u)
  )"

  while IFS= read -r version; do
    [[ -n "${version}" ]] || continue
    if (( $(version_number "${version}") <= $(version_number "${base_max}") )); then
      failed=1
      dir_failed=1
      echo "::error title=${label} non-monotonic migration::New migration version ${version} must be greater than ${base_max} from ${base_ref}"
      printf '%s\n' "${head_entries}" | awk -v version="${version}" '$1 == version { print "  " $2 }'
    fi
  done <<<"${added_versions}"

  if [[ "${dir_failed}" -eq 0 ]]; then
    echo "${label}: migration versions are monotonic relative to ${base_ref}."
  fi
}

check_migration_lock \
  "SQLx" \
  "services/api-rs/crates/centaur-session-sqlx/migrations" \
  "services/api-rs/crates/centaur-session-sqlx/migrations/migrations.lock" \
  '^([0-9]+)_.+\.sql$'

check_migrations \
  "SQLx" \
  "services/api-rs/crates/centaur-session-sqlx/migrations" \
  '^([0-9]+)_.+\.sql$'

check_migrations \
  "Rails console" \
  "services/console/db/migrate" \
  '^([0-9]+)_.+\.rb$'

exit "${failed}"

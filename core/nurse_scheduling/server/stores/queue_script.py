"""The single versioned Redis Lua state machine for the job priority queues (T09).

# This file is part of Nurse Scheduling Project, see <https://github.com/j3soon/nurse-scheduling>.
#
# Copyright (C) 2023-2026 Johnson Sun
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

WHY ONE SCRIPT AND NOT SEVERAL. Every queue transition touches several keys at
once: the job record, the pending set, one of the two purpose queues, the claim
lease, an event stream, and the event streams of every other queued job whose
position moved. Splitting those across scripts — or across a WATCH/MULTI retry
loop that must re-read to decide what to write — reintroduces exactly the races
this exists to close: two admissions passing the same capacity check, a claim
removing a member another transition already terminalized, or capacity released
twice. One script, one atomic Redis execution, one transition.

WHY KEYS ARE BUILT INSIDE LUA. Per-job keys depend on values the script itself
discovers (which job is at the queue head, which terminal job is evicted), so
they cannot all be declared up front in KEYS. Phase 1 is deliberately not a
Redis Cluster topology. To keep that boundary honest rather than silently
unsafe, every key this module touches lives under ONE hash-tagged namespace, so
a later clustered deployment maps them all to a single slot instead of quietly
turning a cross-slot script into a non-atomic protocol.

CALLING CONVENTION
    KEYS[1] retained-jobs sorted set        KEYS[4] diagnostic queue sorted set
    KEYS[2] pending set                     KEYS[5] bounded invariant-error stream
    KEYS[3] ordinary queue sorted set
    ARGV[1] operation name                  ARGV[3] JSON payload
    ARGV[2] hash-tagged key namespace       ARGV[4] binary blob (input or artifact)
The reply is always a JSON object carrying a `status`, so a caller never has to
map opaque integer codes, and adding a status cannot silently change an existing
one's meaning.

BINARY VALUES NEVER ENTER THE JSON PAYLOAD. Submitted input and artifact bytes
arrive as a separate raw ARGV entry, because JSON cannot carry arbitrary bytes
and a lossy round-trip would corrupt exactly the material a job is judged on.
"""

QUEUE_KEY_HASH_TAG = "{queue}"
"""Hash tag shared by every state-machine key so they occupy one Redis slot."""

STATUS_OK = "ok"
"""The transition was applied."""
STATUS_EXISTS = "exists"
"""A job with the requested ID already exists."""
STATUS_MISSING = "missing"
"""The referenced job does not exist."""
STATUS_CONFLICT = "conflict"
"""The stored revision no longer matches the caller's expectation."""
STATUS_CLAIM_LOST = "claim_lost"
"""The worker's fenced claim is no longer active at the persistence boundary."""
STATUS_EMPTY = "empty"
"""Both priority queues are empty, so there is nothing to claim."""
STATUS_RESIDUE = "residue"
"""The queue head could not be justified by its job record and was not claimed."""
STATUS_PENDING_EXHAUSTED = "pending_exhausted"
"""Total pending capacity is exhausted."""
STATUS_ORDINARY_RESERVED = "ordinary_reserved"
"""Only the reserved ordinary slots remain, so a diagnostic cannot be admitted."""
STATUS_RETAINED_EXHAUSTED = "retained_exhausted"
"""Retained capacity is exhausted and no terminal job is available to evict."""
STATUS_INVALID_TRANSITION = "invalid_transition"
"""The requested transition is not one the state machine defines."""

_LUA_PROLOGUE = """
-- Nurse scheduling atomic priority-queue state machine. Version is asserted by
-- the caller; see QUEUE_STATE_MACHINE_VERSION in server/queue_state.py.
local operation = ARGV[1]
local base = ARGV[2]
local payload = cjson.decode(ARGV[3])
local blob = ARGV[4]

local JOBS, PENDING, INVARIANTS = KEYS[1], KEYS[2], KEYS[5]
local QUEUES = {ordinary = KEYS[3], assistant_diagnostic = KEYS[4]}
local TERMINAL = {completed = true, cancelled = true, failed = true}
local PENDING_STATES = {queued = true, running = true, cancelling = true}

local function child_key(id, suffix) return base .. ':job:' .. id .. ':' .. suffix end
local function job_key(id) return base .. ':job:' .. id end
local function lease_key(id) return child_key(id, 'lease') end
local function events_key(id) return child_key(id, 'events') end

local function read_job(id)
  local raw = redis.call('GET', job_key(id))
  if not raw then return nil end
  return cjson.decode(raw)
end

-- A record written before job purpose existed reads as ordinary, which is what it
-- semantically was. Guessing 'diagnostic' would move old work into the wrong queue.
local function purpose_of(job)
  local value = job.request and job.request.purpose
  if value == nil or value == cjson.null then return 'ordinary' end
  return value
end

local function now_ms()
  local clock = redis.call('TIME')
  return tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
end

local function append_event(id, kind, data, occurred_at)
  redis.call('XADD', events_key(id), 'MAXLEN', '=', payload.max_events, '*',
             'type', kind, 'data', data, 'occurred_at', occurred_at)
end

-- Bounded and content-free on purpose: a repair record carries a stable code and a
-- job ID, never anything derived from a submitted document.
local function record_invariant_error(kind, id, occurred_at)
  redis.call('XADD', INVARIANTS, 'MAXLEN', '=', payload.max_invariant_errors, '*',
             'kind', kind, 'job_id', id, 'occurred_at', occurred_at)
end

local function forget(id)
  -- CHILD MATERIAL BEFORE THE JOB SHELL. The script is atomic so no reader sees a
  -- partial state, but the order is the durable statement of the rule: submitted
  -- input and generated artifacts must never outlive the record governing them.
  redis.call('DEL', child_key(id, 'input'), child_key(id, 'artifact'),
             child_key(id, 'artifact_metadata'), events_key(id), lease_key(id))
  redis.call('DEL', job_key(id))
  redis.call('ZREM', JOBS, id)
  redis.call('ZREM', QUEUES.ordinary, id)
  redis.call('ZREM', QUEUES.assistant_diagnostic, id)
  redis.call('SREM', PENDING, id)
end

local function drop_from_queues(id)
  redis.call('ZREM', QUEUES.ordinary, id)
  redis.call('ZREM', QUEUES.assistant_diagnostic, id)
end

-- ZRANGE orders by score then lexicographically by member, which is exactly the
-- normative FIFO key (created_at, job_id). Ordinary first, then diagnostic: that
-- concatenation IS the effective order, so position 1 is always the next claim.
local function effective_order()
  local order = {}
  for _, id in ipairs(redis.call('ZRANGE', QUEUES.ordinary, 0, -1)) do order[#order + 1] = id end
  for _, id in ipairs(redis.call('ZRANGE', QUEUES.assistant_diagnostic, 0, -1)) do order[#order + 1] = id end
  return order
end

local function position_snapshot()
  local snapshot = {}
  for index, id in ipairs(effective_order()) do
    snapshot[#snapshot + 1] = {job_id = id, position = index}
  end
  return snapshot
end

local function position_of(id)
  for index, queued_id in ipairs(effective_order()) do
    if queued_id == id then return index end
  end
  return cjson.null
end

-- Every affected position moves inside this one execution, so a subscriber can
-- never observe a position that was true only between two halves of a transition.
local function emit_positions(occurred_at, exclude_id)
  local snapshot = position_snapshot()
  for _, entry in ipairs(snapshot) do
    if entry.job_id ~= exclude_id then
      append_event(entry.job_id, 'job.state_changed', cjson.encode({
        state = 'queued', queue_position = entry.position,
        cancel_requested = false, early_completion_requested = false}), occurred_at)
    end
  end
  return snapshot
end

-- Residue is REMOVED, never claimed and never counted as capacity. An index entry
-- the store cannot justify from a job record must not be able to start work, and
-- must not keep a slot occupied against an admission the invariants would allow.
local function repair(occurred_at)
  local repaired = {}
  for purpose, queue_key in pairs(QUEUES) do
    for _, id in ipairs(redis.call('ZRANGE', queue_key, 0, -1)) do
      local job = read_job(id)
      local kind = nil
      if not job then
        kind = 'orphan_queue_member'
      elseif job.state ~= 'queued' or purpose_of(job) ~= purpose then
        kind = 'stale_queue_member'
      end
      if kind then
        redis.call('ZREM', queue_key, id)
        record_invariant_error(kind, id, occurred_at)
        repaired[#repaired + 1] = kind
      end
    end
  end
  for _, id in ipairs(redis.call('SMEMBERS', PENDING)) do
    local job = read_job(id)
    if (not job) or (not PENDING_STATES[job.state]) then
      redis.call('SREM', PENDING, id)
      record_invariant_error('stale_pending_member', id, occurred_at)
      repaired[#repaired + 1] = 'stale_pending_member'
    end
  end
  return repaired
end
"""
"""Shared Lua declarations, key derivation, ordering, and defensive repair."""


OPERATION_ADMIT = "admit"
OPERATION_CLAIM = "claim"
OPERATION_COMMIT = "commit"
OPERATION_DELETE = "delete"
OPERATION_REPAIR = "repair"
OPERATION_POSITIONS = "positions"
OPERATION_DESCRIBE = "describe"


_LUA_OPERATIONS = """
if operation == 'admit' then
  if redis.call('EXISTS', job_key(payload.job_id)) == 1 then
    return cjson.encode({status = 'exists'})
  end
  -- Repair BEFORE counting. A stale index entry must never make a genuinely free
  -- slot look occupied and refuse an admission the invariants permit.
  repair(payload.occurred_at)
  local pending_count = redis.call('SCARD', PENDING)
  if pending_count >= payload.max_pending then
    return cjson.encode({status = 'pending_exhausted'})
  end
  if payload.purpose ~= 'ordinary' and pending_count >= payload.max_pending - payload.reserve then
    return cjson.encode({status = 'ordinary_reserved'})
  end
  while redis.call('ZCARD', JOBS) >= payload.max_retained do
    local victim, victim_stamp = nil, nil
    for _, id in ipairs(redis.call('ZRANGE', JOBS, 0, -1)) do
      local job = read_job(id)
      if job and TERMINAL[job.state] then
        -- Both stamps are UTC isoformat, whose lexicographic order matches
        -- chronological order (a whole second sorts before its fractional forms
        -- because '+' < '.'), so no date parsing is needed inside the script.
        local stamp = job.finished_at
        if stamp == nil or stamp == cjson.null then stamp = job.created_at end
        if victim == nil or stamp < victim_stamp then victim, victim_stamp = id, stamp end
      end
    end
    -- Only terminal jobs are eligible, so eviction can never reclaim a slot by
    -- deleting live pending work; with none available, admission fails instead.
    if victim == nil then return cjson.encode({status = 'retained_exhausted'}) end
    forget(victim)
  end
  redis.call('SET', job_key(payload.job_id), payload.job)
  redis.call('SET', child_key(payload.job_id, 'input'), blob)
  redis.call('ZADD', JOBS, payload.score, payload.job_id)
  redis.call('ZADD', QUEUES[payload.purpose], payload.score, payload.job_id)
  redis.call('SADD', PENDING, payload.job_id)
  local position = position_of(payload.job_id)
  for _, event in ipairs(payload.events) do
    local data = event.data
    if event.queued_state == true then
      local decoded = cjson.decode(event.data)
      decoded.queue_position = position
      data = cjson.encode(decoded)
    end
    append_event(payload.job_id, event.type, data, event.occurred_at)
  end
  return cjson.encode({
    status = 'ok',
    position = position,
    positions = emit_positions(payload.occurred_at, payload.job_id)})
end

if operation == 'claim' then
  repair(payload.occurred_at)
  local order = effective_order()
  if #order == 0 then return cjson.encode({status = 'empty'}) end
  local id = order[1]
  local job = read_job(id)
  -- repair() already removed every member its job record cannot justify, so this
  -- should be claimable. It is re-checked anyway and FAILS CLOSED rather than
  -- claiming: starting a solver on a job whose state disagrees is worse than
  -- reporting nothing to claim.
  if (not job) or job.state ~= 'queued' then
    drop_from_queues(id)
    record_invariant_error('stale_queue_member', id, payload.occurred_at)
    return cjson.encode({status = 'residue'})
  end
  job.state = 'running'
  job.started_at = payload.started_at
  job.worker_id = payload.worker_id
  job.claim_expires_at = payload.claim_expires_at
  job.revision = job.revision + 1
  local encoded = cjson.encode(job)
  redis.call('SET', job_key(id), encoded)
  redis.call('SET', lease_key(id),
             payload.worker_id .. '|' .. string.format('%d', job.revision) .. '|' .. payload.claim_expires_at,
             'PXAT', payload.claim_expires_ms)
  -- Exactly the claimed member leaves its queue. Pending is RETAINED because a
  -- running job still occupies one capacity slot, and no other job is touched,
  -- which is what makes a running solve non-pre-emptive.
  redis.call('ZREM', QUEUES[purpose_of(job)], id)
  append_event(id, 'job.state_changed', payload.claim_event_data, payload.started_at)
  return cjson.encode({
    status = 'ok',
    job = encoded,
    positions = emit_positions(payload.started_at, id)})
end

if operation == 'commit' then
  local id = payload.job_id
  local current = read_job(id)
  if not current then return cjson.encode({status = 'missing'}) end
  if tonumber(current.revision) ~= tonumber(payload.expected_revision) then
    return cjson.encode({status = 'conflict'})
  end
  if payload.worker_id ~= cjson.null then
    -- Worker fencing, unchanged in meaning from the pre-T09 lease commit: the
    -- owner, the deadline it OBSERVED, Redis's own clock, and the lease token must
    -- all still agree, so a worker whose claim lapsed cannot commit a stale result.
    if current.worker_id ~= payload.worker_id
       or current.claim_expires_at ~= payload.expected_claim_expires_at then
      return cjson.encode({status = 'claim_lost'})
    end
    local moment = now_ms()
    if moment >= tonumber(payload.expected_claim_expires_ms) then
      return cjson.encode({status = 'claim_lost'})
    end
    local token = payload.worker_id .. '|'
      .. string.format('%d', tonumber(payload.expected_revision)) .. '|'
      .. payload.expected_claim_expires_at
    if redis.call('GET', lease_key(id)) ~= token then
      return cjson.encode({status = 'claim_lost'})
    end
    if tonumber(payload.next_claim_expires_ms) > 0
       and tonumber(payload.next_claim_expires_ms) <= moment then
      return cjson.encode({status = 'claim_lost'})
    end
  end
  if TERMINAL[current.state] and payload.new_state ~= current.state then
    return cjson.encode({status = 'invalid_transition', reason = 'terminal_state_change'})
  end
  if purpose_of(current) ~= payload.purpose then
    return cjson.encode({status = 'invalid_transition', reason = 'purpose_changed'})
  end
  if payload.new_state == 'queued' and current.state ~= 'queued' then
    return cjson.encode({status = 'invalid_transition', reason = 'requeue'})
  end
  if (payload.new_state == 'running' or payload.new_state == 'cancelling')
     and payload.new_worker_id == cjson.null then
    return cjson.encode({status = 'invalid_transition', reason = 'unowned_active_job'})
  end
  local was_queued = current.state == 'queued'
  redis.call('SET', job_key(id), payload.job)
  -- ONE place decides membership for EVERY transition, so cancel, completion,
  -- cancellation completion, and claim expiry cannot each drift into their own
  -- slightly different idea of which indexes to release.
  if TERMINAL[payload.new_state] then
    redis.call('SREM', PENDING, id)
    redis.call('DEL', lease_key(id))
    drop_from_queues(id)
  else
    redis.call('SADD', PENDING, id)
    if payload.new_state ~= 'queued' then drop_from_queues(id) end
    if tonumber(payload.next_claim_expires_ms) > 0 then
      redis.call('SET', lease_key(id), payload.next_lease_token, 'PXAT', payload.next_claim_expires_ms)
    else
      redis.call('DEL', lease_key(id))
    end
  end
  if payload.artifact_present == true then
    redis.call('SET', child_key(id, 'artifact'), blob)
    redis.call('HSET', child_key(id, 'artifact_metadata'),
               'name', payload.artifact_name, 'media_type', payload.artifact_media_type)
  end
  for _, event in ipairs(payload.events) do
    append_event(id, event.type, event.data, event.occurred_at)
  end
  local positions
  if was_queued and payload.new_state ~= 'queued' then
    positions = emit_positions(payload.occurred_at, id)
  else
    positions = position_snapshot()
  end
  return cjson.encode({status = 'ok', position = position_of(id), positions = positions})
end

if operation == 'delete' then
  local current = read_job(payload.job_id)
  if not current then return cjson.encode({status = 'missing'}) end
  if tonumber(current.revision) ~= tonumber(payload.expected_revision) then
    return cjson.encode({status = 'conflict'})
  end
  -- forget() releases every index the job occupied in the same atomic step as the
  -- job and its child material, so a delete cannot leave a queue member or a
  -- pending slot behind for work that no longer exists. Whether a job is deletable
  -- at all is lifecycle policy and stays with the controller.
  forget(payload.job_id)
  return cjson.encode({status = 'ok'})
end

if operation == 'repair' then
  return cjson.encode({status = 'ok', repaired = repair(payload.occurred_at)})
end

if operation == 'positions' then
  return cjson.encode({status = 'ok', positions = position_snapshot()})
end

if operation == 'describe' then
  local jobs = {}
  for _, id in ipairs(redis.call('ZRANGE', JOBS, 0, -1)) do
    local job = read_job(id)
    if job then
      jobs[#jobs + 1] = {
        job_id = id, state = job.state, purpose = purpose_of(job),
        created_at = job.created_at,
        has_claim_lease = redis.call('EXISTS', lease_key(id)) == 1}
    end
  end
  return cjson.encode({
    status = 'ok', jobs = jobs,
    pending = redis.call('SMEMBERS', PENDING),
    ordinary = redis.call('ZRANGE', QUEUES.ordinary, 0, -1, 'WITHSCORES'),
    diagnostic = redis.call('ZRANGE', QUEUES.assistant_diagnostic, 0, -1, 'WITHSCORES')})
end

return redis.error_reply('unknown queue state-machine operation')
"""
"""The transitions themselves; each returns before any later branch can run."""

QUEUE_STATE_MACHINE_SCRIPT = _LUA_PROLOGUE + _LUA_OPERATIONS
"""The complete versioned Lua state-machine module loaded into Redis."""

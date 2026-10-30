-- apply_token_state.lua — idempotent, version-guarded projection of one token.
-- KEYS[1] = q:{qs}:tok:<tokenId>, KEYS[2] = q:{qs}:lane:0, KEYS[3] = q:{qs}:lane:1, KEYS[4] = q:{qs}:lane:2
-- ARGV[1] = tokenId, ARGV[2] = version, ARGV[3] = status, ARGV[4] = lane (0-2),
-- ARGV[5] = score (queue_entry_at, epoch ms), ARGV[6] = display code, ARGV[7] = room label
local current = tonumber(redis.call('HGET', KEYS[1], 'v') or '-1')
local version = tonumber(ARGV[2])
if version <= current then return 0 end                       -- stale or duplicate event
for i = 2, 4 do redis.call('ZREM', KEYS[i], ARGV[1]) end
if ARGV[3] == 'waiting' then
  redis.call('ZADD', KEYS[tonumber(ARGV[4]) + 2], ARGV[5], ARGV[1])
end
redis.call('HSET', KEYS[1], 'v', version, 'status', ARGV[3], 'lane', ARGV[4], 'code', ARGV[6], 'room', ARGV[7])
local terminal = { completed = true, cancelled = true, no_show = true, transferred = true }
redis.call('EXPIRE', KEYS[1], terminal[ARGV[3]] and 7200 or 86400)
return 1

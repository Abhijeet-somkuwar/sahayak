-- token_position.lua — position, people ahead, and ETA for one waiting token. O(log n).
-- KEYS[1..3] = q:{qs}:lane:0..2, KEYS[4] = q:{qs}:meta
-- ARGV[1] = tokenId, ARGV[2] = lane (0-2)
local lane = tonumber(ARGV[2])
local rank = redis.call('ZRANK', KEYS[lane + 1], ARGV[1])
if not rank then return nil end
local urgent    = redis.call('ZCARD', KEYS[1])
local protected = redis.call('ZCARD', KEYS[2])
local general   = redis.call('ZCARD', KEYS[3])
local m = redis.call('HMGET', KEYS[4], 'ewma_consult_sec', 'active_servers', 'ratio_protected', 'ratio_general')
local ewma    = tonumber(m[1]) or 300
local servers = math.max(tonumber(m[2]) or 1, 1)
local rp      = math.max(tonumber(m[3]) or 1, 1)
local rg      = math.max(tonumber(m[4]) or 2, 1)
local ahead
if lane == 0 then
  ahead = rank
elseif lane == 1 then
  ahead = urgent + rank + math.min(general, math.ceil((rank + 1) * rg / rp))
else
  ahead = urgent + rank + math.min(protected, math.ceil((rank + 1) * rp / rg))
end
return { rank, ahead, math.ceil((ahead + 1) / servers) * ewma }

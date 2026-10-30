-- release_lock.lua — compare-and-delete: only the owner of the lock may release it (§9.9).
-- KEYS[1] = lock key, ARGV[1] = owner token
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0

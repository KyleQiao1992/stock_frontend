import { initializeAdmin } from '../userStore.js';
import { getRedisClient } from '../redisClient.js';
try {
  const username = process.argv[2]?.trim().toLowerCase();
  await initializeAdmin(username);
  console.log(`已将现有账号 ${username} 设置为可用管理员。`);
} catch (error) {
  console.error(error.status === 404 ? '指定账号不存在；没有创建新账号。' : '管理员初始化失败，请检查用户名和 Redis 配置。');
  process.exitCode = 1;
} finally {
  try { const redis = await getRedisClient(); await redis.close(); } catch { /* No open connection. */ }
}

# 账号与权限

账号继续使用 Redis `user:{username}`，ID 和用户自选股归属不变。
新增字段：`role`（user/admin）、`status`（active/disabled）、`tokenVersion`、`updatedAt`。
旧记录缺失字段时，按普通用户、启用状态、版本 0 处理。

## 权限范围

普通用户可使用行情、推荐、AI 助手以及自己的自选股、收藏夹与回测。
只有管理员可以访问整个因子研究页面、研究收益/详情接口、因子管理和账号管理。
`/api/factors` 的简要因子列表供推荐下拉框使用，继续允许普通用户访问。
管理员不因角色而获得其他用户的自选股读取能力。
开发、预览与生产共同使用 `server/apiPermissions.js`。

## 管理接口

- GET /api/auth/me：当前账号公开信息。
- POST /api/auth/change-password：currentPassword、newPassword；修改后所有旧凭证失效。
- GET /api/admin/users?q=&page=1：用户名搜索，固定每页 20 条。
- PATCH /api/admin/users/:username：只接受 role、status。
- POST /api/admin/users/:username/reset-password：newPassword。
- POST /api/admin/users/:username/revoke-sessions：撤销该账号所有旧登录凭证。

管理接口不返回密码、密码哈希。管理员不能禁用自己或给自己降权。
账号更新通过 Redis Lua 比较并交换，保留并发字段更新和 TTL。
最后一个可用管理员保护与账号写入在同一次 Lua 操作中完成。
当前面向小规模账号：列表使用 SCAN 枚举后分页；最后管理员保护在降权/禁用管理员时使用 KEYS 枚举。
账号规模扩大前应改为维护事务性的账号/管理员索引，避免全量枚举阻塞 Redis。

## 登录与上线

新 JWT 使用 HS256，有效期 7 天，保存 id、username、tokenVersion。
每次业务请求重新读取账号，检查 ID、状态和版本。角色使用最新存储值。
旧 JWT 缺少 exp 或 tokenVersion 将返回 401；升级后用户需要重新登录，不需重新注册。
禁用账号、修改密码、重置密码、撤销登录递增版本；重新启用不会恢复旧凭证。
页面每分钟以及获得焦点时刷新当前身份；403 也刷新角色，后端权限实时生效。
不同标签页切换账号或退出时，通过 storage 事件同步并清除旧页面身份。
新注册、修改及重置密码限制为至少 6 位、最多 72 个 UTF-8 字节，避免 bcrypt 截断；旧密码验证保留兼容。
账号接口响应及前端身份请求禁止缓存。
退出登录只清除当前浏览器数据；撤销登录影响所有设备。

初始化管理员（只更新已有账号，不创建账号）：

```sh
npm run initialize-admin -- chongyang
```

初始化保留用户 ID、密码及自选股，明确将指定账号设置为 admin/active。
不要将此脚本放入每次启动流程，以免覆盖之后的角色或禁用操作。
2026-10-03 已在本次工作使用的 Redis 配置中对 chongyang 执行初始化；其他环境需分别检查或初始化。

所有连接共享 Redis 的服务应一起升级，旧版服务不会执行新权限检查。
原有明文密码兼容与 AUTH_PASSWORD_MIGRATION 开关保留。
修改或重置密码会直接改为 bcrypt 哈希，旧版登录服务可能无法读取；上线前须统一升级。

## 验证

```sh
node --test server/authHandlers.test.js server/accountPermissions.test.js
AUTH_REDIS_INTEGRATION=1 node --test server/accountPermissions.test.js
```

第二条命令使用当前配置的 Redis 验证真实 Lua。测试账号在随机独立命名空间中创建，测试完成仅清理自己的 key。

## 2026-10-03 上线前复查

- 已修复跨标签页切换账号后旧身份残留，以及新密码超过 bcrypt 72 字节限制的问题。
- AUTH_REDIS_INTEGRATION=1 npm test：405 项通过，0 失败，0 跳过。
- npm run lint、npm run build 均通过。
- 本地生产启动的真实 HTTP 验证通过：chongyang 管理员身份、普通用户权限拦截、升降权、禁用/重新启用、密码重置及旧 JWT 拒绝。临时测试账号已清理。
- 生产构建的浏览器检查使用模拟接口，覆盖角色入口、账号表单、过期/故障、降权和跨标签页身份同步。
- 本地 Docker daemon 未运行，未实际构建镜像；未部署或检查线上实例。部署环境若连接不同 Redis，需确认 chongyang 的 role/status，并同步升级所有后端。

# kubernetes-reconcile-core

JavaScript Kubernetes 控制器协调核心库：不连接真实集群，所有 API 调用通过注入的
client 完成。输入 custom resource（CR）与当前集群快照，计算需要创建、更新、删除的
子资源（Deployment / Service / ConfigMap），并正确维护 ownerReference、finalizer
与 status。

## 运行测试

```sh
node --test
```

## 结构

- `src/desired.js` — 由 CR 构建期望对象，设置 labels 与 controller ownerReference。
- `src/plan.js` — 纯函数：输入 CR、期望对象与集群快照，输出 `{ creates, updates, deletes }`。
- `src/equality.js` — 归一化（剥离 `resourceVersion`、`uid`、`status` 等运行时字段）后做深比较。
- `src/reconciler.js` — 执行计划，处理冲突重试、finalizer 与 status 更新。
- `src/fake-client.js` — 内存 client，实现 resourceVersion 语义、409 冲突与故障注入，供测试与参考。
- `src/errors.js` — `ApiError`（`code`/`reason`）及 `isNotFound` / `isAlreadyExists` / `isConflict` 判定。

## Client 接口

任何注入的 client 需实现：

```js
get(apiVersion, kind, namespace, name)      // 不存在抛 404 ApiError
list(namespace, labelSelector)              // 返回匹配对象数组
create(obj)                                 // 已存在抛 409 AlreadyExists
update(obj)                                 // resourceVersion 不匹配抛 409 Conflict
updateStatus(obj)                           // 同上，仅更新 status
delete(apiVersion, kind, namespace, name)   // 不存在抛 404
```

## 幂等规则

- 协调是 level-based 而非 edge-based：每轮都从 CR 与当前快照重新计算期望状态，
  重复执行同一轮协调不会产生任何写调用（测试用 `mutationCalls()` 断言为空）。
- 比较前对对象归一化：忽略 `resourceVersion`、`uid`、`creationTimestamp`、`status`
  等集群运行时字段，只比较控制器管理的期望内容，因此手工篡改会被检测并恢复。
- 创建采用「先读后建」：快照中不存在才 create；更新用最新 `resourceVersion` 合并
  期望内容，不覆盖集群维护的 `status`。
- 孤儿回收只删除带本 CR controller ownerReference 的对象，第三方对象不受影响。
- 任意中间态（半完成创建、被篡改、冲突重试后）继续协调，最终集群状态与从干净
  状态连续协调的结果完全一致。

## 错误与重试规则

- **create 返回 409 AlreadyExists**：说明快照过期（如控制器重启后重复创建）。
  重新 get 该对象，与期望比较：一致则跳过，漂移则转为 update。
- **update 返回 409 Conflict（resourceVersion 冲突）**：说明有并发修改。重新 get
  最新对象，在其最新 `resourceVersion` 上重新合并期望内容后重试，最多
  `maxRetries`（默认 5）次，超过后把错误抛给上层按 requeue 处理。
- **delete 返回 404**：视为已删除，直接忽略（删除天然幂等）。
- **finalizer**：CR 无 `deletionTimestamp` 时确保 finalizer 存在；有
  `deletionTimestamp` 时先清理全部子资源，全部成功后才移除 finalizer。
  清理中途失败会抛出错误并**保留 finalizer**，下一轮重试继续清理，不会泄漏
  也不会提前放行删除。移除 finalizer 的 update 冲突同样重读后重试。
- **status**：仅在内容变化时调用 `updateStatus`，冲突时重读 CR 后重试；
  `observedGeneration` 与 conditions 由当前期望状态重新计算。
- 其他错误（5xx、网络错误等）不重试，直接抛出，由上层调度器决定 requeue 退避。

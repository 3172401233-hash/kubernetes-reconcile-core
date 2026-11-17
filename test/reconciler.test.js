import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/errors.js';
import { buildDesiredObjects } from '../src/desired.js';
import { computePlan, loadSnapshot } from '../src/plan.js';
import { DEFAULT_FINALIZER, Reconciler } from '../src/reconciler.js';
import { FakeClient, objectsInStoreEqual } from '../src/fake-client.js';

const CR_API_VERSION = 'apps.example.com/v1';
const CR_KIND = 'WebApp';

function makeCR(overrides = {}) {
  return {
    apiVersion: CR_API_VERSION,
    kind: CR_KIND,
    metadata: {
      name: 'demo',
      namespace: 'default',
      uid: 'cr-uid-1',
      generation: 1,
      ...(overrides.metadata ?? {}),
    },
    spec: {
      image: 'nginx:1.25',
      replicas: 2,
      port: 80,
      config: { LOG_LEVEL: 'info' },
      ...(overrides.spec ?? {}),
    },
    ...(overrides.status ? { status: overrides.status } : {}),
  };
}

async function readCR(client, cr) {
  return client.get(cr.apiVersion, cr.kind, cr.metadata.namespace, cr.metadata.name);
}

async function seedCR(client, cr) {
  await client.create(structuredClone(cr));
  return readCR(client, cr);
}

async function reconcileFromClean() {
  const client = new FakeClient();
  const reconciler = new Reconciler(client);
  const cr = await seedCR(client, makeCR());
  await reconciler.reconcile(cr);
  await reconciler.reconcile(await readCR(client, cr));
  return client;
}

test('首次协调创建全部子资源并设置 ownerReference、finalizer 和 status', async () => {
  const client = new FakeClient();
  const reconciler = new Reconciler(client);
  const cr = await seedCR(client, makeCR());

  await reconciler.reconcile(cr);

  const kinds = client
    .snapshotObjects()
    .map((o) => o.kind)
    .sort();
  assert.deepEqual(kinds, ['ConfigMap', 'Deployment', 'Service', CR_KIND].sort());

  for (const obj of client.snapshotObjects()) {
    if (obj.kind === CR_KIND) continue;
    const owner = obj.metadata.ownerReferences?.[0];
    assert.equal(owner?.uid, 'cr-uid-1', `${obj.kind} 缺少 ownerReference`);
    assert.equal(owner?.controller, true);
    assert.equal(owner?.blockOwnerDeletion, true);
    assert.equal(obj.metadata.labels['app.kubernetes.io/instance'], 'demo');
  }

  const after = await readCR(client, cr);
  assert.ok(after.metadata.finalizers.includes(DEFAULT_FINALIZER));
  assert.equal(after.status.observedGeneration, 1);
  assert.deepEqual(after.status.managedResources, ['ConfigMap', 'Deployment', 'Service']);
  assert.equal(after.status.conditions[0].type, 'Ready');
  assert.equal(after.status.conditions[0].status, 'True');
});

test('重复协调是幂等的：第二轮没有任何写调用', async () => {
  const client = new FakeClient();
  const reconciler = new Reconciler(client);
  const cr = await seedCR(client, makeCR());

  await reconciler.reconcile(cr);
  const before = client.snapshotObjects();
  client.clearCalls();

  await reconciler.reconcile(await readCR(client, cr));
  await reconciler.reconcile(await readCR(client, cr));

  assert.deepEqual(
    client.mutationCalls(),
    [],
    `幂等协调不应有写调用: ${JSON.stringify(client.mutationCalls())}`,
  );
  assert.ok(objectsInStoreEqual(before, client.snapshotObjects()));
});

test('plan 从快照计算出正确的 create/update/delete 集合', async () => {
  const client = new FakeClient();
  const cr = makeCR();
  const desired = buildDesiredObjects(cr);

  let snapshot = await loadSnapshot(client, cr, desired);
  let plan = computePlan(cr, desired, snapshot);
  assert.equal(plan.creates.length, 3);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.deletes.length, 0);

  const reconciler = new Reconciler(client);
  const stored = await seedCR(client, cr);
  await reconciler.reconcile(stored);

  snapshot = await loadSnapshot(client, cr, desired);
  plan = computePlan(cr, desired, snapshot);
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.deletes.length, 0);
});

test('update 遇到 resourceVersion 冲突时重新读取并收敛', async () => {
  const client = new FakeClient();
  const reconciler = new Reconciler(client);
  const cr = await seedCR(client, makeCR());
  await reconciler.reconcile(cr);

  const key = 'apps/v1/Deployment/default/demo';
  client.store.get(key).spec.replicas = 99;

  let bumped = false;
  client.beforeUpdateHooks.push((obj, stored, c) => {
    if (!bumped && obj.kind === 'Deployment') {
      bumped = true;
      stored.metadata.resourceVersion = c.nextResourceVersion();
    }
  });

  await reconciler.reconcile(await readCR(client, cr));

  assert.ok(bumped, '应当模拟了一次并发修改');
  const conflicts = client.calls.filter((c) => c.method === 'update');
  assert.ok(conflicts.length >= 2, '冲突后应当重试 update');
  assert.equal(client.store.get(key).spec.replicas, 2, '最终应收敛回期望副本数');

  const clean = await reconcileFromClean();
  assert.ok(objectsInStoreEqual(clean.snapshotObjects(), client.snapshotObjects()));
});

test('create 返回 AlreadyExists 时重新读取并按 update 收敛', async () => {
  const client = new FakeClient();
  const reconciler = new Reconciler(client);
  const cr = await seedCR(client, makeCR());

  const originalCreate = client.create.bind(client);
  let raced = false;
  client.create = async (obj) => {
    if (!raced && obj.kind === 'Deployment') {
      raced = true;
      const tampered = structuredClone(obj);
      tampered.spec.replicas = 7;
      await originalCreate(tampered);
      throw new ApiError(409, 'AlreadyExists', 'deployments "demo" already exists');
    }
    return originalCreate(obj);
  };

  await reconciler.reconcile(cr);

  assert.ok(raced);
  const deployment = client.store.get('apps/v1/Deployment/default/demo');
  assert.equal(deployment.spec.replicas, 2, 'AlreadyExists 后应重新读取并纠正漂移');

  const clean = await reconcileFromClean();
  assert.ok(objectsInStoreEqual(clean.snapshotObjects(), client.snapshotObjects()));
});

test('finalizer 清理失败时保留 finalizer，恢复后重试完成删除', async () => {
  const client = new FakeClient();
  const reconciler = new Reconciler(client);
  const cr = await seedCR(client, makeCR());
  await reconciler.reconcile(cr);

  const key = `${CR_API_VERSION}/${CR_KIND}/default/demo`;
  const stored = client.store.get(key);
  stored.metadata.deletionTimestamp = new Date().toISOString();

  client.failNext('delete', new ApiError(500, 'InternalError', 'etcd unavailable'), 1);

  await assert.rejects(
    reconciler.reconcile(await readCR(client, cr)),
    (err) => err.code === 500,
  );

  const afterFailure = client.store.get(key);
  assert.ok(afterFailure, '清理失败时 CR 不应被移除');
  assert.ok(
    afterFailure.metadata.finalizers.includes(DEFAULT_FINALIZER),
    '清理失败时 finalizer 必须保留',
  );

  await reconciler.reconcile(await readCR(client, cr));

  assert.equal(client.store.get(key), undefined, 'finalizer 移除后 CR 应被删除');
  const remaining = client.snapshotObjects();
  assert.deepEqual(remaining, [], '所有子资源应被清理');
});

test('删除时移除 finalizer 遇到冲突会重读后重试', async () => {
  const client = new FakeClient();
  const reconciler = new Reconciler(client);
  const cr = await seedCR(client, makeCR());
  await reconciler.reconcile(cr);

  const key = `${CR_API_VERSION}/${CR_KIND}/default/demo`;
  client.store.get(key).metadata.deletionTimestamp = new Date().toISOString();

  let bumped = false;
  client.beforeUpdateHooks.push((obj, stored, c) => {
    if (!bumped && obj.kind === CR_KIND) {
      bumped = true;
      stored.metadata.resourceVersion = c.nextResourceVersion();
    }
  });

  await reconciler.reconcile(await readCR(client, cr));

  assert.ok(bumped);
  assert.equal(client.store.get(key), undefined);
  assert.deepEqual(client.snapshotObjects(), []);
});

test('半完成创建：已有部分子资源时补齐其余资源', async () => {
  const client = new FakeClient();
  const reconciler = new Reconciler(client);
  const cr = await seedCR(client, makeCR());

  const [configMap] = buildDesiredObjects(cr);
  await client.create(configMap);

  await reconciler.reconcile(cr);

  const kinds = client
    .snapshotObjects()
    .map((o) => o.kind)
    .sort();
  assert.deepEqual(kinds, ['ConfigMap', 'Deployment', 'Service', CR_KIND].sort());

  const clean = await reconcileFromClean();
  assert.ok(objectsInStoreEqual(clean.snapshotObjects(), client.snapshotObjects()));
});

test('对象被手工篡改后协调恢复期望状态', async () => {
  const client = new FakeClient();
  const reconciler = new Reconciler(client);
  const cr = await seedCR(client, makeCR());
  await reconciler.reconcile(cr);

  client.store.get('apps/v1/Deployment/default/demo').spec.replicas = 10;
  client.store.get('v1/ConfigMap/default/demo').data.LOG_LEVEL = 'debug';
  client.store.get('v1/Service/default/demo').spec.ports[0].port = 8080;

  await reconciler.reconcile(await readCR(client, cr));

  assert.equal(client.store.get('apps/v1/Deployment/default/demo').spec.replicas, 2);
  assert.equal(client.store.get('v1/ConfigMap/default/demo').data.LOG_LEVEL, 'info');
  assert.equal(client.store.get('v1/Service/default/demo').spec.ports[0].port, 80);

  const clean = await reconcileFromClean();
  assert.ok(objectsInStoreEqual(clean.snapshotObjects(), client.snapshotObjects()));
});

test('不再被期望的属主对象会被回收', async () => {
  const client = new FakeClient();
  const reconciler = new Reconciler(client);
  const cr = await seedCR(client, makeCR());
  await reconciler.reconcile(cr);

  const stale = buildDesiredObjects(cr)[0];
  stale.metadata.name = 'stale-cm';
  await client.create(stale);

  const foreign = structuredClone(stale);
  foreign.metadata.name = 'foreign-cm';
  foreign.metadata.ownerReferences = [];
  await client.create(foreign);

  await reconciler.reconcile(await readCR(client, cr));

  assert.equal(client.store.get('v1/ConfigMap/default/stale-cm'), undefined);
  assert.ok(client.store.get('v1/ConfigMap/default/foreign-cm'), '非本 CR 所有的对象不应被删除');
});

test('各异常场景收敛结果与干净状态连续协调一致', async () => {
  const clean = await reconcileFromClean();

  const tampered = new FakeClient();
  {
    const reconciler = new Reconciler(tampered);
    const cr = await seedCR(tampered, makeCR());
    await reconciler.reconcile(cr);
    tampered.store.get('apps/v1/Deployment/default/demo').spec.replicas = 5;
    await reconciler.reconcile(await readCR(tampered, cr));
    await reconciler.reconcile(await readCR(tampered, cr));
  }

  const partial = new FakeClient();
  {
    const reconciler = new Reconciler(partial);
    const cr = await seedCR(partial, makeCR());
    await partial.create(buildDesiredObjects(cr)[0]);
    await reconciler.reconcile(cr);
    await reconciler.reconcile(await readCR(partial, cr));
  }

  const conflicted = new FakeClient();
  {
    const reconciler = new Reconciler(conflicted);
    const cr = await seedCR(conflicted, makeCR());
    let bumps = 3;
    conflicted.beforeUpdateHooks.push((obj, stored, c) => {
      if (bumps > 0 && obj.kind !== CR_KIND) {
        bumps -= 1;
        stored.metadata.resourceVersion = c.nextResourceVersion();
      }
    });
    await reconciler.reconcile(cr);
    await reconciler.reconcile(await readCR(conflicted, cr));
  }

  for (const [name, client] of [
    ['tampered', tampered],
    ['partial', partial],
    ['conflicted', conflicted],
  ]) {
    assert.ok(
      objectsInStoreEqual(clean.snapshotObjects(), client.snapshotObjects()),
      `${name} 场景最终状态应与干净协调一致`,
    );
  }
});

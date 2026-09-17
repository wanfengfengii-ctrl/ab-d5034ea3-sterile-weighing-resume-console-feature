/**
 * IndexedDB 原语层。全应用唯一的持久化介质（无业务后端、无在线调用）。
 *
 * 三个对象仓库：
 *  - meta     ：键值对，目前保存 'recipe'（批次开始后写入，之后不可替换）；
 *  - prepares ：预备记录（keyPath: seq），每次确认的第一次独立写入；
 *  - commits  ：提交标记（keyPath: seq），每次确认的第二次独立写入。
 */

export const DB_NAME = 'sterile-weighing-journal';
const DB_VERSION = 1;

export const STORE_META = 'meta';
export const STORE_PREPARES = 'prepares';
export const STORE_COMMITS = 'commits';

/**
 * 预备记录：含步骤与剂量，序号递增。
 * 稳定读数步骤另存 readings：参与判定的最后 N 项读数证据（长度恰为采样数 N），
 * doseMg 必须与由 readings 重算的候选剂量一致；旧配方的单次称量步骤无此字段。
 */
export interface PrepareRecord {
  seq: number;
  stepId: string;
  doseMg: number;
  /** 仅稳定读数步骤存在：所用读数证据（毫克，非负安全整数）。 */
  readings?: number[];
}

/** 提交标记：仅有序号；存在即表示对应预备记录已生效。 */
export interface CommitMarker {
  seq: number;
}

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
      if (!db.objectStoreNames.contains(STORE_PREPARES)) {
        db.createObjectStore(STORE_PREPARES, { keyPath: 'seq' });
      }
      if (!db.objectStoreNames.contains(STORE_COMMITS)) {
        db.createObjectStore(STORE_COMMITS, { keyPath: 'seq' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('无法打开 IndexedDB'));
  });
}

export function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('无法删除 IndexedDB'));
    req.onblocked = () => reject(new Error('删除数据库被阻塞：仍有未关闭的连接'));
  });
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
  });
}

export async function getMeta<T>(db: IDBDatabase, key: string): Promise<T | null> {
  const value = await requestToPromise(
    db.transaction(STORE_META, 'readonly').objectStore(STORE_META).get(key),
  );
  return (value ?? null) as T | null;
}

export async function putMeta(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  const tx = db.transaction(STORE_META, 'readwrite');
  tx.objectStore(STORE_META).put(value, key);
  await txDone(tx);
}

export async function getAllPrepares(db: IDBDatabase): Promise<PrepareRecord[]> {
  const rows = await requestToPromise(
    db.transaction(STORE_PREPARES, 'readonly').objectStore(STORE_PREPARES).getAll(),
  );
  return (rows as PrepareRecord[]).slice().sort((a, b) => a.seq - b.seq);
}

export async function getAllCommits(db: IDBDatabase): Promise<CommitMarker[]> {
  const rows = await requestToPromise(
    db.transaction(STORE_COMMITS, 'readonly').objectStore(STORE_COMMITS).getAll(),
  );
  return (rows as CommitMarker[]).slice().sort((a, b) => a.seq - b.seq);
}

/** 独立事务写入一条预备记录（每次确认的第一次写入）。 */
export async function putPrepareRecord(db: IDBDatabase, record: PrepareRecord): Promise<void> {
  const tx = db.transaction(STORE_PREPARES, 'readwrite');
  tx.objectStore(STORE_PREPARES).put(record);
  await txDone(tx);
}

/** 独立事务写入一枚提交标记（每次确认的第二次写入）。 */
export async function putCommitMarker(db: IDBDatabase, seq: number): Promise<void> {
  const tx = db.transaction(STORE_COMMITS, 'readwrite');
  tx.objectStore(STORE_COMMITS).put({ seq });
  await txDone(tx);
}

export async function deletePrepareRecord(db: IDBDatabase, seq: number): Promise<void> {
  const tx = db.transaction(STORE_PREPARES, 'readwrite');
  tx.objectStore(STORE_PREPARES).delete(seq);
  await txDone(tx);
}

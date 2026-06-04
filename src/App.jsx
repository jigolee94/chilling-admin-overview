import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query } from "firebase/firestore";
import { db, firebaseConfigured } from "./firebase.js";
import { demoStores, demoTablesByStore, demoTimersByStore } from "./demoData.js";

const CUSTOMER_SESSION_MINUTES = 90;

function toMillis(value) {
  if (!value) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.seconds === "number") return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1_000_000);
  return null;
}

function fromSnapshot(doc) {
  return { id: doc.id, ...doc.data() };
}

function storeSyncTime(store) {
  return store?.lastSeenAt || store?.updatedAt || store?.updatedAtMs;
}

function getMainDeviceStores(stores) {
  const latestByName = new Map();

  stores
    .filter((store) => String(store.mainDeviceId || "").trim())
    .forEach((store) => {
      const key = String(store.name || store.storeId || store.id);
      const current = latestByName.get(key);
      if (!current || toMillis(storeSyncTime(store)) > toMillis(storeSyncTime(current))) {
        latestByName.set(key, store);
      }
    });

  return [...latestByName.values()].sort((a, b) => toMillis(storeSyncTime(b)) - toMillis(storeSyncTime(a)));
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatClock(value) {
  const ms = toMillis(value);
  if (!ms) return "-";
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateTime(value) {
  const ms = toMillis(value);
  if (!ms) return "-";
  const date = new Date(ms);
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatRelative(value, now = Date.now()) {
  const ms = toMillis(value);
  if (!ms) return "-";
  const diff = ms - now;
  const abs = Math.abs(diff);
  const totalSeconds = Math.floor(abs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const label = minutes ? `${minutes}분 ${pad(seconds)}초` : `${seconds}초`;
  return diff >= 0 ? `${label} 남음` : `${label} 지남`;
}

function formatLastSeen(value, now = Date.now()) {
  const ms = toMillis(value);
  if (!ms) return "동기화 없음";
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  return formatDateTime(ms);
}

function computeEstimatedEnd(timer) {
  const stored = toMillis(timer?.estimatedEndAt);
  if (stored) return stored;
  const served = toMillis(timer?.servedAt) || toMillis(timer?.scheduledServedAt);
  if (!served) return null;
  return served + CUSTOMER_SESSION_MINUTES * 60 * 1000;
}

function computeTimerStatus(timer, now = Date.now()) {
  if (!timer) return "empty";
  const nextTaskAt = toMillis(timer.nextTaskAt);
  if (timer.needsConfirm || timer.isOverdue || timer.status === "overdue" || (nextTaskAt && nextTaskAt <= now)) return "overdue";
  if (timer.needsRefill || timer.status === "refill") return "refill";
  if (timer.isUrgent || timer.status === "urgent" || (nextTaskAt && nextTaskAt - now <= 60_000)) return "urgent";
  return "normal";
}

function statusText(status) {
  const map = {
    empty: "비어있음",
    normal: "정상 진행 중",
    urgent: "1분 이하 임박",
    overdue: "확인 필요",
    refill: "후카 추가 추천",
  };
  return map[status] || "상태 확인";
}

function statusClass(status) {
  const map = {
    empty: "table-empty",
    normal: "table-normal",
    urgent: "table-urgent",
    overdue: "table-overdue",
    refill: "table-refill",
  };
  return map[status] || "table-normal";
}

function sortByName(items) {
  return [...items].sort((a, b) => (a.name || "").localeCompare(b.name || "", "ko-KR", { numeric: true }));
}

function useStores() {
  const [stores, setStores] = useState(demoStores);
  const [loading, setLoading] = useState(firebaseConfigured);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!firebaseConfigured || !db) return undefined;
    setLoading(true);
    const unsubscribe = onSnapshot(
      query(collection(db, "stores")),
      (snapshot) => {
        setStores(getMainDeviceStores(snapshot.docs.map(fromSnapshot)));
        setLoading(false);
        setError("");
      },
      (err) => {
        console.error(err);
        setError("Firestore 지점 데이터를 불러오지 못했어요. Firebase 설정과 권한을 확인해주세요.");
        setLoading(false);
      }
    );
    return unsubscribe;
  }, []);

  return { stores, loading, error, usingDemo: !firebaseConfigured };
}

function useStoreCollections(stores) {
  const [tablesByStore, setTablesByStore] = useState(firebaseConfigured ? {} : demoTablesByStore);
  const [timersByStore, setTimersByStore] = useState(firebaseConfigured ? {} : demoTimersByStore);
  const [error, setError] = useState("");
  const storeIds = useMemo(() => stores.map((store) => store.id).filter(Boolean).join("|"), [stores]);

  useEffect(() => {
    if (!firebaseConfigured || !db) {
      setTablesByStore(demoTablesByStore);
      setTimersByStore(demoTimersByStore);
      return undefined;
    }

    const ids = storeIds.split("|").filter(Boolean);
    setError("");

    if (!ids.length) {
      setTablesByStore({});
      setTimersByStore({});
      return undefined;
    }

    setTablesByStore((prev) => Object.fromEntries(ids.map((id) => [id, prev[id] || []])));
    setTimersByStore((prev) => Object.fromEntries(ids.map((id) => [id, prev[id] || []])));

    const unsubscribes = ids.flatMap((storeId) => [
      onSnapshot(
        query(collection(db, "stores", storeId, "tables")),
        (snapshot) => {
          setTablesByStore((prev) => ({ ...prev, [storeId]: snapshot.docs.map(fromSnapshot) }));
          setError("");
        },
        (err) => {
          console.error(err);
          setError("전체지점 테이블 현황을 불러오지 못했어요.");
        }
      ),
      onSnapshot(
        query(collection(db, "stores", storeId, "timers")),
        (snapshot) => {
          setTimersByStore((prev) => ({ ...prev, [storeId]: snapshot.docs.map(fromSnapshot) }));
          setError("");
        },
        (err) => {
          console.error(err);
          setError("전체지점 타이머 현황을 불러오지 못했어요.");
        }
      ),
    ]);

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    };
  }, [storeIds]);

  return { tablesByStore, timersByStore, error };
}

function useStoreDetail(storeId) {
  const [tables, setTables] = useState(demoTablesByStore[storeId] || []);
  const [timers, setTimers] = useState(demoTimersByStore[storeId] || []);
  const [error, setError] = useState("");

  useEffect(() => {
    setTables(demoTablesByStore[storeId] || []);
    setTimers(demoTimersByStore[storeId] || []);
    if (!storeId || !firebaseConfigured || !db) return undefined;

    const tablesUnsubscribe = onSnapshot(
      query(collection(db, "stores", storeId, "tables")),
      (snapshot) => {
        setTables(snapshot.docs.map(fromSnapshot));
        setError("");
      },
      (err) => {
        console.error(err);
        setError("테이블 배치 데이터를 불러오지 못했어요.");
      }
    );

    const timersUnsubscribe = onSnapshot(
      query(collection(db, "stores", storeId, "timers")),
      (snapshot) => {
        setTimers(snapshot.docs.map(fromSnapshot));
        setError("");
      },
      (err) => {
        console.error(err);
        setError("타이머 데이터를 불러오지 못했어요.");
      }
    );

    return () => {
      tablesUnsubscribe();
      timersUnsubscribe();
    };
  }, [storeId]);

  return { tables, timers, error };
}

function buildStoreStats(store, tables, timers, now) {
  const activeTimers = timers.filter((timer) => timer.status !== "completed" && !timer.completed);
  const tableIdsWithTimers = new Set(activeTimers.map((timer) => timer.tableId));
  const emptyTables = tables.filter((table) => !tableIdsWithTimers.has(table.id));
  const enrichedTimers = activeTimers.map((timer) => ({
    ...timer,
    statusComputed: computeTimerStatus(timer, now),
    estimatedEndAtComputed: computeEstimatedEnd(timer),
  }));
  const urgentCount = enrichedTimers.filter((timer) => timer.statusComputed === "urgent").length;
  const overdueCount = enrichedTimers.filter((timer) => timer.statusComputed === "overdue").length;
  const refillCount = enrichedTimers.filter((timer) => timer.statusComputed === "refill").length;
  const availableCandidates = enrichedTimers
    .filter((timer) => timer.estimatedEndAtComputed)
    .sort((a, b) => a.estimatedEndAtComputed - b.estimatedEndAtComputed);
  const earliestTimer = availableCandidates[0] || null;
  const isFull = tables.length > 0 && emptyTables.length === 0;

  return {
    activeTimerCount: activeTimers.length,
    urgentCount,
    overdueCount,
    refillCount,
    emptyTableCount: emptyTables.length,
    isFull,
    earliestAvailableAt: isFull ? earliestTimer?.estimatedEndAtComputed || toMillis(store.earliestAvailableAt) : Date.now(),
    earliestTableName: isFull ? earliestTimer?.tableName || "테이블" : emptyTables[0]?.name || "빈 테이블",
    enrichedTimers,
  };
}

function Header({ usingDemo }) {
  return (
    <header className="app-header">
      <div>
        <p className="eyebrow">Chilling Admin</p>
        <h1>전체 지점 현황</h1>
      </div>
      <div className={usingDemo ? "mode-badge demo" : "mode-badge live"}>{usingDemo ? "Demo Data" : "Firestore Live"}</div>
    </header>
  );
}

function StoreCard({ store, tables, timers, now, onSelect }) {
  const stats = buildStoreStats(store, tables, timers, now);
  const syncedAt = storeSyncTime(store);
  const stale = toMillis(syncedAt) && now - toMillis(syncedAt) > 120_000;

  return (
    <button type="button" className="store-card" onClick={onSelect}>
      <div className="store-card-top">
        <div>
          <h2>{store.name || store.id}</h2>
          <p className={stale ? "sync stale" : "sync"}>{store.isOpen === false ? "영업 종료" : "영업중"} · 마지막 동기화 {formatLastSeen(syncedAt, now)}</p>
        </div>
        <span className={stats.isFull ? "full-badge full" : "full-badge"}>{stats.isFull ? "만석" : `빈 테이블 ${stats.emptyTableCount}`}</span>
      </div>
      <div className="store-stats-grid">
        <Metric label="진행 중" value={`${stats.activeTimerCount}개`} />
        <Metric label="확인 필요" value={`${stats.overdueCount}개`} tone={stats.overdueCount ? "danger" : ""} />
        <Metric label="임박" value={`${stats.urgentCount}개`} tone={stats.urgentCount ? "warning" : ""} />
        <Metric label="오늘 후카" value={`${store.todayHookahCount ?? "-"}개`} />
      </div>
      <div className="reservation-line">
        <span>{stats.isFull ? "가장 빠른 예상 가능 시간" : "예약 안내"}</span>
        <strong>{stats.isFull ? `${stats.earliestTableName} · ${formatClock(stats.earliestAvailableAt)}` : "현재 빈 테이블 있음"}</strong>
      </div>
    </button>
  );
}

function Metric({ label, value, tone = "" }) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StoreList({ stores, tablesByStore, timersByStore, now, onSelect, usingDemo }) {
  const summary = stores.reduce(
    (acc, store) => {
      const tables = tablesByStore[store.id] || [];
      const timers = timersByStore[store.id] || [];
      const stats = buildStoreStats(store, tables, timers, now);
      acc.active += stats.activeTimerCount;
      acc.overdue += stats.overdueCount;
      acc.urgent += stats.urgentCount;
      acc.refill += stats.refillCount;
      return acc;
    },
    { active: 0, overdue: 0, urgent: 0, refill: 0 }
  );

  return (
    <>
      <Header usingDemo={usingDemo} />
      <section className="summary-grid">
        <Metric label="전체 진행 중" value={`${summary.active}개`} />
        <Metric label="확인 필요" value={`${summary.overdue}개`} tone={summary.overdue ? "danger" : ""} />
        <Metric label="1분 이하 임박" value={`${summary.urgent}개`} tone={summary.urgent ? "warning" : ""} />
        <Metric label="후카 추가 추천" value={`${summary.refill}개`} tone={summary.refill ? "success" : ""} />
      </section>
      <section className="store-list">
        {stores.length === 0 && !usingDemo ? (
          <div className="empty-state">메인기기로 지정된 지점이 없습니다.</div>
        ) : (
          sortByName(stores).map((store) => (
            <StoreCard
              key={store.id}
              store={store}
              tables={tablesByStore[store.id] || []}
              timers={timersByStore[store.id] || []}
              now={now}
              onSelect={() => onSelect(store.id)}
            />
          ))
        )}
      </section>
    </>
  );
}

function StoreDetail({ store, now, onBack }) {
  const { tables, timers, error } = useStoreDetail(store?.id);
  const stats = buildStoreStats(store, tables, timers, now);
  const timerByTable = new Map(stats.enrichedTimers.map((timer) => [timer.tableId, timer]));
  const layoutWidth = Number(store.layoutWidth || Math.max(...tables.map((table) => Number(table.x || 0) + 32), 140));
  const layoutHeight = Number(store.layoutHeight || Math.max(...tables.map((table) => Number(table.y || 0) + 34), 160));
  const sortedTimers = [...stats.enrichedTimers].sort((a, b) => {
    const rank = { overdue: 0, urgent: 1, refill: 2, normal: 3 };
    return (rank[a.statusComputed] ?? 9) - (rank[b.statusComputed] ?? 9) || (toMillis(a.nextTaskAt) || 0) - (toMillis(b.nextTaskAt) || 0);
  });

  return (
    <>
      <header className="detail-header">
        <button type="button" className="back-button" onClick={onBack}>← 지점 목록</button>
        <div>
          <p className="eyebrow">Store Detail</p>
          <h1>{store.name || store.id}</h1>
          <p className="sync">마지막 동기화 {formatLastSeen(storeSyncTime(store), now)}</p>
        </div>
      </header>
      {error && <div className="notice error">{error}</div>}
      <section className={stats.isFull ? "reservation-panel full" : "reservation-panel"}>
        <div>
          <p className="eyebrow">예약 안내용 예상</p>
          <h2>{stats.isFull ? "현재 만석입니다" : `빈 테이블 ${stats.emptyTableCount}개`}</h2>
          <p>{stats.isFull ? "가장 빨리 비는 테이블 기준으로 안내하면 됩니다." : "바로 안내 가능한 테이블이 있습니다."}</p>
        </div>
        <div className="reservation-time">
          <span>{stats.isFull ? stats.earliestTableName : "즉시 가능"}</span>
          <strong>{stats.isFull ? formatClock(stats.earliestAvailableAt) : "NOW"}</strong>
        </div>
      </section>
      <section className="detail-stats-grid">
        <Metric label="진행 중" value={`${stats.activeTimerCount}개`} />
        <Metric label="확인 필요" value={`${stats.overdueCount}개`} tone={stats.overdueCount ? "danger" : ""} />
        <Metric label="임박" value={`${stats.urgentCount}개`} tone={stats.urgentCount ? "warning" : ""} />
        <Metric label="후카 추가" value={`${stats.refillCount}개`} tone={stats.refillCount ? "success" : ""} />
      </section>
      <section className="layout-section">
        <div className="section-title">
          <h2>테이블 배치도</h2>
          <span>{tables.length}개 테이블</span>
        </div>
        <div className="layout-scroll">
          <div className="layout-board" style={{ aspectRatio: `${layoutWidth} / ${layoutHeight}` }}>
            {tables.map((table) => {
              const timer = timerByTable.get(table.id);
              const status = computeTimerStatus(timer, now);
              const left = `${(Number(table.x || 0) / layoutWidth) * 100}%`;
              const top = `${(Number(table.y || 0) / layoutHeight) * 100}%`;
              return (
                <div key={table.id} className={`table-card ${statusClass(status)}`} style={{ left, top }}>
                  <div className="table-name">{table.name}</div>
                  <div className="table-status">{statusText(status)}</div>
                  {timer ? (
                    <>
                      <div className="table-stage">{timer.currentStageLabel || "진행 중"}</div>
                      <div className="table-time">{formatRelative(timer.nextTaskAt, now)}</div>
                      <div className="table-end">예상 {formatClock(timer.estimatedEndAtComputed)}</div>
                    </>
                  ) : (
                    <div className="table-empty-text">예약 가능</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>
      <section className="timer-list-section">
        <div className="section-title">
          <h2>진행 중 타이머</h2>
          <span>예약 문의 참고용</span>
        </div>
        <div className="timer-list">
          {sortedTimers.length === 0 ? (
            <div className="empty-state">진행 중인 후카가 없습니다.</div>
          ) : (
            sortedTimers.map((timer) => (
              <article key={timer.id} className={`timer-row ${statusClass(timer.statusComputed)}`}>
                <div>
                  <strong>{timer.tableName || timer.tableId}</strong>
                  <p>{statusText(timer.statusComputed)} · {timer.currentStageLabel || "진행 중"}</p>
                </div>
                <div className="timer-row-times">
                  <span>후카 나감 {formatClock(timer.servedAt || timer.scheduledServedAt)}</span>
                  <span>다음 단계 {formatRelative(timer.nextTaskAt, now)}</span>
                  <span>예상 종료 {formatClock(timer.estimatedEndAtComputed)}</span>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </>
  );
}

export default function App() {
  const { stores, loading, error, usingDemo } = useStores();
  const { tablesByStore, timersByStore, error: overviewError } = useStoreCollections(stores);
  const [selectedStoreId, setSelectedStoreId] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const selectedStore = useMemo(() => stores.find((store) => store.id === selectedStoreId), [stores, selectedStoreId]);

  return (
    <main className="app-shell">
      {error && <div className="notice error">{error}</div>}
      {overviewError && <div className="notice error">{overviewError}</div>}
      {loading && <div className="notice">Firestore 데이터를 불러오는 중...</div>}
      {usingDemo && (
        <div className="notice demo">
          Firebase 환경변수가 아직 없어 데모 데이터로 표시 중입니다. 배포 전 Vercel 환경변수에 Firebase 설정을 넣어주세요.
        </div>
      )}
      {selectedStore ? (
        <StoreDetail store={selectedStore} now={now} onBack={() => setSelectedStoreId(null)} />
      ) : (
        <StoreList stores={stores} tablesByStore={tablesByStore} timersByStore={timersByStore} now={now} onSelect={setSelectedStoreId} usingDemo={usingDemo} />
      )}
    </main>
  );
}

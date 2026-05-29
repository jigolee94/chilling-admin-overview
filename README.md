# Chilling Admin Overview

관리자 전용 Chilling Timer Overview 앱입니다. 기존 지점용 `chilling-hookah-timer` 앱과 별도로 운영되며, Firebase Firestore를 읽어서 모든 지점의 후카 진행도를 실시간으로 보여줍니다.

## 주요 기능

- 첫 화면: 전체 지점 카드 목록
- 지점 상세: 기존 지점용 앱처럼 `layoutWidth`, `layoutHeight`, `tables.x/y` 좌표 기반 테이블 배치도 표시
- 테이블 상태 표시
  - 비어있음
  - 정상 진행 중
  - 1분 이하 임박
  - 확인 필요
  - 후카 추가 추천
- 각 테이블 정보
  - 현재 단계
  - 후카 나간 시간
  - 손님 후카 종료 예상 시간
  - 다음 단계까지 남은 시간
- 만석 지점 예약 안내용 정보
  - 가장 빨리 비는 테이블
  - 예상 가능 시간
- Firestore `onSnapshot` 실시간 구독
- Firebase 환경변수가 없을 때는 데모 데이터로 화면 확인 가능

## 설치 및 실행

```bash
npm install
npm run dev
```

빌드:

```bash
npm run build
```

Vercel 설정:

```text
Framework Preset: Vite
Build Command: npm run build
Output Directory: dist
```

## Firebase 환경변수

`.env.example`을 복사해서 `.env.local`을 만들고 값을 채워주세요.

```bash
cp .env.example .env.local
```

필요한 값:

```text
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

실제 키는 코드에 하드코딩하지 않고 Vercel Project Settings → Environment Variables에 등록하세요.

## Firestore 데이터 구조

관리자 앱은 아래 구조를 읽는다고 가정합니다.

```text
stores/{storeId}
stores/{storeId}/tables/{tableId}
stores/{storeId}/timers/{timerId}
```

### `stores/{storeId}` 예시

```js
{
  name: "칠링 성수점",
  isOpen: true,
  layoutWidth: 140,
  layoutHeight: 220,
  activeTimerCount: 8,
  urgentCount: 2,
  overdueCount: 1,
  refillReminderCount: 1,
  todayHookahCount: 32,
  averageScore: 4.6,
  lastSeenAt: Timestamp,
  updatedAt: Timestamp
}
```

### `stores/{storeId}/tables/{tableId}` 예시

```js
{
  name: "테이블 1",
  x: 5.14,
  y: 9.65,
  activeTimerId: "timer_abc123",
  status: "active",
  updatedAt: Timestamp
}
```

### `stores/{storeId}/timers/{timerId}` 예시

```js
{
  tableId: "table-1",
  tableName: "테이블 1",

  status: "normal",
  // normal | urgent | overdue | refill | completed

  currentStageKey: "maintenanceTime",
  currentStageLabel: "숯 털기/1개 올림",

  startedAt: Timestamp,
  servedAt: Timestamp,
  scheduledServedAt: Timestamp,

  nextTaskAt: Timestamp,
  estimatedEndAt: Timestamp,

  needsConfirm: false,
  isUrgent: false,
  isOverdue: false,
  needsRefill: false,

  updatedAt: Timestamp
}
```

## 예상 종료 시간 계산

손님 후카 종료 예상 시간은 다음 기준입니다.

```text
servedAt + 90분
```

`servedAt`이 아직 없으면:

```text
scheduledServedAt + 90분
```

관리자 앱은 `estimatedEndAt`이 있으면 우선 사용하고, 없으면 위 기준으로 클라이언트에서 계산합니다.

## 중요한 동기화 원칙

Firestore에 `remainingSeconds`를 매초 저장하지 마세요.

대신 저장할 값:

```text
nextTaskAt
servedAt
scheduledServedAt
estimatedEndAt
status
updatedAt
```

관리자 앱은 `nextTaskAt`과 `estimatedEndAt`을 기준으로 남은 시간을 클라이언트에서 계산합니다. 이렇게 해야 Firestore 쓰기 비용과 동기화 충돌이 줄어듭니다.

## 기존 지점용 앱에 추가할 sync 함수 설계

기존 `chilling-hookah-timer` 앱의 로컬 타이머 기능은 그대로 유지하고, Firestore 동기화는 실패해도 앱 동작을 막지 않는 방식으로 붙이는 것을 추천합니다.

예시 파일 구조:

```text
src/firebase.js
src/firestoreSync.js
```

### `src/firebase.js` 예시

```js
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId
);

export const app = firebaseConfigured ? initializeApp(firebaseConfig) : null;
export const db = app ? getFirestore(app) : null;
```

### `src/firestoreSync.js` 예시

```js
import { doc, setDoc, deleteDoc, serverTimestamp, writeBatch } from "firebase/firestore";
import { db, firebaseConfigured } from "./firebase";

const CUSTOMER_SESSION_MINUTES = 90;

function addMinutes(timestamp, minutes) {
  if (!timestamp) return null;
  return new Date(Number(timestamp) + minutes * 60 * 1000);
}

export async function syncStoreSnapshot({ storeId, storeName, settings, tables, rows, getNextTask, computeSchedule, scoreStats }) {
  if (!firebaseConfigured || !db || !storeId) return;

  try {
    const batch = writeBatch(db);
    const activeRows = rows.filter((row) => !row.completed);
    const now = Date.now();

    const activeTimerByTable = new Map(activeRows.map((row) => [row.tableId, row]));
    const urgentCount = activeRows.filter((row) => {
      const schedule = computeSchedule(row, settings);
      const nextTask = getNextTask(row, schedule, settings);
      const next = nextTask?.time?.getTime?.();
      return next && next > now && next - now <= 60_000;
    }).length;

    const overdueCount = activeRows.filter((row) => {
      const schedule = computeSchedule(row, settings);
      const nextTask = getNextTask(row, schedule, settings);
      const next = nextTask?.time?.getTime?.();
      return next && next <= now;
    }).length;

    batch.set(doc(db, "stores", storeId), {
      name: storeName,
      isOpen: true,
      layoutWidth: settings.layoutWidth,
      layoutHeight: settings.layoutHeight,
      activeTimerCount: activeRows.length,
      urgentCount,
      overdueCount,
      refillReminderCount: 0,
      todayHookahCount: rows.length,
      averageScore: scoreStats?.average || 0,
      lastSeenAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });

    tables.forEach((table) => {
      const activeRow = activeTimerByTable.get(table.id);
      batch.set(doc(db, "stores", storeId, "tables", table.id), {
        name: table.name,
        x: table.x,
        y: table.y,
        activeTimerId: activeRow?.id || null,
        status: activeRow ? "active" : "empty",
        updatedAt: serverTimestamp(),
      }, { merge: true });
    });

    activeRows.forEach((row) => {
      const schedule = computeSchedule(row, settings);
      const nextTask = getNextTask(row, schedule, settings);
      const servedAt = row.acknowledged?.served || schedule.served?.getTime?.() || null;
      const scheduledServedAt = schedule.served?.getTime?.() || null;
      const estimatedEndAt = addMinutes(servedAt || scheduledServedAt, CUSTOMER_SESSION_MINUTES);
      const nextTaskAt = nextTask?.time?.getTime?.() || null;
      const status = nextTaskAt && nextTaskAt <= Date.now()
        ? "overdue"
        : nextTaskAt && nextTaskAt - Date.now() <= 60_000
          ? "urgent"
          : "normal";

      batch.set(doc(db, "stores", storeId, "timers", row.id), {
        tableId: row.tableId,
        tableName: tables.find((table) => table.id === row.tableId)?.name || row.tableId,
        status,
        currentStageKey: nextTask?.key || "completed",
        currentStageLabel: nextTask?.label || "완료",
        startedAt: row.startTimestamp ? new Date(row.startTimestamp) : null,
        servedAt: servedAt ? new Date(servedAt) : null,
        scheduledServedAt: scheduledServedAt ? new Date(scheduledServedAt) : null,
        nextTaskAt: nextTaskAt ? new Date(nextTaskAt) : null,
        estimatedEndAt,
        needsConfirm: status === "overdue",
        isUrgent: status === "urgent",
        isOverdue: status === "overdue",
        needsRefill: false,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    });

    await batch.commit();
  } catch (error) {
    console.warn("Firestore sync failed. Local timer app will keep running.", error);
  }
}

export async function deleteSyncedTimer(storeId, timerId) {
  if (!firebaseConfigured || !db || !storeId || !timerId) return;
  try {
    await deleteDoc(doc(db, "stores", storeId, "timers", timerId));
  } catch (error) {
    console.warn("Firestore timer delete failed", error);
  }
}
```

## 지점용 앱에서 sync 호출 타이밍

매초 호출하지 말고 아래 순간에만 호출하세요.

```text
후카 추가
단계 확인
타이머 삭제
자리이동
프리셋 변경
영업 시작
퇴근
후카 추가 추천 알림 발생
1분 이하 임박 상태 진입
시간 종료 상태 진입
```

## Firestore 보안 규칙 초안

초기 개발용으로만 사용하세요. 운영 전에는 Firebase Auth와 role 기반 권한을 붙이는 것을 권장합니다.

```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /stores/{storeId} {
      allow read: if true;
      allow write: if request.auth != null;

      match /tables/{tableId} {
        allow read: if true;
        allow write: if request.auth != null;
      }

      match /timers/{timerId} {
        allow read: if true;
        allow write: if request.auth != null;
      }
    }
  }
}
```

운영용 권장:

```text
관리자 앱: 모든 stores 읽기 가능
지점용 앱: 자기 storeId만 쓰기 가능
```

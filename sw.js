// Service Worker - 后台持续追踪
const API_BASE = 'https://kid-tracker-api.shuzurenceshi.workers.dev';
const DEVICE_ID = 'kid-1';
const TRACK_INTERVAL = 10000; // 10秒上报一次

let watchId = null;

// 监听消息
self.addEventListener('message', (event) => {
  if (event.data === 'START_TRACKING') {
    startTracking();
  } else if (event.data === 'STOP_TRACKING') {
    stopTracking();
  }
});

// 定时器触发
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'location-sync') {
    event.waitUntil(reportLocation());
  }
});

// 后台获取位置（有限制）
async function reportLocation() {
  // Service Worker 无法直接访问 geolocation
  // 但可以通过 Background Fetch API 或 Periodic Background Sync
  // 这里只是占位，实际依赖页面端的持续上报
  console.log('[SW] Periodic sync triggered');
}

function startTracking() {
  console.log('[SW] Tracking started');
}

function stopTracking() {
  console.log('[SW] Tracking stopped');
}

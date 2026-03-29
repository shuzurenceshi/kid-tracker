/**
 * Kid Tracker - 孩子实时位置追踪器
 * Cloudflare Worker 后端 (KV版本)
 */

const FEISHU_WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/YOUR_WEBHOOK_URL';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// 计算两点间距离（米）
function getDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// 发送飞书告警
async function sendFeishuAlert(message) {
  try {
    await fetch(FEISHU_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: message } })
    });
  } catch (e) {
    console.error('飞书通知失败:', e);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // ==================== 上报位置 ====================
      if (path === '/api/location' && request.method === 'POST') {
        const body = await request.json();
        const { device_id, latitude, longitude, accuracy, battery } = body;

        if (!device_id || !latitude || !longitude) {
          return new Response(JSON.stringify({ error: '缺少必要参数' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const timestamp = Date.now();
        const locationData = { device_id, latitude, longitude, accuracy, battery, timestamp };
        
        // 保存最新位置
        await env.KV.put(`location:${device_id}:latest`, JSON.stringify(locationData));
        
        // 保存历史轨迹（保留24小时）
        const historyKey = `location:${device_id}:history`;
        let history = JSON.parse(await env.KV.get(historyKey) || '[]');
        history.push(locationData);
        // 只保留24小时内的数据（每10秒一条 = 8640条）
        if (history.length > 8640) history = history.slice(-8640);
        await env.KV.put(historyKey, JSON.stringify(history));

        // 检查电子围栏
        const geofences = JSON.parse(await env.KV.get(`geofence:${device_id}`) || '[]');
        for (const fence of geofences) {
          if (!fence.enabled) continue;
          const distance = getDistance(latitude, longitude, fence.center_lat, fence.center_lng);
          if (distance > fence.radius) {
            ctx.waitUntil(sendFeishuAlert(
              `🚨 电子围栏告警\n孩子已离开「${fence.name}」围栏！\n` +
              `距离中心: ${Math.round(distance)}米\n` +
              `时间: ${new Date().toLocaleString('zh-CN')}`
            ));
          }
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // ==================== 获取实时位置 ====================
      if (path === '/api/location/latest' && request.method === 'GET') {
        const device_id = url.searchParams.get('device_id') || 'kid-1';
        const data = await env.KV.get(`location:${device_id}:latest`);
        return new Response(data || '{}', {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // ==================== 获取历史轨迹 ====================
      if (path === '/api/location/history' && request.method === 'GET') {
        const device_id = url.searchParams.get('device_id') || 'kid-1';
        const hours = parseInt(url.searchParams.get('hours') || '24');
        
        const historyStr = await env.KV.get(`location:${device_id}:history`);
        let history = JSON.parse(historyStr || '[]');
        
        // 过滤指定时间范围
        const cutoff = Date.now() - hours * 3600 * 1000;
        history = history.filter(p => p.timestamp > cutoff);
        
        return new Response(JSON.stringify(history), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // ==================== 电子围栏管理 ====================
      if (path === '/api/geofence' && request.method === 'POST') {
        const body = await request.json();
        const { device_id, name, center_lat, center_lng, radius } = body;
        
        const key = `geofence:${device_id || 'kid-1'}`;
        let fences = JSON.parse(await env.KV.get(key) || '[]');
        
        const newFence = {
          id: Date.now(),
          name: name || '围栏',
          center_lat,
          center_lng,
          radius: radius || 500,
          enabled: true
        };
        fences.push(newFence);
        await env.KV.put(key, JSON.stringify(fences));
        
        return new Response(JSON.stringify({ success: true, id: newFence.id }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      if (path === '/api/geofence' && request.method === 'GET') {
        const device_id = url.searchParams.get('device_id') || 'kid-1';
        const fences = await env.KV.get(`geofence:${device_id}`);
        return new Response(fences || '[]', {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      if (path.match(/^\/api\/geofence\/\d+/) && request.method === 'DELETE') {
        const fenceId = parseInt(path.split('/')[3]);
        const device_id = url.searchParams.get('device_id') || 'kid-1';
        
        const key = `geofence:${device_id}`;
        let fences = JSON.parse(await env.KV.get(key) || '[]');
        fences = fences.filter(f => f.id !== fenceId);
        await env.KV.put(key, JSON.stringify(fences));
        
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // ==================== 前端页面 ====================
      if (path === '/' || path === '/index.html') {
        return new Response(getIndexHTML(), {
          headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      if (path === '/kid.html') {
        return new Response(getKidHTML(), {
          headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      return new Response('Not Found', { status: 404 });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};

// 家长端页面
function getIndexHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>孩子位置追踪 - 家长端</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; }
    #map { width: 100%; height: 60vh; }
    .panel { padding: 16px; background: white; }
    .btn { padding: 10px 16px; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; margin: 4px; }
    .btn-primary { background: #1677ff; color: white; }
    .btn-danger { background: #ff4d4f; color: white; }
    .btn-secondary { background: #f0f0f0; color: #333; }
    .info { padding: 12px 0; color: #666; font-size: 14px; border-bottom: 1px solid #eee; }
    .status { padding: 4px 8px; border-radius: 4px; font-size: 12px; }
    .status.online { background: #e6f7e6; color: #52c41a; }
    .status.offline { background: #fff2f0; color: #ff4d4f; }
    #addGeofence { display: none; padding: 16px; background: #f9f9f9; border-radius: 8px; margin-top: 12px; }
    #addGeofence input { padding: 8px 12px; margin: 6px 0; border: 1px solid #ddd; border-radius: 6px; width: 100%; }
    #addGeofence h4 { margin-bottom: 8px; }
    .geofence-list { margin-top: 12px; }
    .geofence-item { padding: 10px 12px; background: #fafafa; border-radius: 8px; margin: 6px 0; display: flex; justify-content: space-between; align-items: center; }
  </style>
</head>
<body>
  <div id="map"></div>
  <div class="panel">
    <div class="info">
      <span>状态: <span id="status" class="status offline">离线</span></span>
      <span style="margin-left: 16px">电量: <span id="battery">--</span>%</span>
      <span style="margin-left: 16px">更新: <span id="updateTime">--</span></span>
    </div>
    <div style="margin-top: 12px">
      <button class="btn btn-primary" onclick="toggleHistory()">📊 历史轨迹</button>
      <button class="btn btn-primary" onclick="toggleGeofencePanel()">🔒 添加围栏</button>
      <button class="btn btn-secondary" onclick="centerToKid()">📍 定位</button>
    </div>
    <div id="addGeofence">
      <h4>添加电子围栏</h4>
      <input type="text" id="fenceName" placeholder="围栏名称（如：学校、家）">
      <input type="number" id="fenceRadius" placeholder="半径（米）" value="500">
      <p style="font-size: 12px; color: #999; margin: 8px 0;">💡 点击地图选择围栏中心点</p>
      <button class="btn btn-primary" onclick="saveGeofence()">保存围栏</button>
      <button class="btn btn-secondary" onclick="toggleGeofencePanel()">取消</button>
    </div>
    <div class="geofence-list" id="geofenceList"></div>
  </div>

  <script>
    const API = '/api';
    const DEVICE_ID = 'kid-1';
    
    let map, marker, polyline;
    let showHistory = false, addingGeofence = false, geofenceCenter = null;
    let geofenceCircles = [], historyData = [];
    
    function init() {
      // 使用 Leaflet (开源免费，无需API Key)
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.onload = () => {
        map = L.map('map').setView([39.90923, 116.397428], 15);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenStreetMap'
        }).addTo(map);
        
        marker = L.marker([39.90923, 116.397428]).addTo(map);
        polyline = L.polyline([], { color: '#1677ff', weight: 4 }).addTo(map);
        
        map.on('click', function(e) {
          if (addingGeofence) {
            geofenceCenter = { lat: e.latlng.lat, lng: e.latlng.lng };
            L.circle([e.latlng.lat, e.latlng.lng], {
              radius: parseInt(document.getElementById('fenceRadius').value) || 500,
              fillColor: '#1677ff',
              fillOpacity: 0.2,
              color: '#1677ff'
            }).addTo(map);
            alert('围栏中心已设置：' + e.latlng.lat.toFixed(4) + ', ' + e.latlng.lng.toFixed(4));
          }
        });
        
        setInterval(fetchLocation, 5000);
        fetchLocation();
        fetchGeofences();
      };
      document.head.appendChild(script);
      
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }
    
    async function fetchLocation() {
      try {
        const res = await fetch(API + '/location/latest?device_id=' + DEVICE_ID);
        const data = await res.json();
        
        if (data.latitude) {
          marker.setLatLng([data.latitude, data.longitude]);
          
          const elapsed = (Date.now() - data.timestamp) / 1000;
          const isOnline = elapsed < 60;
          
          document.getElementById('status').textContent = isOnline ? '在线' : '离线';
          document.getElementById('status').className = 'status ' + (isOnline ? 'online' : 'offline');
          document.getElementById('battery').textContent = data.battery || '--';
          document.getElementById('updateTime').textContent = new Date(data.timestamp).toLocaleTimeString();
        }
      } catch (e) {
        console.error('获取位置失败:', e);
      }
    }
    
    function centerToKid() {
      fetchLocation().then(() => {
        const pos = marker.getLatLng();
        map.setView(pos, 16);
      });
    }
    
    async function toggleHistory() {
      showHistory = !showHistory;
      
      if (showHistory) {
        const res = await fetch(API + '/location/history?device_id=' + DEVICE_ID + '&hours=24');
        historyData = await res.json();
        
        if (historyData.length > 0) {
          const path = historyData.map(p => [p.latitude, p.longitude]);
          polyline.setLatLngs(path);
          map.fitBounds(polyline.getBounds());
        } else {
          alert('暂无历史轨迹数据');
        }
      } else {
        polyline.setLatLngs([]);
      }
    }
    
    function toggleGeofencePanel() {
      const panel = document.getElementById('addGeofence');
      addingGeofence = !addingGeofence;
      panel.style.display = addingGeofence ? 'block' : 'none';
      if (addingGeofence) {
        alert('请在地图上点击选择围栏中心点');
      }
    }
    
    async function saveGeofence() {
      if (!geofenceCenter) {
        alert('请先在地图上点击选择中心点');
        return;
      }
      
      const name = document.getElementById('fenceName').value || '围栏';
      const radius = parseInt(document.getElementById('fenceRadius').value) || 500;
      
      await fetch(API + '/geofence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: DEVICE_ID,
          name: name,
          center_lat: geofenceCenter.lat,
          center_lng: geofenceCenter.lng,
          radius: radius
        })
      });
      
      alert('围栏「' + name + '」已添加！');
      toggleGeofencePanel();
      geofenceCenter = null;
      fetchGeofences();
    }
    
    async function fetchGeofences() {
      const res = await fetch(API + '/geofence?device_id=' + DEVICE_ID);
      const fences = await res.json();
      
      geofenceCircles.forEach(c => c.remove());
      geofenceCircles = [];
      
      const list = document.getElementById('geofenceList');
      list.innerHTML = '';
      
      fences.forEach(f => {
        const circle = L.circle([f.center_lat, f.center_lng], {
          radius: f.radius,
          fillColor: '#ff4d4f',
          fillOpacity: 0.15,
          color: '#ff4d4f',
          weight: 2
        }).addTo(map);
        geofenceCircles.push(circle);
        
        const item = document.createElement('div');
        item.className = 'geofence-item';
        item.innerHTML = '<span>' + f.name + ' (半径 ' + f.radius + '米)</span>' +
          '<button class="btn btn-danger" onclick="deleteGeofence(' + f.id + ')">删除</button>';
        list.appendChild(item);
      });
    }
    
    async function deleteGeofence(id) {
      await fetch(API + '/geofence/' + id + '?device_id=' + DEVICE_ID, { method: 'DELETE' });
      fetchGeofences();
    }
    
    init();
  </script>
</body>
</html>`;
}

// 孩子端页面（上报位置）
function getKidHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>位置守护</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: white; padding: 40px 30px; border-radius: 20px; max-width: 350px; width: 90%; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.2); }
    h1 { font-size: 28px; margin-bottom: 8px; }
    p { color: #666; margin: 8px 0 20px; }
    .status { padding: 12px 24px; border-radius: 24px; display: inline-block; font-size: 16px; font-weight: 500; }
    .status.active { background: #e6f7e6; color: #52c41a; }
    .status.error { background: #fff2f0; color: #ff4d4f; }
    .status.pending { background: #e6f7ff; color: #1890ff; }
    #info { margin-top: 20px; font-size: 13px; color: #999; line-height: 1.6; }
    .icon { font-size: 48px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">📍</div>
    <h1>位置守护中</h1>
    <p>爸爸/妈妈可以看到你的位置</p>
    <div id="status" class="status pending">正在定位...</div>
    <div id="info"></div>
  </div>

  <script>
    const API = '/api';
    const DEVICE_ID = 'kid-1';
    let watchId = null;
    
    function updateStatus(text, type) {
      const el = document.getElementById('status');
      el.textContent = text;
      el.className = 'status ' + type;
    }
    
    async function sendLocation(pos) {
      try {
        const res = await fetch(API + '/location', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_id: DEVICE_ID,
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            battery: null
          })
        });
        
        const data = await res.json();
        updateStatus('守护中 ✅', 'active');
        document.getElementById('info').innerHTML = 
          '位置: ' + pos.coords.latitude.toFixed(4) + ', ' + pos.coords.longitude.toFixed(4) + '<br>' +
          '精度: ' + Math.round(pos.coords.accuracy) + '米<br>' +
          '更新: ' + new Date().toLocaleTimeString();
      } catch (e) {
        updateStatus('上报失败', 'error');
        document.getElementById('info').textContent = e.message;
      }
    }
    
    function startTracking() {
      if (!navigator.geolocation) {
        updateStatus('设备不支持定位', 'error');
        return;
      }
      
      // 持续监听位置变化
      watchId = navigator.geolocation.watchPosition(
        sendLocation,
        (err) => {
          updateStatus('定位失败', 'error');
          document.getElementById('info').textContent = err.message;
        },
        { 
          enableHighAccuracy: true, 
          timeout: 10000,
          maximumAge: 5000
        }
      );
    }
    
    // 页面加载后开始追踪
    startTracking();
    
    // 页面可见时重新启动
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !watchId) {
        startTracking();
      }
    });
  </script>
</body>
</html>`;
}

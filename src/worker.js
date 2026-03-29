/**
 * Kid Tracker - 孩子实时位置追踪器
 * Cloudflare Worker 后端
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
  const R = 6371000; // 地球半径（米）
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
      body: JSON.stringify({
        msg_type: 'text',
        content: { text: message }
      })
    });
  } catch (e) {
    console.error('飞书通知失败:', e);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
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

        // 保存位置
        await env.DB.prepare(
          'INSERT INTO locations (device_id, latitude, longitude, accuracy, battery) VALUES (?, ?, ?, ?, ?)'
        ).bind(device_id, latitude, longitude, accuracy || null, battery || null).run();

        // 检查电子围栏
        const geofences = await env.DB.prepare(
          'SELECT * FROM geofences WHERE device_id = ? AND enabled = 1'
        ).bind(device_id).all();

        for (const fence of geofences.results) {
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
        
        const result = await env.DB.prepare(
          'SELECT * FROM locations WHERE device_id = ? ORDER BY timestamp DESC LIMIT 1'
        ).bind(device_id).first();

        return new Response(JSON.stringify(result || {}), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // ==================== 获取历史轨迹 ====================
      if (path === '/api/location/history' && request.method === 'GET') {
        const device_id = url.searchParams.get('device_id') || 'kid-1';
        const hours = parseInt(url.searchParams.get('hours') || '24');
        
        const results = await env.DB.prepare(
          `SELECT * FROM locations 
           WHERE device_id = ? AND timestamp > datetime('now', '-' || ? || ' hours')
           ORDER BY timestamp ASC`
        ).bind(device_id, hours).all();

        return new Response(JSON.stringify(results.results), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // ==================== 电子围栏管理 ====================
      if (path === '/api/geofence' && request.method === 'POST') {
        const body = await request.json();
        const { device_id, name, center_lat, center_lng, radius } = body;

        const result = await env.DB.prepare(
          'INSERT INTO geofences (device_id, name, center_lat, center_lng, radius) VALUES (?, ?, ?, ?, ?)'
        ).bind(device_id, name, center_lat, center_lng, radius).run();

        return new Response(JSON.stringify({ success: true, id: result.meta.last_row_id }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      if (path === '/api/geofence' && request.method === 'GET') {
        const device_id = url.searchParams.get('device_id') || 'kid-1';
        
        const results = await env.DB.prepare(
          'SELECT * FROM geofences WHERE device_id = ?'
        ).bind(device_id).all();

        return new Response(JSON.stringify(results.results), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      if (path.match(/^\/api\/geofence\/\d+$/) && request.method === 'DELETE') {
        const id = path.split('/')[3];
        
        await env.DB.prepare('DELETE FROM geofences WHERE id = ?').bind(id).run();

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
    #map { width: 100%; height: 70vh; }
    .panel { padding: 16px; background: white; border-top: 1px solid #eee; }
    .btn { padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; margin: 4px; }
    .btn-primary { background: #1677ff; color: white; }
    .btn-danger { background: #ff4d4f; color: white; }
    .info { margin: 10px 0; color: #666; }
    .geofence-list { margin-top: 10px; }
    .geofence-item { padding: 10px; background: #fafafa; border-radius: 8px; margin: 8px 0; display: flex; justify-content: space-between; align-items: center; }
    .status { padding: 4px 8px; border-radius: 4px; font-size: 12px; }
    .status.online { background: #e6f7e6; color: #52c41a; }
    .status.offline { background: #fff2f0; color: #ff4d4f; }
    #addGeofence { display: none; padding: 16px; background: #f0f0f0; border-radius: 8px; margin-top: 10px; }
    #addGeofence input { padding: 8px; margin: 4px 0; border: 1px solid #ddd; border-radius: 4px; width: 100%; }
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
    <button class="btn btn-primary" onclick="toggleHistory()">📊 历史轨迹</button>
    <button class="btn btn-primary" onclick="toggleGeofencePanel()">🔒 电子围栏</button>
    
    <div id="addGeofence">
      <h4>添加电子围栏</h4>
      <input type="text" id="fenceName" placeholder="围栏名称（如：学校）">
      <input type="number" id="fenceRadius" placeholder="半径（米）" value="500">
      <p style="font-size: 12px; color: #999; margin: 8px 0;">点击地图选择围栏中心点</p>
      <button class="btn btn-primary" onclick="saveGeofence()">保存围栏</button>
      <button class="btn" onclick="toggleGeofencePanel()">取消</button>
    </div>
    
    <div class="geofence-list" id="geofenceList"></div>
  </div>

  <script src="https://webapi.amap.com/maps?v=2.0&key=YOUR_AMAP_KEY"></script>
  <script>
    const API = '/api';
    const DEVICE_ID = 'kid-1';
    
    let map, marker, polyline, historyData = [];
    let showHistory = false, addingGeofence = false, geofenceCenter = null;
    let geofenceCircles = [];
    
    function init() {
      map = new AMap.Map('map', { zoom: 15, center: [116.397428, 39.90923] });
      
      marker = new AMap.Marker({ map: map });
      polyline = new AMap.Polyline({ map: map, strokeColor: '#1677ff', strokeWeight: 4 });
      
      map.on('click', function(e) {
        if (addingGeofence) {
          geofenceCenter = [e.lnglat.lng, e.lnglat.lat];
          new AMap.Circle({ map: map, center: e.lnglat, radius: parseInt(document.getElementById('fenceRadius').value), fillColor: '#1677ff', fillOpacity: 0.2 });
        }
      });
      
      setInterval(fetchLocation, 5000);
      fetchLocation();
      fetchGeofences();
    }
    
    async function fetchLocation() {
      const res = await fetch(API + '/location/latest?device_id=' + DEVICE_ID);
      const data = await res.json();
      
      if (data.latitude) {
        const pos = [data.longitude, data.latitude];
        marker.setPosition(pos);
        map.setCenter(pos);
        
        document.getElementById('status').textContent = '在线';
        document.getElementById('status').className = 'status online';
        document.getElementById('battery').textContent = data.battery || '--';
        document.getElementById('updateTime').textContent = new Date(data.timestamp).toLocaleTimeString();
      }
    }
    
    async function toggleHistory() {
      showHistory = !showHistory;
      
      if (showHistory) {
        const res = await fetch(API + '/location/history?device_id=' + DEVICE_ID + '&hours=24');
        historyData = await res.json();
        
        if (historyData.length > 0) {
          const path = historyData.map(p => [p.longitude, p.latitude]);
          polyline.setPath(path);
          map.setFitView([polyline]);
        }
      } else {
        polyline.setPath([]);
      }
    }
    
    function toggleGeofencePanel() {
      const panel = document.getElementById('addGeofence');
      addingGeofence = !addingGeofence;
      panel.style.display = addingGeofence ? 'block' : 'none';
    }
    
    async function saveGeofence() {
      if (!geofenceCenter) return alert('请先在地图上点击选择中心点');
      
      const name = document.getElementById('fenceName').value || '围栏';
      const radius = parseInt(document.getElementById('fenceRadius').value) || 500;
      
      await fetch(API + '/geofence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: DEVICE_ID,
          name: name,
          center_lat: geofenceCenter[1],
          center_lng: geofenceCenter[0],
          radius: radius
        })
      });
      
      alert('围栏已添加！');
      toggleGeofencePanel();
      fetchGeofences();
    }
    
    async function fetchGeofences() {
      const res = await fetch(API + '/geofence?device_id=' + DEVICE_ID);
      const fences = await res.json();
      
      // 清除旧围栏显示
      geofenceCircles.forEach(c => c.setMap(null));
      geofenceCircles = [];
      
      const list = document.getElementById('geofenceList');
      list.innerHTML = '';
      
      fences.forEach(f => {
        // 地图上显示围栏
        const circle = new AMap.Circle({
          map: map,
          center: [f.center_lng, f.center_lat],
          radius: f.radius,
          fillColor: '#ff4d4f',
          fillOpacity: 0.15,
          strokeColor: '#ff4d4f',
          strokeWeight: 2
        });
        geofenceCircles.push(circle);
        
        // 列表中显示
        const item = document.createElement('div');
        item.className = 'geofence-item';
        item.innerHTML = \`
          <span>\${f.name} (半径 \${f.radius}米)</span>
          <button class="btn btn-danger" onclick="deleteGeofence(\${f.id})">删除</button>
        \`;
        list.appendChild(item);
      });
    }
    
    async function deleteGeofence(id) {
      await fetch(API + '/geofence/' + id, { method: 'DELETE' });
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>位置上报</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 20px; text-align: center; background: #f5f5f5; }
    .card { background: white; padding: 30px; border-radius: 16px; max-width: 400px; margin: 0 auto; }
    h1 { font-size: 24px; margin-bottom: 10px; }
    p { color: #666; margin: 10px 0; }
    .status { padding: 8px 16px; border-radius: 20px; display: inline-block; margin: 10px 0; }
    .status.active { background: #e6f7e6; color: #52c41a; }
    .status.error { background: #fff2f0; color: #ff4d4f; }
    #info { margin-top: 20px; font-size: 14px; color: #999; }
  </style>
</head>
<body>
  <div class="card">
    <h1>📍 位置守护中</h1>
    <p>爸爸/妈妈可以看到你的位置</p>
    <div id="status" class="status active">正在定位...</div>
    <div id="info"></div>
  </div>

  <script>
    const API = '/api';
    const DEVICE_ID = 'kid-1';
    
    function sendLocation() {
      if (!navigator.geolocation) {
        document.getElementById('status').className = 'status error';
        document.getElementById('status').textContent = '设备不支持定位';
        return;
      }
      
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          try {
            const res = await fetch(API + '/location', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                device_id: DEVICE_ID,
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
                accuracy: pos.coords.accuracy,
                battery: (await navigator.getBattery?.())?.level * 100 || null
              })
            });
            
            const data = await res.json();
            document.getElementById('status').textContent = '守护中 ✅';
            document.getElementById('info').innerHTML = \`
              位置: \${pos.coords.latitude.toFixed(4)}, \${pos.coords.longitude.toFixed(4)}<br>
              精度: \${Math.round(pos.coords.accuracy)}米<br>
              更新时间: \${new Date().toLocaleTimeString()}
            \`;
          } catch (e) {
            document.getElementById('status').className = 'status error';
            document.getElementById('status').textContent = '上报失败';
          }
        },
        (err) => {
          document.getElementById('status').className = 'status error';
          document.getElementById('status').textContent = '定位失败: ' + err.message;
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    }
    
    sendLocation();
    setInterval(sendLocation, 10000); // 每10秒上报一次
  </script>
</body>
</html>`;
}

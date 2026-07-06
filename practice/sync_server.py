#!/usr/bin/env python3
"""実践カウンター 同期サーバー（同一Wi-Fi・PC直結）

役割:
  * PWA本体（index.html / js / css …）を配信する静的サーバー
  * 同期API `/api/sync`（GET=保存済みデータを返す / POST=マージして保存）

設計:
  * 追加ライブラリ不要（Python標準ライブラリのみ）。`python3 sync_server.py` で起動。
  * スマホはこのサーバーからアプリを開くため /api/sync は同一オリジン＝CORS不要
    （念のためCORSヘッダも付与し、別オリジンから開いても動くようにしてある）。
  * データは profiles / sessions を id 単位で保持し、updatedAt の新しい方を採用
    （Last-Write-Wins）。進行中セッション(active)は端末ローカルのため同期しない。
  * 保存先はこのスクリプトと同じディレクトリの sync_data.json（既存の
    slot_data.sqlite には一切触れない）。
"""

import http.server
import json
import os
import socket
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(HERE, 'sync_data.json')
PORT = int(os.environ.get('SYNC_PORT', '8765'))

_lock = threading.Lock()


def _prof_time(p):
    return p.get('updatedAt') or p.get('createdAt') or 0


def _sess_time(s):
    return s.get('updatedAt') or s.get('closedAt') or s.get('startedAt') or 0


def _load():
    if not os.path.exists(DATA_FILE):
        return {'profiles': [], 'sessions': []}
    try:
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (ValueError, OSError):
        return {'profiles': [], 'sessions': []}
    data.setdefault('profiles', [])
    data.setdefault('sessions', [])
    return data


def _save(data):
    tmp = DATA_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, DATA_FILE)


def _merge(existing, incoming, time_fn):
    """id 単位で新しい方を採用してマージした配列を返す。"""
    by_id = {}
    for item in existing:
        if isinstance(item, dict) and item.get('id') is not None:
            by_id[item['id']] = item
    for item in incoming:
        if not isinstance(item, dict) or item.get('id') is None:
            continue
        cur = by_id.get(item['id'])
        if cur is None or time_fn(item) >= time_fn(cur):
            by_id[item['id']] = item
    return list(by_id.values())


def merge_payload(payload):
    """受信ペイロードを保存済みデータにマージし、マージ後の全データを返す。"""
    with _lock:
        data = _load()
        data['profiles'] = _merge(
            data['profiles'], payload.get('profiles', []) or [], _prof_time)
        data['sessions'] = _merge(
            data['sessions'], payload.get('sessions', []) or [], _sess_time)
        _save(data)
        return data


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)

    # --- ログは簡潔に ---
    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        # sw.js / index.html / manifest は常に再検証させ、更新(バナー)を確実に届ける
        path = self.path.split('?', 1)[0]
        if path in ('/sw.js', '/', '/index.html', '/manifest.json'):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/api/ping':
            return self._send_json({'ok': True})
        if path == '/api/sync':
            return self._send_json(_load())
        return super().do_GET()

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        if path != '/api/sync':
            return self._send_json({'error': 'not found'}, status=404)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            raw = self.rfile.read(length) if length else b'{}'
            payload = json.loads(raw.decode('utf-8') or '{}')
        except (ValueError, OSError) as e:
            return self._send_json({'error': 'bad request: %s' % e}, status=400)
        merged = merge_payload(payload)
        return self._send_json(merged)


def _lan_ip():
    """LAN内でスマホから到達できそうなIPを推定（失敗しても致命的でない）。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return '127.0.0.1'


def main():
    server = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    ip = _lan_ip()
    data = _load()
    print('実践カウンター 同期サーバーを起動しました')
    print('  保存先      : %s' % DATA_FILE)
    print('  現在の保有数: 機種 %d / 記録 %d'
          % (len(data['profiles']), len(data['sessions'])))
    print('  スマホから  : http://%s:%d' % (ip, PORT))
    print('  このPCから  : http://localhost:%d' % PORT)
    print('  停止        : Ctrl+C')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n停止しました')
        server.shutdown()


if __name__ == '__main__':
    main()

import json, urllib.request
d = json.load(open(r'C:\Users\artic\.claude\secrets\services.json'))
c = d['coolify']
tok = c.get('api_token') or c.get('token')
url = c['url']
uuid = 'zewfc6g9dw3c4h88z2jd2o4g'
r = urllib.request.Request(f'{url}/api/v1/applications/{uuid}/logs?lines=3000',
    headers={'Authorization': f'Bearer {tok}'})
data = json.loads(urllib.request.urlopen(r).read().decode())
logs = data.get('logs', '')
import re
# Find latest supervisor state updates
lines = [l for l in logs.split('\n') if 'supervisor' in l.lower() or 'agent]' in l.lower()]
for l in lines[-30:]:
    print(l[:200])

import json, urllib.request
d = json.load(open(r'C:\Users\artic\.claude\secrets\services.json'))
c = d['coolify']
tok = c.get('api_token') or c.get('token')
url = c['url']
uuid = 'zewfc6g9dw3c4h88z2jd2o4g'

r = urllib.request.Request(f'{url}/api/v1/applications/{uuid}/logs?lines=5000',
    headers={'Authorization': f'Bearer {tok}'})
data = json.loads(urllib.request.urlopen(r).read().decode())
logs = data.get('logs', '')
print('TOTAL LEN:', len(logs))
# Look for our specific log
import re
matches = re.findall(r'\[supervisor-dal\][^\n]*', logs)
print(f'supervisor-dal logs: {len(matches)}')
for m in matches[-5:]:
    print(' ', m[:200])
# Check most recent lines
lines = logs.strip().split('\n')
print('--- last 20 lines ---')
for l in lines[-20:]:
    print(l[:200])

import json, urllib.request, urllib.error
d = json.load(open(r'C:\Users\artic\.claude\secrets\services.json'))
c = d['coolify']
tok = c.get('api_token') or c.get('token')
url = c['url']
uuid = 'zewfc6g9dw3c4h88z2jd2o4g'

r = urllib.request.Request(f'{url}/api/v1/applications/{uuid}/logs?lines=500',
    headers={'Authorization': f'Bearer {tok}'})
data = json.loads(urllib.request.urlopen(r).read().decode())
logs = data.get('logs', '')
# Find lines about supervisor/auth/capabilities/migrate
for line in logs.split('\n'):
    low = line.lower()
    if any(k in low for k in ['supervisor', 'auth', 'capab', 'migrate', 'applied', 'agent]', 'error', 'invalid api', 'cannot find', 'failed:']):
        print(line[:300])

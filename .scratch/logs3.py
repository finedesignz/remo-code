import json, urllib.request, urllib.error
d = json.load(open(r'C:\Users\artic\.claude\secrets\services.json'))
c = d['coolify']
tok = c.get('api_token') or c.get('token')
url = c['url']
uuid = 'zewfc6g9dw3c4h88z2jd2o4g'

r = urllib.request.Request(f'{url}/api/v1/applications/{uuid}/logs?lines=2000',
    headers={'Authorization': f'Bearer {tok}'})
data = json.loads(urllib.request.urlopen(r).read().decode())
logs = data.get('logs', '')
lines = logs.split('\n')
# Print first 100 to see startup
print('--- last 100 lines ---')
for line in lines[-200:-100]:
    print(line[:250])

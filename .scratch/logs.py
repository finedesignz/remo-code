import json, urllib.request, urllib.error
d = json.load(open(r'C:\Users\artic\.claude\secrets\services.json'))
c = d['coolify']
tok = c.get('api_token') or c.get('token')
url = c['url']
uuid = 'zewfc6g9dw3c4h88z2jd2o4g'

for path in [f'/applications/{uuid}/logs', f'/resources/{uuid}/logs', f'/applications/{uuid}']:
    r = urllib.request.Request(f'{url}/api/v1{path}',
        headers={'Authorization': f'Bearer {tok}'})
    try:
        data = urllib.request.urlopen(r).read().decode()
        print(f'--- {path} ({len(data)} bytes) ---')
        print(data[:600])
        print()
    except urllib.error.HTTPError as e:
        print(f'--- {path}: HTTP {e.code} ---')

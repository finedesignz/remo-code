import json, urllib.request, urllib.error
d = json.load(open(r'C:\Users\artic\.claude\secrets\services.json'))
c = d['coolify']
tok = c.get('api_token') or c.get('token')
url = c['url']
uuid = 'zewfc6g9dw3c4h88z2jd2o4g'

def req(method, path):
    r = urllib.request.Request(f'{url}/api/v1{path}',
        headers={'Authorization': f'Bearer {tok}'}, method=method)
    try: return json.loads(urllib.request.urlopen(r).read().decode())
    except urllib.error.HTTPError as e: return {'__error': e.code, '__body': e.read().decode()[:300]}

envs = req('GET', f'/applications/{uuid}/envs')
seen = set()
for e in envs:
    k = e.get('key','')
    if k in seen: continue
    seen.add(k)
    if 'DATABASE' in k or 'POSTGRES' in k:
        print(k, '=', e.get('value','')[:80])

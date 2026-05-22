import json, urllib.request, urllib.error, time
d = json.load(open(r'C:\Users\artic\.claude\secrets\services.json'))
c = d['coolify']
tok = c.get('api_token') or c.get('token')
url = c['url']
uuid = 'zewfc6g9dw3c4h88z2jd2o4g'

def req(path):
    r = urllib.request.Request(f'{url}/api/v1{path}',
        headers={'Authorization': f'Bearer {tok}'})
    try: return json.loads(urllib.request.urlopen(r).read().decode())
    except urllib.error.HTTPError as e: return {'__error': e.code, '__body': e.read().decode()[:200]}

res = req(f'/deploy?uuid={uuid}&force=false')
dep_uuid = res['deployments'][0]['deployment_uuid']
print('queued', dep_uuid)
while True:
    s = req(f'/deployments/{dep_uuid}').get('status', '?')
    print(s)
    if s in ('finished', 'failed'): break
    time.sleep(20)

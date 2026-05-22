import json, urllib.request, urllib.error
d = json.load(open(r'C:\Users\artic\.claude\secrets\services.json'))
c = d['coolify']
tok = c.get('api_token') or c.get('token')
url = c['url']
uuid = 'zewfc6g9dw3c4h88z2jd2o4g'

def req(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    r = urllib.request.Request(f'{url}/api/v1{path}',
        headers={'Authorization': f'Bearer {tok}', 'Content-Type': 'application/json'},
        method=method, data=data)
    try: return urllib.request.urlopen(r).read().decode()
    except urllib.error.HTTPError as e: return f'HTTP {e.code}: ' + e.read().decode()[:400]

# Try exec command endpoint
for path in [f'/applications/{uuid}/execute', f'/applications/{uuid}/exec']:
    print(f'--- {path} ---')
    print(req('POST', path, {'command': 'bun --version'}))
    print()

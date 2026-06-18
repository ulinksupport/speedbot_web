import json

key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0Mzk1NWQwOS0wOWYxLTQ5OTktODAyYi1lNzg5YTAxZjNhNGIiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwiaWF0IjoxNzcwMTA1MzU1fQ._QFtujFw0noGqJl9dsMCq_AdY0AJTnzNDqU-CczK7Fo"

import urllib.request

req = urllib.request.Request(
    "https://ulink.app.n8n.cloud/api/v1/workflows/ckmreAYY0MJzp9OL",
    headers={"X-N8N-API-KEY": key}
)
with urllib.request.urlopen(req) as resp:
    wf = json.loads(resp.read())

nodes = wf['nodes']

for node in nodes:
    name = node.get('name', '')
    params = node.get('parameters', {})

    if name == 'Log to Messages':
        fields = params.get('fieldsUi', {}).get('fieldValues', [])
        # Check if conversation_id already exists
        existing_ids = [f['fieldId'] for f in fields]
        if 'conversation_id' not in existing_ids:
            fields.append({
                "fieldId": "conversation_id",
                "fieldValue": "={{ $('Webhook').item.json.body.conversation_id || null }}"
            })
            print('[OK] Log to Messages - added conversation_id field')
        else:
            print('[SKIP] Log to Messages - conversation_id already present')

body = {
    'name': wf['name'],
    'nodes': nodes,
    'connections': wf['connections'],
    'settings': {'executionOrder': 'v1'},
    'staticData': None
}

with open(r'C:\Users\devin\Documents\claude-projects\speedbot_web\n8n\send-template-put.json', 'w', encoding='utf-8') as f:
    json.dump(body, f, ensure_ascii=False)

print('[OK] send-template-put.json written')

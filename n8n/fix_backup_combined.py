import json, uuid

key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0Mzk1NWQwOS0wOWYxLTQ5OTktODAyYi1lNzg5YTAxZjNhNGIiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwiaWF0IjoxNzcwMTA1MzU1fQ._QFtujFw0noGqJl9dsMCq_AdY0AJTnzNDqU-CczK7Fo"

import urllib.request
req = urllib.request.Request(
    "https://ulink.app.n8n.cloud/api/v1/workflows/bQNMSnoCVuDYwi2Z",
    headers={"X-N8N-API-KEY": key}
)
with urllib.request.urlopen(req) as resp:
    wf = json.loads(resp.read())

print("Fetched. Nodes:", len(wf['nodes']))
print("Node names:", [n['name'] for n in wf['nodes']])

nodes = wf['nodes']
conn = wf['connections']

# Strategy:
# Create a folder --> Flatten Convos (new) --> Get All Messages for Combined --> Build Combined Sheet --> Convert Combined to File --> Upload Combined Excel --> Restore Convos (new) --> Get Conversations --> Loop --> per-contact
#
# Flatten Convos: receives all convos from Get Conversations? No.
# Actually simpler:
#   Create a folder --> Get Conversations --> Flatten Convos (collapses N items to 1) --> Get All Messages for Combined --> Build Combined Sheet --> Convert Combined to File --> Upload Combined Excel --> Restore Convos (re-emits convos) --> Loop
#
# Build Combined Sheet: $input.all() = messages; $('Flatten Convos').first().json._convos = conv array

# Remove old problematic nodes: "Get All Convos for Combined"
nodes = [n for n in nodes if n['name'] != 'Get All Convos for Combined']

# Update connection: was "Create a folder" -> "Get All Convos for Combined" -> "Get All Messages for Combined"
# New: "Create a folder" -> "Get Conversations" -> "Flatten Convos" -> "Get All Messages for Combined" -> "Build Combined Sheet" -> "Convert Combined to File" -> "Upload Combined Excel" -> "Restore Convos" -> "Loop"

# Add new nodes
flatten_id = str(uuid.uuid4())
restore_id = str(uuid.uuid4())

new_nodes = [
    {
        "id": flatten_id,
        "name": "Flatten Convos",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [1040, 280],
        "parameters": {
            "jsCode": ("// Collapse all conversations into a single item so the next node runs only once\n"
                       "const allConvos = $input.all().map(c => c.json);\n"
                       "return [{ json: { _convos: allConvos } }];")
        }
    },
    {
        "id": restore_id,
        "name": "Restore Convos for Loop",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [1728, 280],
        "parameters": {
            "jsCode": ("// Re-emit all conversations so Loop can iterate them\n"
                       "const convos = $('Flatten Convos').first().json._convos || [];\n"
                       "return convos.map(c => ({ json: c }));")
        }
    }
]

# Update Build Combined Sheet code to use Flatten Convos reference
for node in nodes:
    if node['name'] == 'Build Combined Sheet':
        node['parameters']['jsCode'] = ("const allMessages = $input.all();\n"
            "const convos = $('Flatten Convos').first().json._convos || [];\n\n"
            "const convoMap = {};\n"
            "for (const c of convos) {\n"
            "  convoMap[String(c.id)] = c;\n"
            "}\n\n"
            "const sorted = [...allMessages].sort((a, b) =>\n"
            "  new Date(a.json.created_at || 0) - new Date(b.json.created_at || 0)\n"
            ");\n\n"
            "return sorted.map(row => {\n"
            "  const msg = row.json;\n"
            "  const convo = convoMap[String(msg.conversation_id)] || {};\n\n"
            "  let senderName = 'Customer';\n"
            "  if (msg.sender === 'outgoing') {\n"
            "    senderName = msg.sender_type === 'human'\n"
            "      ? (msg.agent_name ? 'Human Agent (' + msg.agent_name + ')' : 'Human Agent')\n"
            "      : 'Ulink AI';\n"
            "  }\n\n"
            "  let messageTime = 'Unknown Time';\n"
            "  if (msg.created_at) {\n"
            "    messageTime = new Date(msg.created_at).toLocaleString('en-SG', {\n"
            "      timeZone: 'Asia/Singapore',\n"
            "      day: '2-digit', month: 'short', year: 'numeric',\n"
            "      hour: '2-digit', minute: '2-digit', hour12: true\n"
            "    });\n"
            "  }\n\n"
            "  return {\n"
            "    json: {\n"
            "      'Time (SGT)': messageTime,\n"
            "      'Contact Name': convo.name || '',\n"
            "      'Phone': convo.phone || msg.phone || '',\n"
            "      'Platform': convo.platform || msg.platform || '',\n"
            "      'Sender': senderName,\n"
            "      'Message': msg.message || '',\n"
            "      'Media_URL': msg.media_url || ''\n"
            "    }\n"
            "  };\n"
            "});")
        print('[OK] Build Combined Sheet - updated to use Flatten Convos')

    # Update Get All Messages for Combined position
    if node['name'] == 'Get All Messages for Combined':
        node['position'] = [1264, 280]
        print('[OK] Get All Messages for Combined - position updated')

    # Update Build Combined Sheet position
    if node['name'] == 'Build Combined Sheet':
        node['position'] = [1488, 280]

    # Update Convert Combined to File position
    if node['name'] == 'Convert Combined to File':
        node['position'] = [1712, 280] # was 1280,280

    # Update Upload Combined Excel position
    if node['name'] == 'Upload Combined Excel':
        node['position'] = [1936, 280]

nodes.extend(new_nodes)
print(f'[OK] Added {len(new_nodes)} new nodes. Total: {len(nodes)}')

# Rebuild connections for combined chain:
# Create a folder --> Get Conversations --> Flatten Convos --> Get All Messages for Combined
#   --> Build Combined Sheet --> Convert Combined to File --> Upload Combined Excel
#   --> Restore Convos for Loop --> Loop

# Remove old "Get All Convos for Combined" connection
if 'Get All Convos for Combined' in conn:
    del conn['Get All Convos for Combined']

# Create a folder --> Get Conversations (was before: Get All Convos for Combined)
conn['Create a folder']['main'][0] = [{"node": "Get Conversations", "type": "main", "index": 0}]

# Get Conversations --> Flatten Convos (was: Loop)
conn['Get Conversations']['main'][0] = [{"node": "Flatten Convos", "type": "main", "index": 0}]

# Flatten Convos --> Get All Messages for Combined
conn['Flatten Convos'] = {"main": [[{"node": "Get All Messages for Combined", "type": "main", "index": 0}]]}

# Get All Messages for Combined --> Build Combined Sheet (unchanged)
conn['Get All Messages for Combined'] = {"main": [[{"node": "Build Combined Sheet", "type": "main", "index": 0}]]}

# Build Combined Sheet --> Convert Combined to File (unchanged)
# Convert Combined to File --> Upload Combined Excel (unchanged)

# Upload Combined Excel --> Restore Convos for Loop (was: Get Conversations)
conn['Upload Combined Excel'] = {"main": [[{"node": "Restore Convos for Loop", "type": "main", "index": 0}]]}

# Restore Convos for Loop --> Loop
conn['Restore Convos for Loop'] = {"main": [[{"node": "Loop", "type": "main", "index": 0}]]}

print('[OK] Connections rebuilt')

body = {
    'name': wf['name'],
    'nodes': nodes,
    'connections': conn,
    'settings': {'executionOrder': 'v1'},
    'staticData': None
}

with open(r'C:\Users\devin\Documents\claude-projects\speedbot_web\n8n\backup-all-fix2.json', 'w', encoding='utf-8') as f:
    json.dump(body, f, ensure_ascii=False)

print('[OK] backup-all-fix2.json written, nodes:', len(nodes))

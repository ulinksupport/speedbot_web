import json, uuid

with open(r'C:\Users\devin\Documents\claude-projects\speedbot_web\n8n\backup-all-live.json', 'r', encoding='utf-8-sig') as f:
    wf = json.load(f)

nodes = wf['nodes']

for node in nodes:
    name = node.get('name', '')
    params = node.get('parameters', {})

    if name == 'Create a folder':
        params['name'] = "=Backup_{{ $now.setZone('Asia/Singapore').toFormat('cccc, MMMM dd, yyyy [hh.mm a]') }}"
        print('[OK] Create a folder - SGT')

    if name == 'Create Custom Sub-Folder':
        params['name'] = "={{ $json.name }}_{{ $json.phone }}_{{ $now.setZone('Asia/Singapore').toFormat('yyyy-MM-dd') }}"
        print('[OK] Create Custom Sub-Folder - SGT')

    if name == 'Clean for Excel':
        params['jsCode'] = ('let rows = $input.all();\n\n'
            'if (rows.length === 0 || !rows[0].json.created_at) {\n'
            '  return [{ json: { "Time": "N/A", "Sender": "System", "Message": "No messages in this chat.", "Media_URL": "" } }];\n'
            '}\n\n'
            'rows.sort((a, b) => new Date(a.json.created_at) - new Date(b.json.created_at));\n\n'
            'return rows.map(row => {\n'
            '  let senderName = "Customer";\n'
            '  if (row.json.sender === "outgoing") {\n'
            '    senderName = row.json.sender_type === "human" ? "Human" : "Ulink AI";\n'
            '  }\n\n'
            "  let messageTime = row.json.created_at_sgt || \"Unknown Time\";\n"
            '  if (row.json.created_at) {\n'
            "    messageTime = new Date(row.json.created_at).toLocaleString('en-SG', {\n"
            "      timeZone: 'Asia/Singapore',\n"
            "      day: '2-digit', month: 'short', year: 'numeric',\n"
            "      hour: '2-digit', minute: '2-digit', hour12: true\n"
            '    });\n'
            '  }\n\n'
            '  return {\n'
            '    json: {\n'
            '      "Time": messageTime,\n'
            '      "Sender": senderName,\n'
            "      \"Message\": row.json.message || '',\n"
            "      \"Media_URL\": row.json.media_url || ''\n"
            '    }\n'
            '  };\n'
            '});')
        print('[OK] Clean for Excel - Media_URL added')

    if name == 'Generate TXT':
        params['jsCode'] = ("const excelBinary = $input.item.binary.data;\n\n"
            "const convo = $('Get Conversations').all()[$runIndex].json;\n"
            "const formattedMessages = $('Clean for Excel').all(0, $runIndex);\n\n"
            "let txtString = `Chat Backup for ${convo.name} (${convo.phone})\\n`;\n"
            "txtString += `====================================================\\n\\n`;\n\n"
            "for (const msg of formattedMessages) {\n"
            "    let t = msg.json.Time;\n"
            "    let s = msg.json.Sender;\n"
            "    let m = msg.json.Message || '[No text content]';\n"
            "    const mediaUrl = msg.json.Media_URL;\n"
            "    if (mediaUrl) {\n"
            "      m += `\\n[Media: ${mediaUrl}]`;\n"
            "    }\n"
            "    txtString += `[${t}] ${s}:\\n${m}\\n\\n`;\n"
            "}\n\n"
            "return [{\n"
            "    json: convo,\n"
            "    binary: {\n"
            "        data: excelBinary,\n"
            "        txt_data: {\n"
            "            data: Buffer.from(txtString).toString('base64'),\n"
            "            mimeType: 'text/plain',\n"
            "            fileName: 'chat.txt'\n"
            "        }\n"
            "    }\n"
            "}];")
        print('[OK] Generate TXT - media URL added')

# New nodes for combined Excel
new_nodes = [
    {
        "id": str(uuid.uuid4()),
        "name": "Get All Convos for Combined",
        "type": "n8n-nodes-base.supabase",
        "typeVersion": 1,
        "position": [608, 280],
        "parameters": {"operation": "getAll", "tableId": "conversations", "returnAll": True},
        "credentials": {"supabaseApi": {"id": "2lPnHjR5vHSBIROw", "name": "Supabase account 2"}}
    },
    {
        "id": str(uuid.uuid4()),
        "name": "Get All Messages for Combined",
        "type": "n8n-nodes-base.supabase",
        "typeVersion": 1,
        "position": [832, 280],
        "parameters": {"operation": "getAll", "tableId": "messages", "returnAll": True},
        "credentials": {"supabaseApi": {"id": "2lPnHjR5vHSBIROw", "name": "Supabase account 2"}},
        "alwaysOutputData": True
    },
    {
        "id": str(uuid.uuid4()),
        "name": "Build Combined Sheet",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [1056, 280],
        "parameters": {"jsCode": ("const allMessages = $input.all();\n"
            "const allConvos = $('Get All Convos for Combined').all();\n\n"
            "const convoMap = {};\n"
            "for (const c of allConvos) {\n"
            "  convoMap[String(c.json.id)] = c.json;\n"
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
            "});")}
    },
    {
        "id": str(uuid.uuid4()),
        "name": "Convert Combined to File",
        "type": "n8n-nodes-base.convertToFile",
        "typeVersion": 1.1,
        "position": [1280, 280],
        "parameters": {"operation": "xlsx", "options": {}}
    },
    {
        "id": str(uuid.uuid4()),
        "name": "Upload Combined Excel",
        "type": "n8n-nodes-base.microsoftOneDrive",
        "typeVersion": 1.1,
        "position": [1504, 280],
        "parameters": {
            "fileName": "=All_Chats_Combined_Backup.xlsx",
            "parentId": "={{ $('Create a folder').first().json.id }}",
            "binaryData": True
        },
        "credentials": {"microsoftOneDriveOAuth2Api": {"id": "i0GJUxBxFzFNpXoJ", "name": "Microsoft Drive account"}}
    }
]

nodes.extend(new_nodes)
print(f'[OK] Added {len(new_nodes)} new nodes, total: {len(nodes)}')

conn = wf['connections']
conn['Create a folder']['main'][0] = [{"node": "Get All Convos for Combined", "type": "main", "index": 0}]
conn['Get All Convos for Combined'] = {"main": [[{"node": "Get All Messages for Combined", "type": "main", "index": 0}]]}
conn['Get All Messages for Combined'] = {"main": [[{"node": "Build Combined Sheet", "type": "main", "index": 0}]]}
conn['Build Combined Sheet'] = {"main": [[{"node": "Convert Combined to File", "type": "main", "index": 0}]]}
conn['Convert Combined to File'] = {"main": [[{"node": "Upload Combined Excel", "type": "main", "index": 0}]]}
conn['Upload Combined Excel'] = {"main": [[{"node": "Get Conversations", "type": "main", "index": 0}]]}
print('[OK] Connections updated')

body = {
    'name': wf['name'],
    'nodes': nodes,
    'connections': conn,
    'settings': {'executionOrder': 'v1'},
    'staticData': None
}

with open(r'C:\Users\devin\Documents\claude-projects\speedbot_web\n8n\backup-all-put.json', 'w', encoding='utf-8') as f:
    json.dump(body, f, ensure_ascii=False)

print('[OK] backup-all-put.json written, total nodes:', len(nodes))

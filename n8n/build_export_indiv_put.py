import json, uuid

with open(r'C:\Users\devin\Documents\claude-projects\speedbot_web\n8n\export-individual-live.json', 'r', encoding='utf-8-sig') as f:
    wf = json.load(f)

nodes = wf['nodes']

for node in nodes:
    name = node.get('name', '')
    params = node.get('parameters', {})

    if name == 'Build Text Transcript':
        params['jsCode'] = ("const rows = $input.all();\n\n"
            "const webhookBody = $('Webhook').first().json.body || {};\n\n"
            "const conversationId = webhookBody.conversation_id || 'Unknown';\n"
            "const customerName = webhookBody.name || 'Unknown';\n"
            "const phone = webhookBody.phone || 'Unknown';\n\n"
            "function sanitizeFilename(value, fallback = 'Unknown') {\n"
            "  const cleaned = String(value || fallback)\n"
            "    .trim()\n"
            "    .replace(/[\\/:*?\"<>|]/g, '_')\n"
            "    .replace(/\\s+/g, '_')\n"
            "    .replace(/_+/g, '_')\n"
            "    .replace(/^_+|_+$/g, '');\n"
            "  return cleaned || fallback;\n"
            "}\n\n"
            "rows.sort((a, b) => new Date(a.json.created_at || 0) - new Date(b.json.created_at || 0));\n\n"
            "let transcript = '';\n"
            "transcript += '==================================================\\r\\n';\n"
            "transcript += 'ULINK ASSIST CHAT TRANSCRIPT\\r\\n';\n"
            "transcript += '==================================================\\r\\n';\n"
            "transcript += 'Customer Name : ' + customerName + '\\r\\n';\n"
            "transcript += 'Phone         : ' + phone + '\\r\\n';\n"
            "transcript += 'Conversation  : ' + conversationId + '\\r\\n';\n"
            "transcript += 'Exported At   : ' + new Date().toLocaleString('en-SG', { timeZone: 'Asia/Singapore' }) + '\\r\\n';\n"
            "transcript += '==================================================\\r\\n\\r\\n';\n\n"
            "for (const row of rows) {\n"
            "  const msg = row.json;\n\n"
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
            "  } else if (msg.created_at_sgt) {\n"
            "    messageTime = msg.created_at_sgt;\n"
            "  }\n\n"
            "  let messageText;\n"
            "  if (msg.media_url) {\n"
            "    const mediaLabel = '[' + (msg.media_type || 'media') + ']';\n"
            "    messageText = msg.message\n"
            "      ? mediaLabel + ' Caption: ' + msg.message + '\\r\\nLink: ' + msg.media_url\n"
            "      : mediaLabel + ' Link: ' + msg.media_url;\n"
            "  } else {\n"
            "    messageText = msg.message || '[No text content]';\n"
            "  }\n\n"
            "  transcript += '[' + messageTime + '] ';\n"
            "  transcript += senderName + ':\\r\\n';\n"
            "  transcript += messageText + '\\r\\n\\r\\n';\n"
            "}\n\n"
            "const safeName = sanitizeFilename(customerName);\n"
            "const safePhone = sanitizeFilename(phone);\n"
            "const exportDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }).replace(/-/g, '');\n"
            "const fileName = safeName + '_' + safePhone + '_chat_' + exportDate + '.txt';\n\n"
            "return [{\n"
            "  json: {\n"
            "    success: true,\n"
            "    conversation_id: conversationId,\n"
            "    customer_name: customerName,\n"
            "    phone: phone,\n"
            "    file_name: fileName,\n"
            "    message_count: rows.length\n"
            "  },\n"
            "  binary: {\n"
            "    data: {\n"
            "      data: Buffer.from(transcript, 'utf8').toString('base64'),\n"
            "      mimeType: 'text/plain; charset=utf-8',\n"
            "      fileExtension: 'txt',\n"
            "      fileName: fileName\n"
            "    }\n"
            "  }\n"
            "}];")
        print('[OK] Build Text Transcript - media URL added')

body = {
    'name': wf['name'],
    'nodes': nodes,
    'connections': wf['connections'],
    'settings': {'executionOrder': 'v1'},
    'staticData': None
}

with open(r'C:\Users\devin\Documents\claude-projects\speedbot_web\n8n\export-indiv-put.json', 'w', encoding='utf-8') as f:
    json.dump(body, f, ensure_ascii=False)

print('[OK] export-indiv-put.json written')

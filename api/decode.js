const DEFAULT_API_URL = 'https://api.siliconflow.cn/v1';
const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V3';

function extractSection(text, label) {
  const pattern = new RegExp(`\\[${label}\\]:\\s*([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]:|$)`);
  const match = text.match(pattern);
  return match ? match[1].trim() : '';
}

function cleanUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const text = String(body.text || '').trim();

    if (!text) {
      return res.status(400).json({ error: 'Missing text' });
    }

    const apiUrl = cleanUrl(body.apiUrl || process.env.SILICONFLOW_API_URL || DEFAULT_API_URL);
    const model = String(body.model || process.env.SILICONFLOW_MODEL || DEFAULT_MODEL).trim();
    const apiKey = String(body.apiKey || process.env.SILICONFLOW_API_KEY || '').trim();

    if (!apiKey) {
      return res.status(500).json({
        error: 'Missing API key',
        hint: 'Set SILICONFLOW_API_KEY in Vercel env vars, or pass apiKey for local testing.'
      });
    }

    const response = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        messages: [
          {
            role: 'system',
            content: `你是一个顶级职场生存解密AI。你的任务是帮用户翻译职场伪装信号，并生成反击策略。
请严格按照以下格式输出，不要有任何多余的客套话或引导语：
[真相]: 换成最直白、赤裸裸的利益动机或大白话。
[防御型回复]: 承认现状，但划清责任边界，开口要资源。
[穿透型回复]: 优雅地一针见血，跳过太极直接锁死核心目标。
[极简型回复]: 极其精炼，适合对付高管，多一个字都是浪费。
[反弹型回复]: 把锅或皮球反手扣回去，要求对方给出明确衡量标准。`
          },
          { role: 'user', content: text }
        ]
      })
    });

    const rawText = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Upstream request failed',
        details: rawText
      });
    }

    const data = JSON.parse(rawText);
    const content = data?.choices?.[0]?.message?.content?.trim() || '';

    const truth = extractSection(content, '真相') || content;
    const defensive = extractSection(content, '防御型回复');
    const penetrating = extractSection(content, '穿透型回复');
    const zen = extractSection(content, '极简型回复');
    const rebound = extractSection(content, '反弹型回复');

    return res.status(200).json({
      truth,
      defensive,
      penetrating,
      zen,
      rebound,
      raw: content,
      model
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Server error',
      details: error?.message || String(error)
    });
  }
};

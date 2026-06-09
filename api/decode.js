const DEFAULT_API_URL = 'https://api.siliconflow.cn/v1';
const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V3';

function cleanUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonObject(text) {
  const direct = safeJsonParse(text);
  if (direct) return direct;

  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;

  return safeJsonParse(match[0]);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeRisk(value, score) {
  const text = String(value || '').trim();
  if (['低', '中', '中高', '高'].includes(text)) return text;

  if (score >= 80) return '高';
  if (score >= 60) return '中高';
  if (score >= 35) return '中';
  return '低';
}

function normalizeAirState(value, score) {
  const text = String(value || '').trim();
  if (text) return text;

  if (score < 30) return '平静';
  if (score < 55) return '有点意思';
  if (score < 75) return '暗流涌动';
  return '谁碰谁死';
}

function normalizeString(value, fallback) {
  const text = String(value ?? fallback ?? '').trim();
  return text || String(fallback || '').trim();
}

function inferScoreFromRisk(risk) {
  switch (risk) {
    case '低':
      return 24;
    case '中':
      return 49;
    case '中高':
      return 68;
    case '高':
      return 87;
    default:
      return 49;
  }
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
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.5,
        messages: [
          {
            role: 'system',
            content: `你是“草台解码器”的核心引擎。你要把用户输入的职场话术、群聊内容、客户话术，翻译成年轻人能直接看懂、可以直接回复的结果。
只输出严格 JSON，不要 markdown，不要代码块，不要解释。
JSON 字段必须是：
{
  "surface": "一句话概括表面意思，20字以内",
  "subtext": "一句话点出潜台词，30字以内",
  "reply": "一句可直接发送的建议回复，30字以内",
  "risk": "低/中/中高/高",
  "airIndex": 0 到 100 的整数,
  "airState": "平静/有点意思/暗流涌动/谁碰谁死"
}
要求：
- surface 必须忠实，不要夸张。
- subtext 要点出真实意图，但不要失控。
- reply 要礼貌、简短、实用。
- risk 和 airIndex 要一致，空气越不对，数值越高。
- 如果信息不足，也要给出最可能的判断。`
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

    const data = safeJsonParse(rawText);
    const content = String(data?.choices?.[0]?.message?.content || '').trim();
    const parsed = extractJsonObject(content);

    if (!parsed) {
      const fallbackScore = inferScoreFromRisk('中');
      return res.status(200).json({
        surface: normalizeString(content || text, '未能解析表面意思'),
        subtext: '模型返回了非标准格式，但主链路已通。',
        reply: '我先按这个方向处理一下。',
        risk: '中',
        airIndex: fallbackScore,
        airState: normalizeAirState('', fallbackScore),
        raw: content || rawText,
        model
      });
    }

    const risk = normalizeRisk(parsed.risk, Number(parsed.airIndex));
    const score = clamp(
      Number.isFinite(Number(parsed.airIndex)) ? Math.round(Number(parsed.airIndex)) : inferScoreFromRisk(risk),
      0,
      100
    );

    return res.status(200).json({
      surface: normalizeString(parsed.surface, normalizeString(text, '表面意思待生成')),
      subtext: normalizeString(parsed.subtext, '潜台词待生成'),
      reply: normalizeString(parsed.reply, '建议回复待生成'),
      risk,
      airIndex: score,
      airState: normalizeAirState(parsed.airState, score),
      raw: content || rawText,
      model
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Server error',
      details: error?.message || String(error)
    });
  }
};

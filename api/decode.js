const DEFAULT_API_URL = 'https://api.siliconflow.cn/v1';
const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V3.2';
const FALLBACK_MODELS = [
  'deepseek-ai/DeepSeek-V3.2',
  'deepseek-ai/DeepSeek-V3.1-Terminus',
  'Qwen/Qwen2.5-7B-Instruct'
];

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

function uniqueModels(primary) {
  return [primary, ...FALLBACK_MODELS]
    .map((model) => String(model || '').trim())
    .filter(Boolean)
    .filter((model, index, models) => models.indexOf(model) === index);
}

function summarizeProviderError(status, text) {
  const parsed = safeJsonParse(text);
  const message =
    parsed?.message ||
    parsed?.error?.message ||
    parsed?.error ||
    parsed?.detail ||
    String(text || '').slice(0, 240);

  return {
    status,
    message: String(message || 'Unknown upstream error').slice(0, 240)
  };
}

function localDecode(text, reason) {
  const source = normalizeString(text, '这句话没有给出具体内容');
  const compact = source.replace(/\s+/g, '');
  let score = 38;
  let surface = '对方在表达一个不太明确的态度。';
  let subtext = '信息不够满，但这句话大概率是在给自己留余地。';
  let reply = '我理解，我先确认一下边界和下一步。';

  const rules = [
    {
      test: /原则上|理论上|按理说|正常来说/,
      score: 18,
      surface: '对方没有把话说死。',
      subtext: '真实态度偏拒绝，但还想保留体面空间。',
      reply: '明白，那我先确认可行边界和替代方案。'
    },
    {
      test: /不行|不方便|不太合适|不建议|不能|不想/,
      score: 22,
      surface: '对方倾向于拒绝。',
      subtext: '这不是单纯讨论方案，而是在给你降预期。',
      reply: '收到，我先按不可行处理，同时补一个备选方案。'
    },
    {
      test: /推进|跟进|拉通|对齐|闭环|落地/,
      score: 14,
      surface: '对方希望你继续往前推。',
      subtext: '事情还没完全清楚，但责任已经开始往你这边移动。',
      reply: '可以，我先拉一下关键节点和负责人。'
    },
    {
      test: /辛苦|麻烦|支持一下|帮忙|协助/,
      score: 12,
      surface: '对方在客气地分配任务。',
      subtext: '礼貌是真的，活也是真的，大概率还不会少。',
      reply: '可以，我先看下优先级和交付时间。'
    },
    {
      test: /尽快|今天|马上|立刻|下班前|抓紧/,
      score: 18,
      surface: '对方在催进度。',
      subtext: '时间压力已经传过来了，后面可能会追责。',
      reply: '我先处理优先项，预计时间我稍后同步。'
    },
    {
      test: /你自己把握|看着办|灵活处理|自行判断/,
      score: 20,
      surface: '对方把判断权交给你。',
      subtext: '听起来给空间，实际上也把风险一起给了你。',
      reply: '可以，我按这个方向走，关键决策点会提前同步。'
    },
    {
      test: /老板|领导|客户|上面|总部/,
      score: 12,
      surface: '这句话背后有更高层压力。',
      subtext: '对方可能不是在和你商量，而是在传递上游压力。',
      reply: '收到，我先按优先事项处理，并同步风险点。'
    }
  ];

  for (const rule of rules) {
    if (rule.test.test(compact)) {
      score += rule.score;
      surface = rule.surface;
      subtext = rule.subtext;
      reply = rule.reply;
    }
  }

  score = clamp(score, 18, 92);
  const risk = normalizeRisk('', score);

  return {
    surface,
    subtext,
    reply,
    risk,
    airIndex: score,
    airState: normalizeAirState('', score),
    raw: source,
    mode: 'local',
    fallback: true,
    fallbackReason: reason || 'AI upstream unavailable'
  };
}

async function requestSiliconFlow({ apiUrl, apiKey, model, text }) {
  return fetch(`${apiUrl}/chat/completions`, {
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
      return res.status(200).json(localDecode(text, 'Missing API key'));
    }

    const providerErrors = [];
    let response;
    let rawText;
    let activeModel;

    for (const candidate of uniqueModels(model)) {
      activeModel = candidate;
      response = await requestSiliconFlow({ apiUrl, apiKey, model: candidate, text });
      rawText = await response.text();

      if (response.ok) {
        break;
      }

      providerErrors.push({
        model: candidate,
        ...summarizeProviderError(response.status, rawText)
      });
    }

    if (!response?.ok) {
      return res.status(200).json({
        ...localDecode(text, providerErrors[0]?.message || 'All AI models unavailable'),
        providerErrors
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
        mode: 'ai',
        fallback: false,
        model: activeModel
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
      mode: 'ai',
      fallback: false,
      model: activeModel
    });
  } catch (error) {
    return res.status(200).json(localDecode('', error?.message || String(error)));
  }
};
